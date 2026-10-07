"""
Rohstoff-Preis-MCP-Server (Spot & Call-Offs)
============================================

Robuster MCP-Server zur Abfrage von Rohstoffpreisen über mehrere
Datenquellen mit automatischem Fallback, Retry-Logik, Caching und
einer zuverlässigen Wechselkurs-API.

Datenquellen-Kette (Fallback):
    1. yfinance (Primärquelle, Live-Futures)
    2. World Bank Pink Sheet (Sekundär, monatliche Referenzpreise)
    3. Omkar Cloud Commodity Price API (Tertiär, Echtzeit-Futures)
    4. OilPriceAPI (Tertiär, Energiepreise)
    5. EIA API (Tertiär, US-Energiedaten)

Wechselkurse:
    - Frankfurter API (EZB-basiert, kein API-Key nötig)

Umgebungsvariablen (optional, für Tertiärquellen):
    OMKAR_API_KEY   - API-Key für Omkar Cloud
    OILPRICE_API_KEY - API-Key für OilPriceAPI
    EIA_API_KEY     - API-Key für EIA
"""

import os
import logging
from datetime import datetime, timedelta
from typing import Optional

import requests
import yfinance as yf
from cachetools import TTLCache
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)
from mcp.server.mcpserver import MCPServer

# ==============================================================================
# LOGGING
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rohstoff-mcp")

# ==============================================================================
# MCP SERVER INSTANZ
# ==============================================================================
# HOST muss 0.0.0.0 sein, damit der Server aus anderen Containern
# (z.B. Langflow) erreichbar ist — 127.0.0.1 wäre nur containerintern.
_HOST = os.getenv("HOST", "0.0.0.0")
_PORT = int(os.getenv("PORT", "8080"))

mcp = MCPServer("Rohstoff-Preise")

# ==============================================================================
# CACHES
# ==============================================================================
# Spot-Preise: 60 Sekunden TTL
_spot_cache: TTLCache = TTLCache(maxsize=100, ttl=60)

# Wechselkurse: 300 Sekunden TTL (5 Minuten)
_fx_cache: TTLCache = TTLCache(maxsize=50, ttl=300)

# Historische Daten: 3600 Sekunden TTL (1 Stunde)
_hist_cache: TTLCache = TTLCache(maxsize=200, ttl=3600)

# ==============================================================================
# ROHSTOFF-MAPPINGS
# ==============================================================================
# Mapping von Benutzereingabe -> yfinance Ticker-Symbol
COMMODITY_MAP = {
    # Metalle
    "aluminium": "ALI=F",
    "aluminum": "ALI=F",
    "alu": "ALI=F",
    "kupfer": "HG=F",
    "copper": "HG=F",
    "stahl": "HRC=F",
    "steel": "HRC=F",
    "gold": "GC=F",
    "silber": "SI=F",
    "silver": "SI=F",
    "platin": "PL=F",
    "platinum": "PL=F",
    # Energie
    "rohoel": "CL=F",
    "crude": "CL=F",
    "wti": "CL=F",
    "brent": "BZ=F",
    "erdgas": "NG=F",
    "natural_gas": "NG=F",
    "gas": "NG=F",
}

# Mapping auf World-Bank-Rohstoffnamen (für Fallback 2)
WB_COMMODITY_MAP = {
    "aluminium": "Aluminum",
    "aluminum": "Aluminum",
    "alu": "Aluminum",
    "kupfer": "Copper",
    "copper": "Copper",
    "stahl": "Steel",
    "steel": "Steel",
    "gold": "Gold",
    "silber": "Silver",
    "silver": "Silver",
    "platin": "Platinum",
    "platinum": "Platinum",
    "rohoel": "Crude oil, average",
    "crude": "Crude oil, average",
    "wti": "Crude oil, WTI",
    "brent": "Crude oil, Brent",
    "erdgas": "Natural gas, US",
    "natural_gas": "Natural gas, US",
    "gas": "Natural gas, US",
}

# Mapping auf Omkar Cloud API-Namen (für Fallback 3)
OMKAR_COMMODITY_MAP = {
    "aluminium": "aluminum",
    "aluminum": "aluminum",
    "alu": "aluminum",
    "kupfer": "copper",
    "copper": "copper",
    "gold": "gold",
    "silber": "silver",
    "silver": "silver",
    "platin": "platinum",
    "platinum": "platinum",
    "rohoel": "crude_oil",
    "crude": "crude_oil",
    "wti": "crude_oil",
    "brent": "brent_crude_oil",
    "erdgas": "natural_gas",
    "natural_gas": "natural_gas",
    "gas": "natural_gas",
}

