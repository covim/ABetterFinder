import type { DateField, SearchHit } from "@/lib/api";
import { toIsoLocal } from "@/lib/format";
import type { UncResolver } from "@/lib/unc";

/** Spaltenueberschriften wie in der Ergebnisliste, plus der volle Pfad. */
export function tableHeaders(dateField: DateField): string[] {
  return [
    "Name",
    "Ordner",
    "Größe",
    dateField === "modified" ? "Geändert" : "Erstellt",
    "Pfad",
  ];
}

/**
 * Baut die komplette Trefferliste als TSV inklusive Kopfzeile. Bewusst
 * Rohwerte: Groesse in Bytes, Datum als sortierbare ISO-Form — so kann Excel
 * damit rechnen und sortieren.
 *
 * `toUnc` macht aus Pfaden auf gemappten Netzlaufwerken die UNC-Form, damit
 * die Tabelle auch bei Kollegen mit anderen Laufwerksbuchstaben funktioniert.
 *
 * Escaping ist nicht noetig, weil Windows weder Tabulatoren noch
 * Zeilenumbrueche in Datei- und Ordnernamen erlaubt.
 */
export function buildTsv(
  hits: SearchHit[],
  dateField: DateField,
  toUnc: UncResolver,
): string {
  const lines = new Array<string>(hits.length + 1);
  lines[0] = tableHeaders(dateField).join("\t");
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    lines[i + 1] = [
      hit.name,
      toUnc(hit.parent),
      // Ordner haben keine sinnvolle Groesse; die Spalte bleibt leer wie in
      // der Anzeige.
      hit.isDir ? "" : String(hit.size),
      toIsoLocal(dateField === "modified" ? hit.modified : hit.created),
      toUnc(hit.path),
    ].join("\t");
  }
  // CRLF, damit Excel und Notepad die Zeilen sauber trennen.
  return lines.join("\r\n");
}
