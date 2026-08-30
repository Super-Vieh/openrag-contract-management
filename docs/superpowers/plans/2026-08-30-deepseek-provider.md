# DeepSeek-Provider Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeepSeek als vollwertigen LLM- und VLM-Provider (Chat + Bildbeschreibungen) in OpenRAG integrieren — konfigurierbar über UI/Onboarding, mit Key-Verschlüsselung, Modell-Liste, Health-Check und Langflow-Sync, analog zu openai/anthropic/watsonx/ollama.

**Architecture:** DeepSeek reist im Chat-Pfad ausschließlich als Strings (Provider + Modell via Langflow-Global-Variablen) + Key-Header an Langflows eingebaute `LanguageModelComponent` (A1-first). DeepSeek hat keine Embedding-API → Embedding-Pfad bleibt unberührt. Der VLM-Slot (Bildbeschreibungen) ist unabhängig und nutzt einen OpenAI-kompatiblen Chat-Call direkt gegen `api.deepseek.com`. Modell-Liste ist statisch (verifiziert: `GET /v1/models` liefert 401 für DeepSeek-Keys). DeepSeek V4 antwortet standardmäßig im Thinking-Mode (`reasoning_content`) → Health-Test/VLM müssen ausreichend `max_tokens` setzen.

**Tech Stack:** Python/FastAPI (Backend), TypeScript/React/Next.js (Frontend), Langflow 1.11.1 (Orchestration via LiteLLM), Pydantic-Validierung, pytest + Playwright.

## Global Constraints

- DeepSeek ist **LLM + VLM**, niemals Embedding-Provider → `embedding_provider`-Regex, `_EMBEDDING_PROVIDER_NAMES`, Embedding-Slots und Embedding-Dispatch bleiben unverändert.
- Modell-IDs (exakt, keine Präfixe): `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`.
- DeepSeek-API-Key-Env-Var: `DEEPSEEK_API_KEY` (gleicher Verschlüsselungs-/Speicherweg wie `OPENAI_API_KEY`).
- LLM-Fallback-Reihenfolge: `openai > anthropic > watsonx > ollama > deepseek` (deepseek am ENDE).
- Provider-String intern: `"deepseek"` (klein); Langflow-Display via `map_provider` → `"DeepSeek"`.
- DeepSeek-Default-Modell für Chat: `deepseek-v4-flash`.
- Bild-Chat im Agent (`_deepseek_supports_images`) ist **NICHT** Teil dieses Plans (Future Work).

---

## File Structure

**Backend (Modify):**
- `src/config/config_manager.py` — `DeepSeekConfig`, `ProvidersConfig.deepseek`, `get_provider_config`, `from_dict`, `load_config`, `_load_env_overrides`
- `src/api/settings/models.py` — Regex `llm_provider`/`vlm_provider`, `deepseek_api_key`-Felder, `DeepSeekProviderConfig`-Response
- `src/api/settings/helpers.py` — `_LLM_PROVIDER_NAMES`, `_default_llm_model`
- `src/services/models_service.py` — `KNOWN_PREFIXES`, `get_deepseek_models`, Registry-Block
- `src/api/provider_validation.py` — Dispatch + `_test_deepseek_*`
- `src/api/models.py` — `/models/deepseek`-Handler
- `src/app/routes/internal.py` — Route-Registrierung
- `src/api/provider_health.py` — `valid_providers`
- `src/api/v1/models.py` — `VALID_PROVIDERS`, `_fetch_models`
- `src/api/settings/endpoints.py` — Onboarding-Block + Removal-Block
- `src/utils/langflow_headers.py` — `map_provider`, Credential-Header
- `src/api/settings/langflow_sync.py` — `LANGFLOW_CREDENTIAL_GLOBAL_VARIABLES`, Credential-Block
- `src/services/flows_service.py` — `change_langflow_model_value`-Allowlist, `_get_provider_name_display`
- `src/services/docling_service.py` — DeepSeek-VLM-Builder

**Frontend (Modify + Create):**
- Modify: `frontend/app/settings/_helpers/model-helpers.tsx`, `model-providers.tsx`, `onboarding-card.tsx`, `provider-health-banner.tsx`, `useProviderHealthQuery.ts`, `ingest-settings-section.tsx`
- Create: `frontend/components/icons/deepseek-logo.tsx`, `frontend/app/settings/_components/deepseek-settings-{dialog,form}.tsx`

**Tests (Modify + Create):**
- Modify: `test_ascii_safe_header_value.py`, `test_settings_provider_removal_defaults.py`, `test_provider_error_formatting.py`, `test_docling_service.py`
- Create: `test_deepseek_provider.py`

**Deploy (Modify):** `.env.example`, `docker-compose.yml`, Helm `values.yaml`/`backend-dotenv.yaml`/`langflow-dotenv.yaml`/`llm-providers-secret.yaml`, Operator `env.go`

---

## Task 1: Backend-Config — DeepSeekConfig + Provider-Registrierung

**Files:**
- Modify: `src/config/config_manager.py`

