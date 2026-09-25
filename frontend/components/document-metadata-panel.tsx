"use client";

import type { ReactNode } from "react";
import { translateMetadataValue } from "@/lib/contract-metadata";

type Entry = [string, unknown];

const EMPTY_LABEL = "(Empty)";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Null, undefined, empty string, empty array, empty object. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** "extraktion_korrekt" -> "Extraktion korrekt" */
function formatKey(key: string): string {
  return key.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Prefer a natural identifier over the array index, so React keeps element
 * identity when metadata lists are reordered. Falls back to the index only
 * for values that carry no identifying field.
 */
function itemKey(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    for (const field of ["id", "key", "bezeichnung", "name"]) {
      const value = item[field];
      if (typeof value === "string" && value) return value;
    }
  }
  return String(index);
}

/** Empty values stay visible as "(Empty)" rather than disappearing. */
function MetadataValue({ value }: { value: unknown }) {
  if (isEmpty(value)) {
    return (
      <span className="italic text-muted-foreground/60">{EMPTY_LABEL}</span>
    );
  }
  // Display translations (flow verdicts, unit qualifiers) apply to every
  // string, so the panel and the table read the same.
  return <>{translateMetadataValue(formatScalar(value))}</>;
}

/** Label left, value right — matches the sidebar's data grid. */
function MetadataRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="sm:grid sm:grid-cols-3 sm:gap-4 sm:px-0 mb-2">
      <dt className="text-sm/6 text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm/6 text-gray-800 dark:text-gray-100 sm:col-span-2 sm:mt-0 break-words min-w-0">
        <MetadataValue value={value} />
      </dd>
    </div>
  );
}

/** Every field of a list entry gets its own row — nothing is joined together. */
function MetadataItem({ item }: { item: unknown }) {
  if (!isPlainObject(item)) {
    return <MetadataRow label="" value={item} />;
  }

  return (
    <dl>
      {Object.entries(item).map(([key, value]) => (
        <MetadataRow key={key} label={formatKey(key)} value={value} />
      ))}
    </dl>
  );
}

function MetadataEntry({ name, value }: { name: string; value: unknown }) {
  // Object wrapper: hide the key itself and lift its children to this level,
  // so a purely structural level like "extrahiertes_json" adds no visual noise.
  // An *empty* object is not a wrapper — it renders as a row so it stays visible.
  if (isPlainObject(value) && !isEmpty(value)) {
    return <MetadataEntries entries={Object.entries(value)} />;
  }

  // Array: section heading, entries indented beneath it.
  if (Array.isArray(value) && !isEmpty(value)) {
    return (
      <div className="mb-2.5">
        <dt className="text-sm/6 font-medium text-foreground">
          {formatKey(name)}
        </dt>
        <dd className="pl-4 mt-1 space-y-3">
          {value.map((item, index) => (
            <MetadataItem key={itemKey(item, index)} item={item} />
          ))}
        </dd>
      </div>
    );
  }

  return <MetadataRow label={formatKey(name)} value={value} />;
}

function MetadataEntries({ entries }: { entries: Entry[] }) {
  return (
    <dl>
      {entries.map(([name, value]) => (
        <MetadataEntry key={name} name={name} value={value} />
      ))}
    </dl>
  );
}

/**
 * Shows user-supplied document metadata (whatever keys the ingest stored).
 * Every key is rendered — including empty ones, which show as "(Empty)".
 * Renders nothing only when there is no metadata at all.
 */
export function DocumentMetadataPanel({
  metadata,
}: {
  metadata?: Record<string, unknown>;
}) {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  return (
    <div className="mb-4">
      <h2 className="text-xl font-semibold mt-2 mb-3">Document metadata</h2>
      <MetadataEntries entries={Object.entries(metadata)} />
    </div>
  );
}
