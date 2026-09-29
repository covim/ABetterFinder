import type { DriveMapping } from "@/lib/api";

/** Bildet einen Pfad auf seine netzwerkweit gueltige Form ab. */
export type UncResolver = (path: string) => string;

/** Fallback, solange keine Netzlaufwerke bekannt sind. */
export const KEEP_PATH: UncResolver = (path) => path;

/**
 * Ersetzt den Laufwerksbuchstaben gemappter Netzlaufwerke durch die zugehoerige
 * Freigabe: aus `Z:\Projekte\x.docx` wird `\\server\share\Projekte\x.docx`.
 *
 * Lokale Laufwerke bleiben unveraendert — ihr Admin-Share (`\\PC\c$`) waere
 * fuer andere ohnehin nur mit Administratorrechten erreichbar.
 */
export function createUncResolver(mappings: DriveMapping[]): UncResolver {
  if (mappings.length === 0) return KEEP_PATH;

  const byLetter = new Map<string, string>();
  for (const m of mappings) byLetter.set(m.letter.toUpperCase(), m.unc);

  return (path) => {
    // Nur die Form `X:` am Anfang wird ersetzt; UNC-Pfade, die schon als
    // solche gefunden wurden, laufen unveraendert durch.
    if (path.length < 2 || path[1] !== ":") return path;
    const unc = byLetter.get(path.slice(0, 2).toUpperCase());
    return unc ? unc + path.slice(2) : path;
  };
}
