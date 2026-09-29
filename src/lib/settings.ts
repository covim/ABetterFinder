/** Einstellungen, die eine Sitzung ueberdauern. Der WebView haelt den
 *  localStorage pro Anwendung vor, ein eigenes Konfigurationsformat waere hier
 *  unnoetiger Aufwand. */

const ROOTS_KEY = "abf.roots";

/** Zuletzt bewusst gewaehlte Suchordner, oder `null` beim ersten Start. */
export function loadRoots(): string[] | null {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const roots = parsed.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    return roots.length > 0 ? roots : null;
  } catch {
    // Beschaedigter Eintrag: lieber mit dem Standard starten als scheitern.
    return null;
  }
}

export function saveRoots(roots: string[]): void {
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    // Kein Speicher verfuegbar — die Auswahl gilt dann nur fuer diese Sitzung.
  }
}
