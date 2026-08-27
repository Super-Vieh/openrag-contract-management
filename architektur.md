# Architektur — Offene Fragen & Antworten

Dieses Dokument sammelt kurze Architektur-Fragen (aktuell zum
Vertragsmanagement) und hält die Antworten knapp fest. Neue Fragen werden
unten ergänzt, Antworten darunter eingetragen.

---

## Fragen & Antworten

### 1. Wie speichern wir die Dokumente, die in den Vertragsmanagement-Flow eingehen?

**Entscheidung:**
- Wir nutzen den **normalen Ingestion-Flow** (Docling → Chunk → Embed → OpenSearch)
  unverändert.
- Die **Zusatz-Informationen** (Vertrags-Metadaten wie `category`, `parties`,
  `amount`, `critical`, `empfehlung`) werden **über `docs_metadata` in das
  `metadata`-Feld** der Chunks geschrieben (im Flow, z. B. per LLM-Analyse-Schritt).
- **PDF-Dateien** → im **Langflow-Datei-Store** (die Originale).

**Begründung:**
- Kein separater Analyse-Flow / kein separater JSON-Store nötig — der normale
  Ingest übernimmt alles.
- Verträge sind dadurch automatisch durchsuchbar (vektorisiert) und tragen ihre
  Struktur-Daten in den Metadaten.
- `category`-Filterung (Frage 2) und Vektorsuche funktionieren ohne Umbau.

### 2. Wie trennen wir Verträge von normalen Wissen-Dokumenten?

**Entscheidung:**
- **Keine harte Trennung** — alle Dokumente (Verträge + normale) liegen im selben
  OpenSearch-Index.
- Jedes Dokument trägt ein **`category`-Feld**:
  - Verträge → `category: "contract"`
  - normale Dokumente → `category: "general"`
- Die Ansichten **filtern** danach:
  - Vertragsmanagement-Seite → zeigt nur `category: "contract"`
  - Knowledge-Tab → zeigt nur `category: "general"`

### 3. Welche Felder hat das Vertrags-JSON (Schema)?

<!-- Noch nicht beantwortet -->

### 4. Wie übernehmen wir den Knowledge-Tab für das Vertragsmanagement?

**Ansatz:** Den Knowledge-Tab **kopieren und modifizieren** — nicht neu bauen.

**Modifikationen (Frontend):**
- `app/knowledge/page.tsx` → `app/vertragsmanagement/page.tsx` (Seite kopieren, Titel ändern)
- Tabellenspalten austauschen: statt `Size/Chunks/Embedding model` →
  Vertrags-Spalten (`category`, `parties`, `amount`, `status`, `start_date`, `end_date`)
- Daten-Hook: `useListFiles` → Filter `category: "contract"` übergeben

**Modifikationen (Backend):**
- `file_service.list_files` / `src/api/v2/files.py`: optionalen `category`-Parameter
  ergänzen (minimal) ODER eigener Endpoint `/api/contracts` (sauberer)
- `_build_file_aggregation`: `metadata` in den `_source` aufnehmen, damit
  Vertrags-Felder in der Tabelle erscheinen

**Voraussetzung:** Verträge müssen beim Ingest `category: "contract"` tragen
(über `docs_metadata` im Flow — siehe Frage 1), sonst erscheinen sie nicht im Filter.

**Empfehlung:** Minimal starten (Seite kopieren + `category`-Filter + Spalten),
eigene Endpoints später ergänzen.

---

## Referenz: Das echte OpenSearch-Chunk-Schema

Quelle: `src/services/document_index_writer.py`, `_build_chunk_document`
(Zeile 216–272) + `_scoped_chunk_id` (Zeile 153–157).

**ID und Index:**

```python
scope_digest = sha256("shared" | "owner:{owner}")[:24]
_id   = f"{scope_digest}_{chunk_id}"        # chunk_id = {document_id}_{batch_id}_{index}
_index = get_index_name()                    # Standard: "documents"
```

**Dokument-Body (Pflichtfelder):**

```json
{
  "document_id": "…",
  "filename": "…",
  "mimetype": "…",
  "page": 0,
  "text": "…",
  "<embedding_field>": [0.12, 0.34, ...],
  "embedding_model": "…",
  "embedding_dimensions": 768,
  "file_size": 0,
  "connector_type": "local",
  "source_url": "",
  "allowed_users": [],
  "allowed_groups": [],
  "allowed_principals": [],
  "allowed_principal_labels": [],
  "indexed_time": "…",
  "metadata": {}
}
```