# Mapping auf OilPriceAPI-Codes (für Fallback 4)
OILPRICE_COMMODITY_MAP = {
    "rohoel": "WTI_USD",
    "crude": "WTI_USD",
    "wti": "WTI_USD",
    "brent": "BRENT_USD",
    "erdgas": "NATURAL_GAS_USD",
    "natural_gas": "NATURAL_GAS_USD",
    "gas": "NATURAL_GAS_USD",
}

# ==============================================================================
# HILFSFUNKTIONEN: RETRY
# ==============================================================================
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type((ConnectionError, TimeoutError, OSError)),
    reraise=True,
)
def _request_with_retry(url: str, **kwargs) -> requests.Response:
    """Führt eine HTTP-Anfrage mit Retry-Logik aus."""
    resp = requests.get(url, timeout=10, **kwargs)
    resp.raise_for_status()
    return resp


# ==============================================================================
# WECHSELKURSE: FRANKFURTER API (EZB-basiert, kein API-Key)
# ==============================================================================
def fetch_live_eur_usd_rate() -> float:
    """
    Holt den tagesaktuellen EUR/USD-Wechselkurs über die Frankfurter API.
    Die API wird von der Europäischen Zentralbank (EZB) gespeist und ist
    deutlich zuverlässiger als yfinance.
    """
    cache_key = "eur_usd_live"
    if cache_key in _fx_cache:
        return _fx_cache[cache_key]

    try:
        resp = _request_with_retry("https://api.frankfurter.dev/v2/rate/eur/usd")
        data = resp.json()
        rate = float(data["rate"])
        if rate > 0:
            _fx_cache[cache_key] = rate
            return rate
    except Exception as e:
        logger.warning("Frankfurter API (live) fehlgeschlagen: %s", e)

    # Fallback: yfinance als allerletzte Option
    try:
        ticker = yf.Ticker("EURUSD=X")
        rate = getattr(ticker.fast_info, "last_price", None)
        if rate and float(rate) > 0:
            _fx_cache[cache_key] = float(rate)
            return float(rate)
    except Exception as e:
        logger.warning("yfinance EUR/USD fehlgeschlagen: %s", e)

    raise ValueError(
        "Der tagesaktuelle EUR/USD-Wechselkurs konnte nicht ermittelt werden."
    )


def fetch_historical_eur_usd_rate(stichtag_str: str) -> float:
    """
    Holt den historischen EUR/USD-Wechselkurs für ein bestimmtes Datum
    (YYYY-MM-DD) über die Frankfurter API.
    Falls der Tag ein Wochenende/Feiertag war, wird der letzte verfügbare
    Handelskurs genommen.
    """
    cache_key = f"eur_usd_hist_{stichtag_str}"
    if cache_key in _fx_cache:
        return _fx_cache[cache_key]

    try:
        dt = datetime.strptime(stichtag_str.strip(), "%Y-%m-%d")
        # Frankfurter API: /v2/rate/{base}/{quote}?date=YYYY-MM-DD
        url = f"https://api.frankfurter.dev/v2/rate/eur/usd?date={dt.strftime('%Y-%m-%d')}"
        resp = _request_with_retry(url)
        data = resp.json()
        rate = float(data["rate"])
        if rate > 0:
            _fx_cache[cache_key] = rate
            return rate
    except Exception as e:
        logger.warning(
            "Frankfurter API (historisch %s) fehlgeschlagen: %s", stichtag_str, e
        )

    # Fallback: Live-Kurs verwenden
    try:
        return fetch_live_eur_usd_rate()
    except ValueError:
        raise ValueError(
            f"Der EUR/USD-Wechselkurs für {stichtag_str} konnte nicht ermittelt werden."
        )


# ==============================================================================
# PREISABFRAGE: FALLBACK-KETTE
# ==============================================================================
def _fetch_spot_from_yfinance(ticker_symbol: str) -> Optional[dict]:
    """Fallback 1: yfinance (Primärquelle)."""
    try:
        ticker = yf.Ticker(ticker_symbol)
        info = ticker.fast_info
        raw_price = getattr(info, "last_price", None)
        currency = getattr(info, "currency", "USD")

        if raw_price is not None and float(raw_price) > 0:
            return {
                "price": float(raw_price),
                "currency": currency,
                "source": "yfinance",
            }
    except Exception as e:
        logger.debug("yfinance fehlgeschlagen für %s: %s", ticker_symbol, e)
    return None


