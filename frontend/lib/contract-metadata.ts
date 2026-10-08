/**
 * Read and translate contract metadata for the Vertragsmanagement table.
 *
 * The ingestion flow stores a free-form metadata document per file. This module
 * is the single place that knows which paths the table reads and how the raw
 * values are worded.
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
};

/** Translate a raw metadata string for display. Unknown values pass through. */
export function translateMetadataValue(value: string): string {
  return DISPLAY_LABELS[value] ?? value;
}

/**
 * Read a nested value out of document metadata by path — e.g.
 * `["contract", "term", "start"]` -> "2024-05-15".
 *
 * Returns null when a step of the path is missing, is not an object, or holds
 * nothing displayable. A metadata schema change therefore degrades to empty
 * cells rather than throwing.
 */
function extractMetadataString(
  metadata: Record<string, unknown> | undefined,
  path: string[],
): string | null {
  let current: unknown = metadata;

  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }

  if (typeof current === "string") return current.trim() ? current : null;
  // JSON gives numbers and booleans raw; show them instead of hiding the cell.
  if (typeof current === "number" || typeof current === "boolean") {
    return String(current);
  }
  return null;
}

/**
 * "422500" -> "422.500,00". Anything that is not a plain number passes through
 * unchanged, so dates and labels stay untouched.
 *
 * Opt-in per column: applying it everywhere would rewrite values like
 * "1.0" into "1,00".
 */
export function formatNumber(value: string): string {
  if (!value.trim()) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

export type MetadataFieldOptions = {
  /** Sibling path holding the unit, appended to the value: "422500" + "EUR". */
  unitPath?: string[];
  /** Applied to the value *before* the unit is appended — pass `formatNumber`
   *  for money, where the unit must not reach the number parser. */
  format?: (value: string) => string;
};

/**
 * Read one metadata path and format it for the table.
 *
 * With `unitPath`, the value found there is appended as a unit — the amount
 * `["contract", "pricing", "total"]` plus `["contract", "currency"]` reads as
 * "422500 EUR", or "422.500,00 EUR" when `format: formatNumber` is set.
 * A missing unit leaves the bare amount.
 */
export function formatMetadataField(
  metadata: Record<string, unknown> | undefined,
  path: string[],
  options: MetadataFieldOptions = {},
): string | null {
  const raw = extractMetadataString(metadata, path);
  if (raw === null) return null;

  const text = translateMetadataValue(
    options.format ? options.format(raw) : raw,
  );
  if (!options.unitPath) return text;

  const unit = extractMetadataString(metadata, options.unitPath);
  return unit ? `${text} ${translateMetadataValue(unit)}` : text;
}

/**
 * The numeric amount behind a metadata path, for sorting money columns.
 *
 * The display string ("422500 EUR") would sort as text, where "99999 EUR"
 * lands *after* "422500 EUR". Comparators use this instead.
 */
export function extractMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  path: string[],
): number | null {
  const raw = extractMetadataString(metadata, path);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