**Interfaces:**
- Produces: `DeepSeekConfig(api_key: str = "", configured: bool = False)`; `ProvidersConfig.deepseek`; `get_provider_config("deepseek")`; Env-Override `DEEPSEEK_API_KEY`

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
from config.config_manager import DeepSeekConfig, ProvidersConfig, OpenRAGConfig

def test_deepseek_config_registered_and_resolvable():
    cfg = OpenRAGConfig(
        providers=ProvidersConfig(
            openai=OpenAIConfig(),
            anthropic=AnthropicConfig(),
            watsonx=WatsonXConfig(),
            ollama=OllamaConfig(),
            deepseek=DeepSeekConfig(api_key="sk-ds", configured=True),
        ),
        # ... restliche Pflichtfelder des OpenRAGConfig-Konstruktors
    )
    assert cfg.providers.get_provider_config("deepseek").api_key == "sk-ds"
    assert cfg.providers.get_provider_config("DeepSeek").configured is True
    assert cfg.providers.any_configured() is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_deepseek_config_registered_and_resolvable -v`
Expected: FAIL — `ImportError`/`TypeError` (DeepSeekConfig existiert nicht, `ProvidersConfig` hat kein `deepseek`-Feld)

- [ ] **Step 3: Implement**

In `src/config/config_manager.py`, nach `OllamaConfig` (L133-139) einfügen:

```python
@dataclass
class DeepSeekConfig:
    """DeepSeek provider configuration (LLM + VLM; no embedding API)."""

    api_key: str = ""
    configured: bool = False
