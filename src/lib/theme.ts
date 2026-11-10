import { getCurrentWindow } from "@tauri-apps/api/window";

import type { Theme } from "@/lib/settings";

/** Schaltet die CSS-Variablen um und zieht das native Fenster (Rahmen,
 *  Schatten, Systemdialoge) mit. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    getCurrentWindow()
      .setTheme(theme)
      .catch(() => undefined);
  } catch {
    // Ausserhalb von Tauri (reiner Vite-Server) gibt es kein Fenster.
  }
}
