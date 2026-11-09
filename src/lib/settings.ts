/** Einstellungen, die eine Sitzung ueberdauern. Der WebView haelt den
 *  localStorage pro Anwendung vor, ein eigenes Konfigurationsformat waere hier
 *  unnoetiger Aufwand. */

import { isDriveRoot, samePath } from "@/lib/paths";

const ROOTS_KEY = "abf.roots";
const RECENT_KEY = "abf.recentRoots";

/** So viele zuletzt verwendete Ordner merkt sich die Auswahl. */
export const RECENT_LIMIT = 20;

/** Liest eine gespeicherte Pfadliste; `null` bei fehlendem oder beschaedigtem
 *  Eintrag. */
function loadPaths(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  } catch {
    // Beschaedigter Eintrag: lieber mit dem Standard starten als scheitern.
    return null;
  }
}

function savePaths(key: string, paths: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(paths));
  } catch {
    // Kein Speicher verfuegbar — die Auswahl gilt dann nur fuer diese Sitzung.
  }
}

/** Zuletzt bewusst gewaehlte Suchordner, oder `null` beim ersten Start. */
export function loadRoots(): string[] | null {
  const roots = loadPaths(ROOTS_KEY);
  return roots && roots.length > 0 ? roots : null;
}

export function saveRoots(roots: string[]): void {
  savePaths(ROOTS_KEY, roots);
}

/** Zuletzt verwendete Ordner, der juengste zuerst. */
export function loadRecentRoots(): string[] {
  return (loadPaths(RECENT_KEY) ?? []).slice(0, RECENT_LIMIT);
}

export function saveRecentRoots(recent: string[]): void {
  savePaths(RECENT_KEY, recent);
}

/** Stellt `paths` an den Anfang der Liste, ohne Doppelte und gekappt auf
 *  `RECENT_LIMIT`. Laufwerke bleiben draussen — sie haben eigene Buttons. */
export function pushRecent(recent: string[], paths: string[]): string[] {
  const fresh = paths.filter((p) => !isDriveRoot(p));
  if (fresh.length === 0) return recent;
  const merged: string[] = [];
  for (const path of [...fresh, ...recent]) {
    if (!merged.some((m) => samePath(m, path))) merged.push(path);
  }
  return merged.slice(0, RECENT_LIMIT);
}