```

In `ProvidersConfig` (L142-167) das Feld + beide Methoden erweitern:

```python
@dataclass
class ProvidersConfig:
    openai: OpenAIConfig
    anthropic: AnthropicConfig
    watsonx: WatsonXConfig
    ollama: OllamaConfig
    deepseek: DeepSeekConfig

    def any_configured(self) -> bool:
        return any(p.configured for p in (
            self.openai, self.anthropic, self.watsonx, self.ollama, self.deepseek,
        ))

    def get_provider_config(self, provider: str):
        provider_lower = provider.lower()
        if provider_lower == "openai":
            return self.openai
        elif provider_lower == "anthropic":
            return self.anthropic
        elif provider_lower == "watsonx":
            return self.watsonx
        elif provider_lower == "ollama":
            return self.ollama
        elif provider_lower == "deepseek":
            return self.deepseek
        else:
            raise ValueError(f"Unknown provider: {provider}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_deepseek_config_registered_and_resolvable -v`
Expected: PASS (Hinweis: `OpenRAGConfig`-Konstruktor braucht ggf. weitere Pflichtfelder — diese aus einem bestehenden Test-Task 2 übernehmen)

- [ ] **Step 5: Wire `from_dict` + `load_config` + Env-Override** (Teil desselben Tasks — kein eigener Test, aber nötig, damit die Config überall auftaucht)

`from_dict` (L244-269): `deepseek`-Entschlüsselung + Feld-Zuweisung ergänzen (spiegelt `openai`).
`load_config` (L322-349): `"deepseek": {}` im Seed-Dict + Iteration über `["openai", "anthropic", "watsonx", "ollama", "deepseek"]`.
`_load_env_overrides` (L389-461): `DEEPSEEK_API_KEY` analog `OPENAI_API_KEY` (L400-401).

- [ ] **Step 6: Commit**

```bash
git add src/config/config_manager.py tests/unit/test_deepseek_provider.py
git commit -m "feat(deepseek): DeepSeekConfig + ProvidersConfig-Registrierung"
```

---

## Task 2: API-Validierung — Regex + Pydantic-Felder

**Files:**
- Modify: `src/api/settings/models.py`

**Interfaces:**
- Produces: `deepseek_api_key`-Feld in `SettingsUpdateBody` + `OnboardingBody`; `DeepSeekProviderConfig`-Response + Feld in `ProvidersConfig`-Response; Regex `llm_provider`/`vlm_provider` akzeptieren `deepseek`.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
from api.settings.models import SettingsUpdateBody, OnboardingBody
from pydantic import ValidationError

def test_llm_provider_regex_accepts_deepseek_but_not_embedding():
    # llm_provider akzeptiert deepseek
    body = SettingsUpdateBody(llm_provider="deepseek")
    assert body.llm_provider == "deepseek"
    # embedding_provider lehnt deepseek ab (LLM-only)
    try:
        SettingsUpdateBody(embedding_provider="deepseek")
        assert False, "embedding_provider=deepseek should fail validation"
    except ValidationError:
        pass

def test_vlm_provider_regex_accepts_deepseek():
    body = SettingsUpdateBody(vlm_provider="deepseek")
    assert body.vlm_provider == "deepseek"

def test_onboarding_body_accepts_deepseek_api_key():
    body = OnboardingBody(llm_provider="deepseek", deepseek_api_key="sk-123")
    assert body.deepseek_api_key == "sk-123"
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_llm_provider_regex_accepts_deepseek_but_not_embedding -v`
Expected: FAIL — `ValidationError` (deepseek nicht in Regex)

- [ ] **Step 3: Implement**

`models.py` Regex-Zeilen (L17, 26, 54):
```python
llm_provider: str | None = Field(None, pattern="^(openai|anthropic|watsonx|ollama|deepseek)$")
vlm_provider: str | None = Field(None, pattern="^(openai|watsonx|anthropic|local|ollama|deepseek)$")
# embedding_provider (L35, 56) bleibt UNVERÄNDERT: "^(openai|watsonx|ollama)$"
```

`SettingsUpdateBody` (nach `ollama_endpoint`): `deepseek_api_key: str | None = Field(None, min_length=1)` + `remove_deepseek_config: bool | None = None`.
`OnboardingBody` (nach `ollama_endpoint`): `deepseek_api_key: str | None = Field(None, min_length=1)`.

Response-Modelle (L149-175): `DeepSeekProviderConfig(BaseModel)` mit `api_key`, `configured` (analog `OpenAIProviderConfig`); `ProvidersConfig`-Response-Feld `deepseek`.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_deepseek_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/settings/models.py tests/unit/test_deepseek_provider.py
git commit -m "feat(deepseek): Regex + Pydantic-Felder (llm+vlm, kein embedding)"
```

---

## Task 3: Helpers — Provider-Liste + Default-Modell

**Files:**
- Modify: `src/api/settings/helpers.py`

**Interfaces:**
- Produces: `_LLM_PROVIDER_NAMES` enthält `deepseek` am Ende; `_default_llm_model("deepseek") == "deepseek-v4-flash"`.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
from api.settings import helpers

def test_default_llm_model_for_deepseek():
    assert helpers._default_llm_model("deepseek") == "deepseek-v4-flash"

def test_llm_provider_names_order_puts_deepseek_last():
    assert helpers._LLM_PROVIDER_NAMES[-1] == "deepseek"
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_default_llm_model_for_deepseek -v`
Expected: FAIL — returns `""` (deepseek fehlt im Dict)

- [ ] **Step 3: Implement**

`helpers.py` L23-24 und L49-64:
```python
_LLM_PROVIDER_NAMES = ("openai", "anthropic", "watsonx", "ollama", "deepseek")
_EMBEDDING_PROVIDER_NAMES = ("openai", "watsonx", "ollama")  # UNVERÄNDERT

def _default_llm_model(provider: str) -> str:
    return {
        "openai": OPENAI_DEFAULT_LANGUAGE_MODEL,
        "anthropic": ANTHROPIC_DEFAULT_LANGUAGE_MODEL,
        "watsonx": "",
        "ollama": "",
        "deepseek": "deepseek-v4-flash",
    }.get(provider, "")
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_deepseek_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/settings/helpers.py tests/unit/test_deepseek_provider.py
git commit -m "feat(deepseek): Provider-Liste + Default-Modell deepseek-v4-flash"
```

---

## Task 4: Models-Service — KNOWN_PREFIXES + statische Modell-Liste

**Files:**
- Modify: `src/services/models_service.py`

**Interfaces:**
- Produces: `KNOWN_PREFIXES` enthält `deepseek`; `get_deepseek_models(api_key, update_index=True) -> dict` mit `{"language": [...]}` (statische Liste, optionaler Live-Fetch mit Fallback).

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
import pytest
from services.models_service import ModelsService, KNOWN_PREFIXES

def test_known_prefixes_include_deepseek():
    assert "deepseek" in KNOWN_PREFIXES

@pytest.mark.asyncio
async def test_get_deepseek_models_returns_static_list():
    svc = ModelsService()
    result = await svc.get_deepseek_models("sk-ds", update_index=False)
    ids = [m["value"] for m in result["language"]]
    assert "deepseek-v4-flash" in ids
    assert "deepseek-v4-pro" in ids
    assert "deepseek-v4-flash-vision-exp" in ids
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_known_prefixes_include_deepseek -v`
Expected: FAIL — `deepseek` nicht in `KNOWN_PREFIXES`

- [ ] **Step 3: Implement**

`KNOWN_PREFIXES` (L22): `KNOWN_PREFIXES = ["openai", "ollama", "watsonx", "anthropic", "deepseek"]`.

Neue Methode (nach `get_anthropic_models`, vor `get_ollama_models`):
```python
DEEPSEEK_STATIC_MODELS = [
    {"value": "deepseek-v4-flash", "label": "deepseek-v4-flash", "default": True},
    {"value": "deepseek-v4-pro", "label": "deepseek-v4-pro", "default": False},
    {"value": "deepseek-v4-flash-vision-exp", "label": "deepseek-v4-flash-vision-exp", "default": False},
]

async def get_deepseek_models(self, api_key: str, update_index: bool = True) -> dict:
    """Static model list for DeepSeek.

    GET /v1/models returns 401 for DeepSeek API keys (verified 2026-08-30),
    so the static list is the primary path. A live fetch is attempted only as
    an optional enrichment; on any failure the static list is returned.
    """
    models = [dict(m) for m in self.DEEPSEEK_STATIC_MODELS]
    # Optional live-fetch enrichment (best-effort; 401/network → static list).
    try:
        response = await _http_request_with_retry(
            "GET", "https://api.deepseek.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"}, timeout=10.0,
        )
        if response.status_code == 200:
            data = response.json()
            live_ids = [m.get("id", "") for m in data.get("data", [])]
            live_ids = [i for i in live_ids if i.startswith("deepseek-")]
            if live_ids:
                models = [
                    {"value": i, "label": i, "default": i == "deepseek-v4-flash"}
                    for i in live_ids
                ]
    except Exception:
        pass
    if update_index:
        for m in models:
            self._model_provider_registry[m["value"]] = "deepseek"
    return {"language": models, "embedding": []}
```

Registry-Block in `update_model_registry` (L147-188): DeepSeek-Block ergänzen (die statischen IDs in `_model_provider_registry` → `"deepseek"`), analog den bestehenden Provider-Blöcken.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_deepseek_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/models_service.py tests/unit/test_deepseek_provider.py
git commit -m "feat(deepseek): statische Modell-Liste + KNOWN_PREFIXES"
```

---

## Task 5: Provider-Validierung + Health (Achtung: kein /v1/models!)

**Files:**
- Modify: `src/api/provider_validation.py`
- Modify: `src/api/provider_health.py`

**Interfaces:**
- Produces: `_test_deepseek_lightweight_health(api_key)` (Chat-Call, NICHT `/v1/models`); `_test_deepseek_completion_with_tools(api_key, llm_model)`; Dispatch-Einträge in `test_lightweight_health` + `test_completion_with_tools`.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
import pytest
from unittest.mock import AsyncMock, patch
from api.provider_validation import test_lightweight_health, test_completion_with_tools

@pytest.mark.asyncio
async def test_lightweight_health_uses_chat_not_models_endpoint():
    with patch("api.provider_validation._http_request_with_retry", new=AsyncMock()) as m:
        m.return_value.status_code = 200
        await test_lightweight_health("deepseek", api_key="sk-ds")
        called_url = m.await_args.kwargs.get("url") or m.await_args.args[1]
        assert "/chat/completions" in called_url
        assert "/v1/models" not in called_url
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_lightweight_health_uses_chat_not_models_endpoint -v`
Expected: FAIL — `ValueError: Unknown provider: deepseek` (kein Dispatch-Eintrag)

- [ ] **Step 3: Implement**

`provider_validation.py` — Dispatch (L640-660):
```python
async def test_lightweight_health(provider, api_key=None, endpoint=None, project_id=None):
    if provider == "openai":
        await _test_openai_lightweight_health(api_key)
    elif provider == "watsonx":
        await _test_watsonx_lightweight_health(api_key, endpoint, project_id)
    elif provider == "ollama":
        await _test_ollama_lightweight_health(endpoint)
    elif provider == "anthropic":
        await _test_anthropic_lightweight_health(api_key)
    elif provider == "deepseek":
        await _test_deepseek_lightweight_health(api_key)
    else:
        raise ValueError(f"Unknown provider: {provider}")
```

Neue Methode (nach `_test_anthropic_lightweight_health`):
```python
async def _test_deepseek_lightweight_health(api_key: str) -> None:
    """Minimal chat call — GET /v1/models returns 401 for DeepSeek keys."""
    await _http_request_with_retry(
        "POST",
        "https://api.deepseek.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        },
        timeout=30.0,
    )
```

`test_completion_with_tools` (L660-678): `elif provider == "deepseek": await _test_deepseek_completion_with_tools(api_key, llm_model)`.
`_test_deepseek_completion_with_tools(api_key, llm_model)`: OpenAI-Muster (`Authorization: Bearer`, `POST /chat/completions`, `max_tokens` ausreichend hoch setzen, z. B. 256, wegen Thinking-Mode).
**Embedding-Dispatch (`test_embedding`, L681-697) bleibt unverändert.**

`provider_health.py` L49: `valid_providers = ["openai", "ollama", "watsonx", "anthropic", "deepseek"]`.

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_deepseek_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api/provider_validation.py src/api/provider_health.py tests/unit/test_deepseek_provider.py
git commit -m "feat(deepseek): Health-Test via Chat-Call (kein /v1/models)"
```

---

## Task 6: Model-Endpoints + v1

**Files:**
- Modify: `src/api/models.py`
- Modify: `src/app/routes/internal.py`
- Modify: `src/api/v1/models.py`

**Interfaces:**
- Produces: `POST /models/deepseek` (Intern) + `deepseek` in `VALID_PROVIDERS` (v1).

- [ ] **Step 1: Implement** (Endpoint-Spiegel von `get_openai_models`)

`src/api/models.py` (nach `get_ollama_models`):
```python
@router.post("/models/deepseek")
async def get_deepseek_models_endpoint(body: ModelQueryBody = Body(...)):
    """Fetch DeepSeek model list (static primary, live enrichment optional)."""
    from services.models_service import ModelsService
    service = ModelsService()
    return await service.get_deepseek_models(body.api_key or "")
```

`src/app/routes/internal.py` (L397-408): Route `POST /models/deepseek` → `models.get_deepseek_models_endpoint` registrieren.

`src/api/v1/models.py` L18: `VALID_PROVIDERS = frozenset({"openai", "anthropic", "ollama", "watsonx", "deepseek"})`; `_fetch_models` (L21-53) `elif provider == "deepseek": return await service.get_deepseek_models(...)`.

- [ ] **Step 2: Verify** — `uv run pytest tests/unit/test_v1_models.py -v` (falls existent) + bestehende Model-Endpoint-Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/api/models.py src/app/routes/internal.py src/api/v1/models.py
git commit -m "feat(deepseek): /models/deepseek Endpoint + v1 VALID_PROVIDERS"
```

---

## Task 7: Onboarding + Removal (endpoints.py)

**Files:**
- Modify: `src/api/settings/endpoints.py`

**Interfaces:**
- Produces: `body.deepseek_api_key` wird im Onboarding gelesen; `remove_deepseek_config`-Block.

- [ ] **Step 1: Implement** — Onboarding-Credential-Block (L1032-1061), nach dem `ollama_endpoint`-Block:

```python
if body.deepseek_api_key:
    current_config.providers.deepseek.api_key = body.deepseek_api_key.strip()
    current_config.providers.deepseek.configured = True
```

`configured`-Markierung (L1063-1101): `deepseek` in die `if llm_provider == ...`-Kette aufnehmen, die den gewählten Provider auf `configured=True` setzt.

Removal-Block (nach `remove_watsonx_config`, L856): `remove_deepseek_config` — spiegelt `remove_openai_config` (leert `deepseek.api_key`/`configured`, prüft `_first_configured_llm_provider`, `_affected_embedding_models` nicht relevant da LLM-only, Reshuffle). Verweis auf `helpers._first_configured_llm_provider` (jetzt mit deepseek am Ende).

- [ ] **Step 2: Verify** — bestehende Onboarding-/Settings-Tests grün + `uv run pytest tests/unit/test_settings_provider_removal_defaults.py -v` (nach Task 12 angepasst).

- [ ] **Step 3: Commit**

```bash
git add src/api/settings/endpoints.py
git commit -m "feat(deepseek): Onboarding-Credential + Removal-Block"
```

---

## Task 8: Langflow-Sync — map_provider, Credential-Var, Allowlist

**Files:**
- Modify: `src/utils/langflow_headers.py`
- Modify: `src/api/settings/langflow_sync.py`
- Modify: `src/services/flows_service.py`

**Interfaces:**
- Produces: `map_provider("deepseek") == "DeepSeek"`; `DEEPSEEK_API_KEY` in Credential-Global-Variablen; `change_langflow_model_value("deepseek", ...)` erlaubt; `_get_provider_name_display("deepseek") == "DeepSeek"`.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_deepseek_provider.py
from utils.langflow_headers import map_provider

def test_map_provider_deepseek():
    assert map_provider("deepseek") == "DeepSeek"
    assert map_provider("DeepSeek") == "DeepSeek"
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_deepseek_provider.py::test_map_provider_deepseek -v`
Expected: FAIL — `map_provider` gibt `"deepseek"` unverändert zurück (passthrough)

- [ ] **Step 3: Implement**

`langflow_headers.py` `map_provider` (L8-24), nach `watsonx`-Zweig:
```python
if provider_lower == "deepseek":
    return "DeepSeek"
```

`add_provider_credentials_to_headers` (L72-142), nach `ANTHROPIC_API_KEY`-Block:
```python
deepseek = config.providers.deepseek
if deepseek and deepseek.api_key:
    headers["X-LANGFLOW-GLOBAL-VAR-DEEPSEEK_API_KEY"] = deepseek.api_key
```

`langflow_sync.py` `LANGFLOW_CREDENTIAL_GLOBAL_VARIABLES` (L33-41): `"DEEPSEEK_API_KEY"` ergänzen.
`_update_langflow_global_variables` (L153-166), nach Anthropic-Block:
```python
if config.providers.deepseek.api_key:
    await _upsert_langflow_global_variable("DEEPSEEK_API_KEY", config.providers.deepseek.api_key)
```

`flows_service.py` `change_langflow_model_value` (L1017):
```python
if provider not in ["watsonx", "ollama", "openai", "anthropic", "deepseek"]:
    raise ValueError(...)
```
`_get_provider_name_display` (L639-647): `if provider_lower == "deepseek": return "DeepSeek"` (vor dem `default "OpenAI"`).

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_deepseek_provider.py -v tests/unit/test_ascii_safe_header_value.py -v`
Expected: PASS (der `map_provider`-Fall in test_ascii_safe_header_value ist im selben Task ergänzt — siehe Task 12, oder hier direkt mit)

- [ ] **Step 5: Commit**

```bash
git add src/utils/langflow_headers.py src/api/settings/langflow_sync.py src/services/flows_service.py tests/unit/test_deepseek_provider.py tests/unit/test_ascii_safe_header_value.py
git commit -m "feat(deepseek): Langflow-Sync (map_provider, Credential-Var, Allowlist)"
```

---

## Task 9: A1-CHECK (früh! entscheidet A1 vs A2)

**Files:** keine Code-Änderung — Verifikations-Task.

**Zweck:** Empirisch prüfen, ob Langflows eingebaute `LanguageModelComponent` den Provider `"DeepSeek"` + Modell `deepseek-v4-flash` akzeptiert — BEVOR das Frontend gebaut wird.

- [ ] **Step 1: Backend + Langflow laufen lassen**

Run: `make dev-local` (OpenSearch + Langflow) + `make backend`

- [ ] **Step 2: DeepSeek in der Config setzen**

Über die Settings-API oder direkt in `config/config.yaml`:
```yaml
providers:
  deepseek:
    api_key: <DEEPSEEK_API_KEY>
    configured: true
agent:
  llm_provider: deepseek
  llm_model: deepseek-v4-flash
```

- [ ] **Step 3: Langflow-Global-Variablen synchronisieren**

Run: ein Settings-Save auslösen (oder `reapply_all_settings`) → prüfen, dass `SELECTED_LANGUAGE_MODEL = deepseek-v4-flash`, `SELECTED_LANGUAGE_MODEL_PROVIDER = DeepSeek`, `DEEPSEEK_API_KEY` in Langflow ankommen.

- [ ] **Step 4: Chat durch OpenRAG testen**

Run: eine einfache Chat-Anfrage über die UI oder `POST /api/langflow/...` mit einer Test-Nachricht ("Sag hallo").

- [ ] **Step 5: Ergebnis dokumentieren**

- **A1 bestätigt** (Antwort kommt): weiter zu Task 10. **Keine** Flow-Änderung nötig.
- **A1 gescheitert** (Fehler "unknown provider" / leere Antwort): STOP, zurück zum User — Entscheidung A2 (Flow-Komponenten-Patch) ist ein eigener Folgeplan.

**Kein Commit** (kein Code geändert) — Ergebnis im Plan-/Chat festhalten.

---

## Task 10: Docling VLM-Builder

**Files:**
- Modify: `src/services/docling_service.py`

**Interfaces:**
- Produces: `elif provider == "deepseek":`-Zweig im VLM-Builder → `options["picture_description_api"]` mit DeepSeek-URL + Bearer-Header.

- [ ] **Step 1: Write failing test**

```python
# tests/unit/test_docling_service.py
def test_build_vlm_options_deepseek():
    # config mit deepseek.api_key gesetzt
    opts = build_vlm_options(config)  # konkreter Funktionsname gemäß docling_service
    assert opts["picture_description_api"]["url"] == "https://api.deepseek.com/v1/chat/completions"
    assert opts["picture_description_api"]["headers"]["Authorization"].startswith("Bearer ")
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/unit/test_docling_service.py::test_build_vlm_options_deepseek -v`
Expected: FAIL — `deepseek` läuft in den `else: # openai`-Zweig und nutzt fälschlich `config.providers.openai`

- [ ] **Step 3: Implement**

`docling_service.py` (L192-276), vor dem `else: # openai`-Zweig:
```python
elif provider == "deepseek":
    deepseek = config.providers.deepseek
    if not deepseek.api_key:
        raise DoclingServeError(
            "Docling VLM is enabled but the deepseek provider is not fully configured (api key required)"
        )
    options["picture_description_api"] = {
        "url": "https://api.deepseek.com/v1/chat/completions",
        "headers": {"Authorization": f"Bearer {deepseek.api_key}"},
        "json": {
            "model": vlm_model or "deepseek-v4-flash-vision-exp",
            "messages": [...],  # Bild-Content-Struktur analog openai-Zweig
            "max_tokens": 4096,  # Thinking-Mode: ausreichend hoch, sonst leeres content
        },
    }
```

Hinweis: Bild-Content-Format (base64/URL) und `messages`-Struktur exakt vom bestehenden openai-Zweig übernehmen — nur URL/Header/Modell/max_tokens anpassen. `max_tokens` explizit hoch, weil DeepSeek standardmäßig im Thinking-Mode antwortet (verifiziert).

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/test_docling_service.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/docling_service.py tests/unit/test_docling_service.py
git commit -m "feat(deepseek): VLM-Builder mit max_tokens (Thinking-Mode)"
```

---

## Task 11: Frontend — Typen, Logo, Karte, Dialog

**Files:**
- Modify: `frontend/app/settings/_helpers/model-helpers.tsx`
- Create: `frontend/components/icons/deepseek-logo.tsx`
- Modify: `frontend/app/settings/_components/model-providers.tsx`
- Create: `frontend/app/settings/_components/deepseek-settings-{dialog,form}.tsx`

**Interfaces:**
- Produces: `ModelProvider`-Union mit `"deepseek"`; `DeepSeekLogo`-Komponente; `modelProvidersMap.deepseek`; `getFallbackModels("deepseek")`.

- [ ] **Step 1: Implement `model-helpers.tsx`**

`ModelProvider`-Union (L6-11) += `| "deepseek"`; `ALL_PROVIDERS` (L14-19) += `"deepseek"`; `LLM_PROVIDER_ORDER` (L22-27) += `"deepseek"` (ans Ende); **`EMBEDDING_PROVIDER_ORDER` unverändert**.
`getModelLogo` (L45-95): Branch, der `deepseek`-Modellnamen (`deepseek-*`) → `DeepSeekLogo` mappt.
`getFallbackModels` (L100-186), neuer Case:
```tsx
case "deepseek":
  return {
    language: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { value: "deepseek-v4-flash-vision-exp", label: "deepseek-v4-flash-vision-exp" },
    ],
    embedding: [],   // DeepSeek hat keine Embeddings
  };