def _fetch_spot_from_worldbank(commodity_key: str) -> Optional[dict]:
    """
    Fallback 2: World Bank Pink Sheet (monatliche Referenzpreise).
    Verwendet die worldbank-commodities Bibliothek.
    """
    try:
        from worldbank_commodities import Client as WBClient

        wb_name = WB_COMMODITY_MAP.get(commodity_key)
        if not wb_name:
            return None

        client = WBClient()
        # Aktuellsten verfügbaren Monatspreis abrufen
        data = client.get_prices(commodities=[wb_name])
        if data is not None and not data.empty:
            # Letzten verfügbaren Preis nehmen
            latest = data.iloc[-1]
            price = float(latest["price"])
            if price > 0:
                return {
                    "price": price,
                    "currency": "USD",
                    "source": "worldbank",
                    "note": "Monatlicher Referenzpreis (World Bank Pink Sheet)",
                }
    except ImportError:
        logger.debug("worldbank-commodities nicht installiert")
    except Exception as e:
        logger.debug("World Bank fehlgeschlagen für %s: %s", commodity_key, e)
    return None


def _fetch_spot_from_omkar(commodity_key: str) -> Optional[dict]:
    """Fallback 3: Omkar Cloud Commodity Price API."""
    api_key = os.getenv("OMKAR_API_KEY")
    if not api_key:
        return None

    omkar_name = OMKAR_COMMODITY_MAP.get(commodity_key)
    if not omkar_name:
        return None

    try:
        url = "https://commodity-price-api.omkar.cloud/commodity-price"
        resp = _request_with_retry(
            url,
            params={"name": omkar_name},
            headers={"API-Key": api_key},
        )
        data = resp.json()
        price = float(data.get("price_usd", 0))
        if price > 0:
            return {
                "price": price,
                "currency": "USD",
                "source": "omkar",
                "note": f"Exchange: {data.get('exchange', 'N/A')}",
            }
    except Exception as e:
        logger.debug("Omkar API fehlgeschlagen für %s: %s", commodity_key, e)
    return None


def _fetch_spot_from_oilprice(commodity_key: str) -> Optional[dict]:
    """Fallback 4: OilPriceAPI (Energiepreise)."""
    api_key = os.getenv("OILPRICE_API_KEY")
    if not api_key:
        return None

    oil_code = OILPRICE_COMMODITY_MAP.get(commodity_key)
    if not oil_code:
        return None

    try:
        url = "https://api.oilpriceapi.com/v1/prices/latest"
        resp = _request_with_retry(
            url,
            params={"code": oil_code},
            headers={"Authorization": f"Token {api_key}"},
        )
        data = resp.json()
        # Antwortstruktur: {"status": "success", "data": {"price": ...}}
        price = float(data.get("data", {}).get("price", 0))
        if price > 0:
            return {
                "price": price,
                "currency": "USD",
                "source": "oilpriceapi",
            }
    except Exception as e:
        logger.debug("OilPriceAPI fehlgeschlagen für %s: %s", commodity_key, e)
    return None


def _fetch_spot_from_eia(commodity_key: str) -> Optional[dict]:
    """Fallback 5: EIA API (US-Energiedaten)."""
    api_key = os.getenv("EIA_API_KEY")
    if not api_key:
        return None

    # Nur für Erdgas sinnvoll
    if commodity_key not in ("erdgas", "natural_gas", "gas", "rohoel", "crude", "wti"):
        return None

    try:
        from myeia import API as EIA_API

        eia = EIA_API()
        if commodity_key in ("erdgas", "natural_gas", "gas"):
            df = eia.get_series_via_route(
                route="natural-gas/pri/fut",
                series="RNGC1",
                frequency="daily",
            )
        else:
            df = eia.get_series_via_route(
                route="petroleum/pri/fut",
                series="RCLC1",
                frequency="daily",
            )
        if df is not None and not df.empty:
            price = float(df.iloc[-1].iloc[0])
            if price > 0:
                return {
                    "price": price,
                    "currency": "USD",
                    "source": "eia",
                    "note": "EIA Futures Contract 1",
                }
    except ImportError:
        logger.debug("myeia nicht installiert")
    except Exception as e:
        logger.debug("EIA API fehlgeschlagen für %s: %s", commodity_key, e)
    return None


def _fetch_spot_price(commodity_key: str) -> Optional[dict]:
    """
    Durchläuft die Fallback-Kette und gibt das erste erfolgreiche
    Ergebnis zurück. Nutzt den Spot-Cache.
    """
    cache_key = f"spot_{commodity_key}"
    if cache_key in _spot_cache:
        return _spot_cache[cache_key]

    ticker_symbol = COMMODITY_MAP.get(commodity_key, commodity_key.upper())

    # Fallback-Kette in Prioritätsreihenfolge
    sources = [
        lambda: _fetch_spot_from_yfinance(ticker_symbol),
        lambda: _fetch_spot_from_worldbank(commodity_key),
        lambda: _fetch_spot_from_omkar(commodity_key),
        lambda: _fetch_spot_from_oilprice(commodity_key),
        lambda: _fetch_spot_from_eia(commodity_key),
    ]

    for source_fn in sources:
        result = source_fn()
        if result is not None:
            _spot_cache[cache_key] = result
            return result

    return None


