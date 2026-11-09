/** Vergleichsform eines Pfades: einheitliche Trenner, ohne abschliessenden
 *  Trenner, ohne Gross-/Kleinschreibung (Windows). */
const normalize = (path: string): string =>
  path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Bezeichnen beide Pfade denselben Ort? */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Ist `path` ein Laufwerkswurzel wie `C:\`? */
export function isDriveRoot(path: string): boolean {
  return /^[a-z]:$/.test(normalize(path));
}

/** Liegt `path` in einem der Ordner `roots` (oder ist selbst einer)? */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
  const p = normalize(path);
  return roots.some((root) => {
    const r = normalize(root);
    return p === r || p.startsWith(`${r}\\`);
  });
}