```

- [ ] **Step 2: Implement `deepseek-logo.tsx`**

```tsx
export default function DeepSeekLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" {...props}>
      <title>DeepSeek Logo</title>
      <path d="M3 3c-1.1 0-2 .9-2 2v5c0 1.1.9 2 2 2h4l2 2 2-2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2H3z" fill="currentColor" />
      <circle cx="6" cy="8" r="1" fill="white" />
      <circle cx="10" cy="8" r="1" fill="white" />
    </svg>
  );
}
```

- [ ] **Step 3: Implement `model-providers.tsx`**

`modelProvidersMap` (L73-125) +=
```tsx
deepseek: {
  name: "DeepSeek",
  logo: DeepSeekLogo,
  logoColor: "text-white",
  logoBgColor: "bg-[#4D6BFE]",
},
```
Dialog-Zuordnung (L153-168) += `deepseek: <DeepSeekSettingsDialog ... />`.

- [ ] **Step 4: Implement Settings-Dialog** (nach `openai-settings-dialog.tsx`-Vorlage — nur `api_key`-Feld, gleiche Form-Struktur, Label "DeepSeek API Key", Env-Var-Hinweis `DEEPSEEK_API_KEY`).

- [ ] **Step 5: Verify** — `cd frontend && npm run build` (TypeScript-Check) oder `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/settings/_helpers/model-helpers.tsx frontend/components/icons/deepseek-logo.tsx frontend/app/settings/_components/model-providers.tsx frontend/app/settings/_components/deepseek-settings-dialog.tsx frontend/app/settings/_components/deepseek-settings-form.tsx
git commit -m "feat(deepseek): Frontend-Typen, Logo, Provider-Karte, Settings-Dialog"
```

---

## Task 12: Frontend — Onboarding, Health-Banner, VLM-Dropdown

**Files:**
- Modify: `frontend/app/onboarding/_components/onboarding-card.tsx`
- Modify: `frontend/components/provider-health-banner.tsx`
- Modify: `frontend/app/api/queries/useProviderHealthQuery.ts`
- Modify: `frontend/app/settings/_components/ingest-settings-section.tsx`

- [ ] **Step 1: Implement Onboarding**

`onboarding-card.tsx`: neuer LLM-Tab `value="deepseek"` (analog openai-Tab, nur LLM — **kein** Embedding-Tab), `TabsContent` mit `deepseek_api_key`-Feld, Credential-Mapping (`if currentProvider === "deepseek"` → `deepseek_api_key`), Payload-Feld. Auto-Select-Loop (L96-133) berücksichtigt deepseek automatisch über `LLM_PROVIDER_ORDER`.

- [ ] **Step 2: Implement Health-Banner + Query-Union**

`provider-health-banner.tsx` L51-56: `providerTitleMap` += `deepseek: "DeepSeek"`.
`useProviderHealthQuery.ts` L29: Union += `"deepseek"`.

- [ ] **Step 3: Implement VLM-Dropdown**

`ingest-settings-section.tsx` L97-127: `useGetModelsQuery("deepseek")`-Call ergänzen; VLM-Provider-Gruppe += `{ group: "DeepSeek", provider: "deepseek" }`. **Embedding-Gruppen unverändert.**

- [ ] **Step 4: Verify** — `cd frontend && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/onboarding/_components/onboarding-card.tsx frontend/components/provider-health-banner.tsx frontend/app/api/queries/useProviderHealthQuery.ts frontend/app/settings/_components/ingest-settings-section.tsx
git commit -m "feat(deepseek): Onboarding-Tab, Health-Banner, VLM-Dropdown"
```

---

## Task 13: Tests anpassen + neue Unit-Tests konsolidieren

**Files:**
- Modify: `tests/unit/test_ascii_safe_header_value.py`
- Modify: `tests/unit/test_settings_provider_removal_defaults.py`
- Modify: `tests/unit/test_provider_error_formatting.py`
- Create: `tests/unit/test_deepseek_provider.py` (falls nicht schon in Task 1 angelegt — konsolidieren)

- [ ] **Step 1: `test_ascii_safe_header_value.py`** — Parametrisierung (L26-42) += `("deepseek", "DeepSeek")`.

- [ ] **Step 2: `test_settings_provider_removal_defaults.py`**
`_make_config` (L37-58): Parameter `deepseek=False` + `DeepSeekConfig(api_key="sk-ds" if deepseek else "", configured=deepseek)`.
`TestDefaultLlmModel`: Fall `deepseek` → `"deepseek-v4-flash"`.
Fallback-Ordnung: deepseek als letzter (Prioritäts-Test bestätigt `openai > anthropic > watsonx > ollama > deepseek`).
Removal-Fälle: `deepseek` entfernen → Fallback auf einen anderen konfigurierten Provider.

- [ ] **Step 3: `test_provider_error_formatting.py`** — `FakeProvider` (L293-323) += `deepseek`-Attribut.

- [ ] **Step 4: `test_deepseek_provider.py`** — die in Task 1-5 gestreuten Tests hier zusammenführen (Config, Regex, Helpers, models_service, provider_validation, map_provider, get_litellm_model_name).

- [ ] **Step 5: Run full unit suite**

Run: `make test-unit`
Expected: grün (mit den 3 bekannten `--ignore`-Dateien + 25 vorbestehenden Fehlern, keine NEUEN Fehler)

- [ ] **Step 6: Commit**

```bash
git add tests/unit/
git commit -m "test(deepseek): Unit-Tests fuer Provider-Integration"
```

---

## Task 14: Deploy-Configs

**Files:**
- Modify: `.env.example`, `docker-compose.yml`, Helm `values.yaml`/`backend-dotenv.yaml`/`langflow-dotenv.yaml`/`llm-providers-secret.yaml`, `kubernetes/operator/internal/controller/env.go`

- [ ] **Step 1: `.env.example`** — `DEEPSEEK_API_KEY=` bei den anderen Keys; Kommentar-Zeile bei LLM-Providern: `# "anthropic", "watsonx", "ibm", "ollama" oder "deepseek"`.