def _fetch_historical_price(
    commodity_key: str, stichtag_str: str
) -> Optional[dict]:
    """
    Holt den historischen Preis für einen Stichtag.
    Primär über yfinance; bei Ausfall World Bank.
    """
    cache_key = f"hist_{commodity_key}_{stichtag_str}"
    if cache_key in _hist_cache:
        return _hist_cache[cache_key]

    ticker_symbol = COMMODITY_MAP.get(commodity_key, commodity_key.upper())

    # Fallback 1: yfinance historisch
    try:
        dt = datetime.strptime(stichtag_str.strip(), "%Y-%m-%d")
        end_dt = dt + timedelta(days=5)  # Zeitfenster für Wochenenden/Feiertage

        ticker = yf.Ticker(ticker_symbol)
        df = ticker.history(
            start=dt.strftime("%Y-%m-%d"),
            end=end_dt.strftime("%Y-%m-%d"),
        )

        if not df.empty and "Close" in df.columns:
            raw_price = float(df["Close"].iloc[0])
            if raw_price > 0:
                currency = getattr(ticker.fast_info, "currency", "USD")
                result = {
                    "price": raw_price,
                    "currency": currency,
                    "source": "yfinance",
                    "note": f"Handelstag: {df.index[0].strftime('%Y-%m-%d')}",
                }
                _hist_cache[cache_key] = result
                return result
    except Exception as e:
        logger.debug(
            "yfinance historisch fehlgeschlagen für %s am %s: %s",
            commodity_key, stichtag_str, e,
        )

    # Fallback 2: World Bank (monatlicher Preis, wenn yfinance versagt)
    try:
        from worldbank_commodities import Client as WBClient

        wb_name = WB_COMMODITY_MAP.get(commodity_key)
        if wb_name:
            client = WBClient()
            # Monat aus dem Stichtag ableiten
            dt = datetime.strptime(stichtag_str.strip(), "%Y-%m-%d")
            start_month = dt.strftime("%Y-%m")
            data = client.get_prices(
                commodities=[wb_name],
                start=start_month,
            )
            if data is not None and not data.empty:
                price = float(data.iloc[0]["price"])
                if price > 0:
                    result = {
                        "price": price,
                        "currency": "USD",
                        "source": "worldbank",
                        "note": f"Monatlicher Referenzpreis ({start_month})",
                    }
                    _hist_cache[cache_key] = result
                    return result
    except ImportError:
        logger.debug("worldbank-commodities nicht installiert")
    except Exception as e:
        logger.debug(
            "World Bank historisch fehlgeschlagen für %s: %s", commodity_key, e
        )

    return None


# ==============================================================================
# WÄHRUNGSUMRECHNUNG
# ==============================================================================
def _convert_to_eur_usd(
    raw_price: float, original_currency: str, eur_usd_rate: float
) -> tuple[float, float]:
    """
    Rechnet einen Rohpreis in EUR und USD um.
    Gibt (price_eur, price_usd) zurück.
    """
    cur = original_currency.upper()
    if cur == "USD":
        price_usd = round(raw_price, 2)
        price_eur = round(raw_price / eur_usd_rate, 2)
    elif cur == "EUR":
        price_eur = round(raw_price, 2)
        price_usd = round(raw_price * eur_usd_rate, 2)
    else:
        # Unbekannte Währung: behandle als USD
        price_usd = round(raw_price, 2)
        price_eur = round(raw_price / eur_usd_rate, 2)
    return price_eur, price_usd


