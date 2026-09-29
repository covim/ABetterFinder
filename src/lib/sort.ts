import type { DateField, SearchHit } from "@/lib/api";

export type SortKey = "name" | "parent" | "size" | "date";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export type Comparator = (a: SearchHit, b: SearchHit) => number;

const collator = new Intl.Collator("de-DE", {
  numeric: true,
  sensitivity: "base",
});

const stamp = (hit: SearchHit, field: DateField): number =>
  (field === "modified" ? hit.modified : hit.created) ?? 0;

/**
 * Vergleicht zwei Treffer nach dem gewaehlten Schluessel; bei Gleichstand
 * entscheidet der Pfad. Der Tiebreak ist waehrend der laufenden Suche
 * entscheidend: ohne ihn wuerden gleichwertige Treffer aus spaeteren Batches
 * beliebig zwischen die bereits angezeigten rutschen und die Liste sichtbar
 * zappeln lassen.
 */
export function makeComparator(
  sort: SortState,
  dateField: DateField,
): Comparator {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "name":
      return (a, b) =>
        (collator.compare(a.name, b.name) ||
          collator.compare(a.path, b.path)) * dir;
    case "parent":
      return (a, b) =>
        (collator.compare(a.parent, b.parent) ||
          collator.compare(a.path, b.path)) * dir;
    case "size":
      return (a, b) =>
        (a.size - b.size || collator.compare(a.path, b.path)) * dir;
    case "date":
      return (a, b) =>
        (stamp(a, dateField) - stamp(b, dateField) ||
          collator.compare(a.path, b.path)) * dir;
  }
}

/**
 * Verschmilzt zwei bereits sortierte Listen zu einer neuen. Kostet `n + m`
 * Vergleiche statt einer kompletten Neusortierung — nur so bleibt das
 * Nachsortieren im 60-ms-Takt der Treffer-Batches bezahlbar.
 */
export function mergeSorted(
  a: SearchHit[],
  b: SearchHit[],
  cmp: Comparator,
): SearchHit[] {
  const out = new Array<SearchHit>(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    out[k++] = cmp(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Identitaet der sortierten Sicht; wechselt sie, muss neu sortiert werden.
 *  Das Datumsfeld zaehlt nur mit, wenn tatsaechlich danach sortiert wird. */
export function sortSignature(
  sort: SortState | null,
  dateField: DateField,
): string {
  if (!sort) return "";
  return sort.key === "date"
    ? `date:${sort.dir}:${dateField}`
    : `${sort.key}:${sort.dir}`;
}