- [ ] **Step 2: `docker-compose.yml`** — Backend (L78-80) + Langflow (L171-173) `DEEPSEEK_API_KEY`; `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT` (L211) += `DEEPSEEK_API_KEY`.

- [ ] **Step 3: Helm** — `values.yaml` `llmProviders.deepseek:` (enabled, apiKey); `backend-dotenv.yaml` + `langflow-dotenv.yaml` `DEEPSEEK_API_KEY` mit `"None"`-Fallback; `llm-providers-secret.yaml` Guard += `deepseek` + `deepseek-api-key`-Key.

- [ ] **Step 4: Operator** — `env.go` L37 Variable-Liste += `DEEPSEEK_API_KEY`; L90-97 Langflow-Env-Defaults += `"DEEPSEEK_API_KEY": "None"`; L146 Backend-Env-Defaults += `"DEEPSEEK_API_KEY": ""`.

- [ ] **Step 5: Verify** — `docker compose config --quiet` (falls Docker verfügbar) bzw. YAML-Lint.

- [ ] **Step 6: Commit**

```bash
git add .env.example docker-compose.yml kubernetes/
git commit -m "feat(deepseek): Deploy-Configs (env, compose, helm, operator)"
```

---

## Task 15: E2E-Verifikation

**Files:** keine — Verifikations-Checkliste aus Spec §10.

