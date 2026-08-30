# Design: DeepSeek als LLM-Provider in OpenRAG

Datum: 2026-08-29 · Status: Entwurf zur Freigabe · Scope: `src/`, `frontend/`, `tests/`, Deploy-Configs

## 1. Kontext & Ziel

DeepSeek wird als **vollwertiger LLM- und VLM-Provider** (Chat/Agent +
Bildbeschreibungen beim Ingest) in OpenRAG integriert — konfigurierbar über UI
+ Onboarding, mit Key-Verschlüsselung, Modell-Liste, Health-Check und
Langflow-Sync, analog zu den bestehenden Providern (openai, anthropic,
watsonx, ollama).

**Ziel:** Echte Feature-Erweiterung (upstream-würdig), nicht nur lokale Bastellösung.

**Rahmenbedingungen:**
- DeepSeek hat **keine Embedding-API** → kein Embedding-Provider.
- DeepSeek-API ist **OpenAI-kompatibel** (`https://api.deepseek.com/v1/chat/completions`).
- Aktuelle Modell-IDs: `deepseek-v4-flash` (Chat-Default, günstig),
  `deepseek-v4-pro` (stärker) und `deepseek-v4-flash-vision-exp`
  (multimodal, **experimentell**, seit 21.08.2026). Die alten IDs
  `deepseek-chat`/`deepseek-reasoner` sind seit **24.07.2026 eingestellt** (HTTP 400).
- **Slot-Trennung:** Chat nutzt `deepseek-v4-flash`, Vision-Tasks (VLM-Slot)
  nutzen `deepseek-v4-flash-vision-exp` — die Slots sind unabhängig.

