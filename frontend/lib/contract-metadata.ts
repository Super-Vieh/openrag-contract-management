/**
 * Display translations for contract metadata.
 *
 * The ingestion flow emits raw, verbose values ("✅ VALIDIERUNG ERFOLGREICH",
 * "EUR netto"). This module is the single place that turns them into something
 * readable for the UI.
 *
 * Keep it a *presentation-only* layer: it never touches the stored data, and
 * nothing else in the app depends on it. Delete it, or move the translations
 * into the flow, without touching any other file.
 */

/**
 * Raw value -> display value. Anything not listed here passes through
 * unchanged, so an unmapped value is still visible rather than blank.
 */
const DISPLAY_LABELS: Record<string, string> = {
  // Flow verdicts -> short labels
  "✅ VALIDIERUNG ERFOLGREICH": "Success",
  // Units carrying a qualifier -> plain unit
  "EUR netto": "EUR",
};

/** Translate a raw metadata string for display. Unknown values pass through. */
export function translateMetadataValue(value: string): string {
  return DISPLAY_LABELS[value] ?? value;
}

/** "645000.0" -> "645.000,00". Non-numeric values pass through unchanged. */
export function formatNumber(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed)) return text;
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

/** Find one entry of `extrahiertes_json.parameter` by its `bezeichnung`. */
function findParameter(
  metadata: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | null {
  const extrahiert = metadata?.extrahiertes_json;
  if (!extrahiert || typeof extrahiert !== "object") return null;

  const parameter = (extrahiert as Record<string, unknown>).parameter;
  if (!Array.isArray(parameter)) return null;

  const match = parameter.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).bezeichnung === name,
  );
  return (match as Record<string, unknown> | undefined) ?? null;
}

/**
 * Read one entry of `extrahiertes_json.parameter` by its `bezeichnung`,
 * formatted as "<wert> <einheit>" — e.g. "645.000,00 EUR".
 */
export function extractParameter(
  metadata: Record<string, unknown> | undefined,
  name: string,
): string | null {
  const record = findParameter(metadata, name);
  if (!record) return null;

  const einheit = record.einheit;
  const parts = [
    formatNumber(record.wert),
    typeof einheit === "string" && einheit
      ? translateMetadataValue(einheit)
      : "",
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The raw numeric value of a parameter, for sorting. The display string is
 * German-formatted ("645.000,00 EUR") and would sort as text, so comparators
 * use this instead.
 */
export function extractParameterValue(
  metadata: Record<string, unknown> | undefined,
  name: string,
): number | null {
  const record = findParameter(metadata, name);
  if (!record) return null;
  const parsed = Number(record.wert);
  return Number.isFinite(parsed) ? parsed : null;
}