**Optionale Felder (nur wenn gesetzt):**

```
parser, chunk_size, chunk_overlap,
owner, owner_name, owner_email,
ingest_run_id, connector_file_id,
is_sample_data ("true"), created_time, modified_time
```

**Erweiterungs-Stelle:** Das `metadata`-Objekt ist der offizielle Ort für
Kategorien/Zusatzfelder (befüllt z. B. vom `docs_metadata`-Input der
Langflow-OpenSearch-Komponente). Vertrags-Felder wie `category`, `title`,
`parties`, `amount` gehören dorthin oder als neue Felder auf oberster Ebene
(dann `_build_chunk_document` erweitern).

**Metadaten sind frei designbar:** Das `metadata`-Objekt kann beliebige
Key-Value-Paare, Arrays und verschachtelte JSON-Objekte enthalten — es gibt
**kein festes Schema**, die Felder legst du selbst fest (z. B. `category`,
`parties`, `amount`, `critical`, `empfehlung`). Befüllt wird es über den
`docs_metadata`-Input im Langflow-Flow oder im Backend.

**Achtung — Problem der Verschachtelung (nested metadata):**
- Das `metadata`-Feld KANN beliebig tief verschachtelt werden, ABER OpenSearch
  behandelt verschachtelte Objekte besonders:
  - Standard-`object`-Mapping **flacht Arrays ab** → ein Filter auf ein
    Array-Element prüft „irgendeines", nicht „alle".
  - Arrays **von Objekten** brauchen ein `nested`-Mapping, sonst sind
    Filter/Sortierung falsch oder unmöglich.
  - Tiefe Verschachtelung erschwert Range-Queries und Sortierung.
- **Empfehlung:** Metadaten möglichst **flach** halten (Key-Value auf einer
  Ebene). Filterbare Strukturdaten (`status`, `amount`, `start_date`,
  `end_date`) gehören auf **oberste Ebene** (typisierte Felder → Range-Queries).
  Verschachtelung nur, wenn wirklich nötig (dann passendes Mapping setzen).

---

## Referenz: Der zweiphasige Docling + OpenSearch-Flow

Quelle: `src/services/langflow_file_service.py` `upload_and_ingest_file`
(Zeile 981) + `src/services/document_index_writer.py` `index_chunks`.

**Die zwei Phasen:**
```
Phase 1 (DOCLING): Backend submitet Datei an Docling (OCR/Parse) und POLLT,
                   bis das Parse-Ergebnis fertig ist.
Phase 2 (INGEST):  Backend startet den Langflow-Ingestion-Flow mit der
                   Docling-task_id; die DoclingRemote-Komponente HOLT das
                   fertige Ergebnis, dann Chunk → Embed → Callback ans Backend.
```

**Zwei Modi** (abhängig von `docling_polling_service`):
- Modus A (aktiv): Backend submitet + pollt Docling → Langflow holt fertiges
  Ergebnis (Langflow-Slots bleiben frei bei langer OCR).
- Modus B (Legacy): Langflow pollt Docling selbst.

**Der komplette Weg PDF → OpenSearch:**
```
UI-Button → /api/router/upload_ingest → Proxy → Router → Handler (202 + task_id)
   → async Task → background_custom_processor → process_item
   → upload_and_ingest_file
        ├─ Phase 1: Docling (Backend pollt)
        └─ Phase 2: Langflow-Flow (Chunk → Embed → OpenSearch-Komponente)
   → Callback (POST /internal/ingest/chunks + Token)
   → writer.index_chunks → client.bulk() → OPENSEARCH
Original-PDF bleibt im Langflow-Datei-Store.
```

**Deterministische Chunk-ID — warum und wie:**

```python
# document_index_writer.py:153
scope_digest = sha256("shared" | "owner:{owner}")[:24]
_id = f"{scope_digest}_{chunk_id}"        # chunk_id = {document_id}_{batch_id}_{index}
```

- `document_id` = **Inhalts-Hash** der Datei (`file_hash`) → gleiche Datei = gleiche ID.
- `chunk_id` = `document_id_batch_id_index` → deterministisch aus Datei + Lauf + Position.
- `_id` = `scope_digest_chunk_id` → deterministisch aus Nutzer-Scope + chunk_id.

**Sichergestellt durch:** Re-Ingest derselben Datei (gleicher Inhalt → gleicher
Hash → gleiche `document_id` → gleiche `_id`) führt zum **Upsert** (Überschreiben),
nicht zu Duplikaten. Die IDs sind berechenbar, nicht zufällig.