# ==============================================================================
# TOOL 1: FESTPREISVERTRÄGE (SPOT / CURRENT PRICE)
# ==============================================================================
@mcp.tool()
def get_spot_commodity_price(rohstoff: str) -> dict:
    """
    Ruft den aktuellen Live-Spot-Marktpreis für Festpreisverträge ab.
    Berechnet die Werte basierend auf tagesaktuellen Börsen- und
    Wechselkursdaten. Nutzt eine Fallback-Kette über mehrere Datenquellen.
    """
    key = str(rohstoff).lower().strip()

    # Preis über Fallback-Kette ermitteln
    price_data = _fetch_spot_price(key)

    if price_data is None:
        return {
            "status": "error",
            "message": (
                f"Keine aktuellen Livekurse für '{rohstoff}' über "
                f"verfügbare Datenquellen ermittelbar. "
                f"Bitte prüfen Sie den Rohstoffnamen oder versuchen "
                f"Sie es später erneut."
            ),
        }

    raw_price = price_data["price"]
    currency = price_data["currency"]
    source = price_data["source"]

    # Wechselkurs ermitteln
    try:
        eur_usd_rate = fetch_live_eur_usd_rate()
    except ValueError as e:
        return {
            "status": "error",
            "message": f"Wechselkurs konnte nicht ermittelt werden: {e}",
        }

    price_eur, price_usd = _convert_to_eur_usd(raw_price, currency, eur_usd_rate)

    result = {
        "status": "success",
        "vertragstyp": "Festpreisvertrag (Spot)",
        "commodity": rohstoff.capitalize(),
        "ticker": COMMODITY_MAP.get(key, rohstoff.upper()),
        "price_eur": price_eur,
        "price_usd": price_usd,
        "currency": "EUR",
        "original_currency": currency,
        "exchange_rate_eur_usd": round(eur_usd_rate, 4),
        "abfrage_zeitpunkt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "datenquelle": source,
    }

    # Zusätzliche Notiz von der Quelle übernehmen
    if "note" in price_data:
        result["hinweis"] = price_data["note"]

    # TTL-Hinweis für MCP-Caching
    result["ttlMs"] = 60000  # 60 Sekunden

    return result


# ==============================================================================
# TOOL 2: CALL-OFFS / LTA-EINZELABRUFE (HISTORISCHER STICHTAGSPREIS)
# ==============================================================================
@mcp.tool()
def get_calloff_commodity_price(rohstoff: str, stichtag: str) -> dict:
    """
    Ruft den Börsenmarktpreis für einen LTA Call-Off zu einem spezifischen
    Stichtag (Format: YYYY-MM-DD) ab. Verwendet historische Börsen- und
    Wechselkursdaten des Stichtags mit Fallback über World Bank.
    """
    key = str(rohstoff).lower().strip()

    # Datumsformat validieren
    try:
        datetime.strptime(stichtag.strip(), "%Y-%m-%d")
    except ValueError:
        return {
            "status": "error",
            "message": (
                f"Ungültiges Datumsformat '{stichtag}'. "
                f"Bitte verwende das Format YYYY-MM-DD (z.B. 2024-05-15)."
            ),
        }

    # Historischen Preis über Fallback-Kette ermitteln
    price_data = _fetch_historical_price(key, stichtag)

    if price_data is None:
        return {
            "status": "error",
            "message": (
                f"Keine historischen Kursdaten für '{rohstoff}' "
                f"am Stichtag {stichtag} über verfügbare Datenquellen "
                f"gefunden."
            ),
        }

    raw_price = price_data["price"]
    currency = price_data["currency"]
    source = price_data["source"]

    # Stichtags-Wechselkurs ermitteln
    try:
        eur_usd_rate = fetch_historical_eur_usd_rate(stichtag)
    except ValueError as e:
        return {
            "status": "error",
            "message": f"Wechselkurs für Stichtag konnte nicht ermittelt werden: {e}",
        }

    price_eur, price_usd = _convert_to_eur_usd(raw_price, currency, eur_usd_rate)

    result = {
        "status": "success",
        "vertragstyp": "LTA Call-Off",
        "stichtag": stichtag,
        "commodity": rohstoff.capitalize(),
        "ticker": COMMODITY_MAP.get(key, rohstoff.upper()),
        "price_eur": price_eur,
        "price_usd": price_usd,
        "currency": "EUR",
        "original_currency": currency,
        "exchange_rate_eur_usd": round(eur_usd_rate, 4),
        "abfrage_zeitpunkt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "datenquelle": source,
    }

    # Zusätzliche Notiz von der Quelle übernehmen
    if "note" in price_data:
        result["hinweis"] = price_data["note"]

    # TTL-Hinweis für MCP-Caching (historische Daten ändern sich nicht)
    result["ttlMs"] = 3600000  # 1 Stunde

    return result


# ==============================================================================
# SERVER-START
# ==============================================================================
if __name__ == "__main__":
    logger.info(
        "Starte Rohstoff-MCP-Server (Spot & Call-Offs) auf http://%s:%s/mcp ...",
        _HOST, _PORT,
    )
    # streamable-http, nicht sse: Langflows aktiver MCP-Baustein unterstützt
    # nur stdio und streamable HTTP — der SSE-Baustein ist deaktiviert.
    mcp.run(transport="streamable-http", host=_HOST, port=_PORT)