## 2. Grundentscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| 1 | **LLM + VLM-Slot** — keine Embeddings | DeepSeek hat keine Embedding-API; Vision-Modell nur im VLM-Slot (Bildbeschreibungen), Chat bleibt bei Flash |
| 2 | **OpenAI-kompatibles Muster** | Health-/Completion-Tests, Modell-Liste, VLM-Builder und `get_litellm_model_name` folgen dem OpenAI-Muster; LiteLLM routet via `deepseek/`-Präfix |
| 3 | **Default-Modell `deepseek-v4-flash`** für Chat; `deepseek-v4-flash-vision-exp` für den VLM-Slot | Empfohlene Modelle der DeepSeek-Doku; `deepseek-v4-pro` erscheint in der Modell-Liste. Hinweis: Thinking-Mode ignoriert `temperature` etc. |
| 4 | **Key-Pfad wie alle anderen**: `DEEPSEEK_API_KEY` (env > config.yaml, AES-256-GCM-verschlüsselt) | Gleiche Mechanik wie `OPENAI_API_KEY` — ein Key für Chat + VLM |
| 5 | **Embedding-Pfad bleibt unberührt** | `embedding_provider`-Regex, `_EMBEDDING_PROVIDER_NAMES`, Embedding-Slots in `flows_service` — unverändert |
| 6 | **Bild-Chat im Agent nicht Teil dieses Scopes** | `_deepseek_supports_images` wird bewusst NICHT ergänzt (Future Work §11) — das Vision-Modell dient nur dem VLM-Slot |
| 7 | **Statische Modell-Liste als Primärweg** (verifiziert 2026-08-30) | `GET /v1/models` liefert für den getesteten DeepSeek-Key-Typ **HTTP 401** ("Authentication Fails (governor)"), während `/chat/completions` mit demselben Key 200 liefert → `get_deepseek_models` nutzt die statische Liste (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`); Live-Fetch nur optional mit Fallback |
| 8 | **Thinking-Mode beachten** (verifiziert 2026-08-30) | DeepSeek V4 antwortet standardmäßig mit `reasoning_content`; bei zu kleinem `max_tokens` bleibt `content` leer → VLM-Builder + Health-Tests müssen ausreichend `max_tokens` setzen |

## 3. Architektur: Der Weg des DeepSeek-Providers (LiteLLM-Pfad)

OpenRAG hat **zwei getrennte Provider-Pfade**:

- **Pfad A (Chat/Agent, LLM):** OpenRAG → Langflow-Global-Variablen + Header →
  LanguageModelComponent (Langflow-Builtin) → **Langflows internes LiteLLM** → API.
  OpenRAG ruft die LLM-API hier nie direkt auf — es ist nur ein "String-Schieber"
  (Provider + Modell als Global-Variablen, API-Key als Header).
- **Pfad B (Embeddings, traditioneller Ingest):** OpenRAG → eigenes LiteLLM
  (`patched_embedding_client` in `config/settings.py`). Bleibt für DeepSeek unberührt.

**DeepSeek (LLM-only) reist ausschließlich über Pfad A:**

```
OpenRAG speichert deepseek_api_key (verschlüsselt in config.yaml)
   → sync:  SELECTED_LANGUAGE_MODEL = "deepseek-v4-flash"
            SELECTED_LANGUAGE_MODEL_PROVIDER = "DeepSeek"
            X-LANGFLOW-GLOBAL-VAR-DEEPSEEK_API_KEY = <Key>   (Header-Injection)
   → Langflow: LanguageModelComponent → get_llm(provider="DeepSeek", model="deepseek-v4-flash")
   → Langflows LiteLLM routet: deepseek/ → https://api.deepseek.com
```

**A1-first:** Die eingebaute LanguageModelComponent wird **zuerst** unverändert
genutzt (A1-Check, siehe §8). Eine Modifikation der eingebetteten Komponenten-Codes
(A2) ist **nur der Fallback**, falls der A1-Check zeigt, dass Langflow den
Provider-String "DeepSeek" nicht akzeptiert.

**LiteLLM-Namensauflösung:** `get_litellm_model_name` (models_service.py L198–242)
liefert für DeepSeek `deepseek/deepseek-v4-flash` (Präfix fürs Routing); LiteLLM
entfernt den Präfix beim Senden an die DeepSeek-API selbst. Im Chat-Pfad übernimmt
Langflows LiteLLM diese Auflösung.

**VLM-Pfad (Bildbeschreibungen beim Ingest):** Der VLM-Slot ist von Chat und
Embeddings unabhängig — `knowledge.vlm_provider` + `knowledge.vlm_model`
(config_manager.py L185–186) steuern `docling_service.py` (eigener Builder pro
Provider, L192–276). DeepSeek-VLM ruft `https://api.deepseek.com/v1/chat/completions`
mit Bild-Content auf (OpenAI-kompatibel, Modell `deepseek-v4-flash-vision-exp`),
Key aus demselben `DeepSeekConfig`.

## 4. Backend-Änderungen (~13 Stellen)

| # | Datei | Änderung |
|---|---|---|
| 1 | `src/config/config_manager.py` | Neues `DeepSeekConfig` (api_key, configured) + Feld in `ProvidersConfig`, `any_configured()`, `get_provider_config()`, `from_dict` (Entschlüsselung), Seed, `_load_env_overrides` → `DEEPSEEK_API_KEY` |
| 2 | `src/api/settings/models.py` | Regex `llm_provider` + **`vlm_provider`** (L26) + Onboarding: `deepseek` ergänzen (**`embedding_provider` bleibt**); `deepseek_api_key`-Felder in SettingsUpdateBody/OnboardingBody; `DeepSeekProviderConfig`-Response + Feld in `ProvidersConfig` |
| 3 | `src/api/settings/helpers.py` | `_LLM_PROVIDER_NAMES` += `deepseek`; `_default_llm_model["deepseek"] = "deepseek-v4-flash"` (**Embedding-Liste unverändert**) |
| 4 | `src/services/models_service.py` | `KNOWN_PREFIXES` += `deepseek`; `get_deepseek_models()`: **statische Liste als Primärweg** (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` — alle als Chat-Modelle, keine Embedding-Klassifikation nötig); optionaler Live-Fetch `GET /v1/models` mit Fallback auf die statische Liste (verifiziert: 401 bei getestetem Key-Typ); Registry-Block in `update_model_registry` |
| 5 | `src/api/provider_validation.py` | Dispatch-Ketten **health + completion** += deepseek; `_test_deepseek_*` nach OpenAI-Muster (Key direkt aus Config, `Authorization: Bearer`); Probe-Schleife (L266) += deepseek; **Embedding-Dispatch-Kette (`test_embedding`) bleibt unverändert (LLM-only)** |
| 6 | `src/api/models.py` + `src/app/routes/internal.py` | `POST /models/deepseek`-Endpoint (Route bei den anderen Providern) |
| 7 | `src/api/provider_health.py` | `valid_providers` += deepseek |
| 8 | `src/api/v1/models.py` | `VALID_PROVIDERS` += deepseek + Fetch-Branch |
| 9 | `src/api/settings/endpoints.py` | Onboarding-Credential-Block (`body.deepseek_api_key`), Removal-Block (`remove_deepseek_config`, Spiegel von `remove_openai_config`), `configured`-Markierung |
| 10 | `src/utils/langflow_headers.py` | `map_provider("deepseek") → "DeepSeek"`; `add_provider_credentials_to_headers` += Header `X-LANGFLOW-GLOBAL-VAR-DEEPSEEK_API_KEY` |
| 11 | `src/api/settings/langflow_sync.py` + `src/services/flows_service.py` | `LANGFLOW_CREDENTIAL_GLOBAL_VARIABLES` += `DEEPSEEK_API_KEY`; `_update_langflow_global_variables` Credential-Block; `change_langflow_model_value`-Allowlist (L1017) += deepseek; `_get_provider_name_display` (L639) → "DeepSeek"; **Embedding-Slots (L1150/1155) unverändert** |
| 12 | `src/tui/` | `config_fields.py` (DeepSeek-Feld), `utils/validation.py` (Key-Validator), ggf. `managers/env_manager.py` |
| 13 | `src/services/docling_service.py` | DeepSeek-VLM-Builder (L192–276): OpenAI-kompatibler Chat-Completions-Call mit Bild-Content, Modell `deepseek-v4-flash-vision-exp`, Key aus `DeepSeekConfig`; **max_tokens ausreichend hoch** (Thinking-Mode, sonst leeres `content`); Fehlerbehandlung analog watsonx (nicht vollständig konfiguriert → `DoclingServeError`) |

**Bewusst NICHT geändert:** `_EMBEDDING_PROVIDER_NAMES`, `embedding_provider`-Regex,
Embedding-Slots in `flows_service`, Embedding-Dispatch in `provider_validation`,
`patched_async_client`-Env-Injection (nicht nötig — Chat läuft über Langflow,
Health-Tests nehmen den Key direkt aus der Config), `max_tokens`-Zweige in
`processors.py`, HTTP/2-Probe (nur openai), OpenSearch-Embedding-Komponente,
**`_deepseek_supports_images`** (Bild-Chat im Agent = Future Work §11; das
Vision-Modell dient nur dem VLM-Slot).

## 5. Frontend-Änderungen

| # | Datei | Änderung |
|---|---|---|
| 1 | `frontend/app/settings/_helpers/model-helpers.tsx` | `ModelProvider`-Union += `"deepseek"`; `ALL_PROVIDERS` += deepseek; **`LLM_PROVIDER_ORDER`** += deepseek (**`EMBEDDING_PROVIDER_ORDER` bleibt**); `getModelLogo()`-Branch; `getFallbackModels("deepseek")` → `["deepseek-v4-flash", "deepseek-v4-pro"]` |
| 2 | `frontend/app/settings/_components/model-providers.tsx` | `modelProvidersMap`-Eintrag (Name "DeepSeek", Logo, Farben); `DeepSeekSettingsDialog` (Key-Feld) |
| 3 | `frontend/app/settings/_components/deepseek-settings-{dialog,form}.tsx` | **Neu** — nach OpenAI-Vorlage (nur `api_key`) |
| 4 | `frontend/app/onboarding/_components/onboarding-card.tsx` | **Nur LLM-Tab**: neuer Tab `value="deepseek"` + TabsContent + Credential-Mapping (`deepseek_api_key`) + Payload-Feld; Auto-Select-Loop über `LLM_PROVIDER_ORDER` berücksichtigt deepseek automatisch (**Embedding-Tab unverändert**) |
| 5 | `frontend/components/provider-health-banner.tsx` | `providerTitleMap` += `deepseek: "DeepSeek"` |
| 6 | `frontend/app/api/queries/useProviderHealthQuery.ts` | Union += `"deepseek"` |
| 7 | `frontend/components/icons/deepseek-logo.tsx` | **Neu** — Icon |
| 8 | `frontend/app/settings/_components/ingest-settings-section.tsx` | **VLM-Provider-Dropdown** (L97–127) += deepseek + `useGetModelsQuery("deepseek")` (**Embedding-Gruppen unverändert**) |

## 6. Test-Änderungen

| # | Datei | Änderung |
|---|---|---|
| 1 | `tests/unit/test_ascii_safe_header_value.py` | Parametrisierter Fall `("deepseek", "DeepSeek")` |
| 2 | `tests/unit/test_settings_provider_removal_defaults.py` | `_make_config(... deepseek=False)`; `TestDefaultLlmModel`-Fall `deepseek` → `"deepseek-v4-flash"`; Fallback-Ordnung; Removal-Fälle |
| 3 | `tests/unit/test_provider_error_formatting.py` | `FakeProvider` += `deepseek`-Attribut |
| 4 | **Neu** `tests/unit/test_deepseek_provider.py` | `get_litellm_model_name("deepseek-v4-flash", "deepseek")` → `deepseek/deepseek-v4-flash`; `map_provider`; Validierungs-Regex (inkl. `vlm_provider="deepseek"` akzeptiert, `embedding_provider="deepseek"` → 422); `get_provider_config("deepseek")` |
| 5 | `tests/unit/test_docling_service.py` | **Neu:** `test_build_vlm_options_deepseek` (Builder erzeugt OpenAI-kompatiblen Call mit `deepseek-v4-flash-vision-exp`); Fehlerfall: DeepSeek-Key fehlt → `DoclingServeError` |
| 6 | `frontend/tests/utils/onboarding.ts` + `config/provider.ts` | DeepSeek in `LLMProvider`-Typ + `PROVIDER_CONFIGS` (**nur LLM**) |

## 7. Deploy-Änderungen

| # | Datei | Änderung |
|---|---|---|
| 1 | `.env.example` | `DEEPSEEK_API_KEY=` + Kommentar-Zeile bei LLM-Providern |
| 2 | `docker-compose.yml` | Backend + Langflow-Service: `DEEPSEEK_API_KEY`; `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT` += `DEEPSEEK_API_KEY` |
| 3 | `kubernetes/helm/openrag/values.yaml` | `llmProviders.deepseek:` (enabled, apiKey) |
| 4 | Helm `backend-dotenv.yaml` + `langflow-dotenv.yaml` | `DEEPSEEK_API_KEY` mit `"None"`-Fallback |
| 5 | Helm `llm-providers-secret.yaml` | Guard + `deepseek-api-key` in stringData |
| 6 | `kubernetes/operator/internal/controller/env.go` | `DEEPSEEK_API_KEY` in Variable-Liste + Env-Defaults |

## 8. Langflow-Anpassung (nur als Fallback A2)

**A1-Check (primär, kein Code):** Nach Backend+Frontend wird empirisch getestet,
ob die eingebaute LanguageModelComponent `provider="deepseek"` akzeptiert:
Provider + Modell via OpenRAG-API setzen, einen Chat durch OpenRAG laufen lassen.
Langflow gibt `provider` nur an sein internes LiteLLM weiter → hohe Chance, dass
keine Modifikation nötig ist.

**Falls A2 nötig** (eingebetteter Code validiert gegen feste Liste):

1. In den Flow-JSONs (agent/nudges, ggf. ingest/url_ingest) den eingebetteten
   `LanguageModelComponent`-Code um einen DeepSeek-Zweig erweitern:
   `base_url = "https://api.deepseek.com"`, `api_key`-Input,
   Modell-Optionen `deepseek-v4-flash`/`deepseek-v4-pro`.
2. `change_langflow_model_value`-Allowlist += deepseek (s. §4, Nr. 11).
3. Provider-Dropdown-Optionen im Node-Template der Flows ergänzen.

⚠️ A2 macht OpenRAG zum Mini-Fork des Langflow-Komponenten-Codes. Der saubere
Upstream-Weg (DeepSeek in Langflows LanguageModelComponent) ist ein Langflow-PR
→ siehe Future Work (§10).

## 9. Fehlerbehandlung & Edge Cases

| Fall | Verhalten (analog bestehender Provider) |
|---|---|
| Key fehlt/falsch | `_test_deepseek_completion` schlägt fehl → UI-Fehlermeldung |
| DeepSeek-API down | Modell-Liste leer → Fehler im UI wie OpenAI-Pfad |
| Provider-Entfernung | `remove_deepseek_config`: leert Config, braucht ≥1 anderen Provider (sonst 409), Reshuffle via `_first_configured_llm_provider` |
| Unbekannter Provider-Name | `get_provider_config` → `ValueError("Unknown provider")` — laut (Safety-Net) |
| Thinking-Mode | Standardmäßig aktiv: Antwort kommt in `reasoning_content`, bei zu kleinem `max_tokens` bleibt `content` leer (verifiziert) — Health-Tests/VLM setzen genug `max_tokens`; `temperature` etc. werden im Thinking-Mode ignoriert |
| Langflow-Sync | Fehler beim Global-Var-Push → bestehendes Graceful-Error-Handling |
| SDK v1 | `tests/integration/sdk/test_models.py` `ALL_PROVIDERS` += deepseek |
| VLM konfiguriert, aber Key fehlt | `DoclingServeError` analog watsonx ("provider is not fully configured") |
| Vision-Modell experimentell | `deepseek-v4-flash-vision-exp` ist ein Exp-Modell — Fehler werden wie andere Provider-Fehler gemeldet; kein Sonderfall |

## 10. Verifikationsstrategie

**Implementierungs-Reihenfolge:**
1. Backend Config + Validierung → 2. Models-Service + Endpoints → 3. Langflow-Sync →
4. Frontend → 5. Tests → 6. Deploy → 7. A1-Check + E2E

**E2E-Checkliste (am Ende):**
- [ ] `make test-unit` grün inkl. neuer DeepSeek-Fälle
- [ ] **A1-Check:** Chat über OpenRAG mit DeepSeek-Provider funktioniert (Ergebnis: A1 ohne Modifikation / A2 nötig — dokumentieren)
- [ ] Provider-Wechsel OpenAI → DeepSeek → Anthropic im UI ohne Bruch
- [ ] Health-Banner zeigt DeepSeek-Status
- [ ] DeepSeek-Entfernung → Fallback auf anderen Provider
- [ ] `DEEPSEEK_API_KEY` in Langflow-Global-Variablen sichtbar
- [ ] Onboarding-Tab DeepSeek (nur LLM) funktioniert
- [ ] **VLM-Slot:** PDF mit Bildern ingestieren mit `vlm_provider="deepseek"` → Bildbeschreibungen erscheinen (oder sauberer Fehler, falls Key/Modell fehlt)

## 11. Future Work

- **Langflow upstream:** DeepSeek als Provider in Langflows eigener
  LanguageModelComponent (PR) — würde A2 dauerhaft überflüssig machen.
- **Bild-Chat im Agent:** `_deepseek_supports_images`-Branch
  (models_service.py L244–273) ergänzen, sobald `deepseek-v4-flash-vision-exp`
  nicht mehr experimentell ist — dann kann das Vision-Modell auch als Chat-Modell
  mit Bildeingabe dienen.
- **Embeddings:** Falls DeepSeek je eine Embedding-API anbietet, kann der
  Embedding-Pfad (Pfad B) nach demselben Muster ergänzt werden.