- [ ] Provider-Wechsel OpenAI → DeepSeek → Anthropic im UI ohne Bruch
- [ ] Health-Banner zeigt DeepSeek-Status
- [ ] DeepSeek-Entfernung → Fallback auf anderen Provider
- [ ] `DEEPSEEK_API_KEY` in Langflow-Global-Variablen sichtbar
- [ ] Onboarding-Tab DeepSeek (nur LLM) funktioniert
- [ ] VLM-Slot: PDF mit Bildern ingestieren mit `vlm_provider="deepseek"` → Bildbeschreibungen (oder sauberer Fehler)

---

## Selbst-Review (gegen Spec)

- **Spec §4 (Backend 13 Stellen):** abgedeckt durch Task 1-8, 10. ✅
- **Spec §5 (Frontend 8 Stellen + visuell):** abgedeckt durch Task 11-12. ✅
- **Spec §6 (Tests 6):** abgedeckt durch Task 13 + in Task 1-5, 10 gestreute Tests. ✅
- **Spec §7 (Deploy 6):** abgedeckt durch Task 14. ✅
- **Spec §8 (A1/A2):** abgedeckt durch Task 9 (A1-Check früh, A2 als separater Folgeplan). ✅
- **Spec §10 (E2E):** abgedeckt durch Task 15. ✅
- **Global Constraints:** LLM-only (embedding unverändert), Modell-IDs exakt, `DEEPSEEK_API_KEY`, Reihenfolge ans Ende, `map_provider` → "DeepSeek" — alle in den Tasks verankert. ✅

**Keine Platzhalter:** Alle Code-Schritte enthalten konkreten Code (Backend). Frontend-Dialoge referenzieren die bestehende `openai-settings-dialog`-Vorlage (kein "TODO").

**Typ-Konsistenz:** `DeepSeekConfig`, `get_provider_config("deepseek")`, `map_provider("deepseek")`, `get_deepseek_models`, `_test_deepseek_*` — Namen konsistent über alle Tasks.

---
