import * as React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Moon, Search, Square, Sun, X } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Theme } from "@/lib/settings";
import { cn } from "@/lib/utils";

/** Eigene Titelleiste: Windows laesst in der nativen keine zusaetzlichen
 *  Buttons zu, der Theme-Schalter soll aber direkt neben den Fenster-Buttons
 *  sitzen. Ziehen und Doppelklick-Maximieren uebernimmt Tauri ueber
 *  `data-tauri-drag-region`. */
export function TitleBar({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      win
        .isMaximized()
        .then((m) => {
          if (!disposed) setMaximized(m);
        })
        .catch(() => undefined);
    };
    sync();
    win
      .onResized(sync)
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const run = (action: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    try {
      action(getCurrentWindow()).catch(() => undefined);
    } catch {
      // Ausserhalb von Tauri gibt es kein Fenster.
    }
  };

  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  const themeLabel = nextTheme === "light" ? "Heller Modus" : "Dunkler Modus";

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-stretch bg-background"
    >
      <div className="pointer-events-none flex items-center gap-2 pl-3 text-xs text-muted-foreground">
        <Search className="h-3.5 w-3.5 text-primary" />
        A Better Finder
      </div>

      <div className="ml-auto flex items-stretch">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={themeLabel}
              onClick={() => onThemeChange(nextTheme)}
              className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{themeLabel}</TooltipContent>
        </Tooltip>

        <div className="my-2.5 w-px bg-border" />

        <WindowButton label="Minimieren" onClick={() => run((w) => w.minimize())}>
          <Minus className="h-4 w-4" />
        </WindowButton>
        <WindowButton
          label={maximized ? "Verkleinern" : "Maximieren"}
          onClick={() => run((w) => w.toggleMaximize())}
        >
          {maximized ? (
            <Copy className="h-3.5 w-3.5 -scale-x-100" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </WindowButton>
        <WindowButton
          label="Schließen"
          onClick={() => run((w) => w.close())}
          className="hover:bg-[#c42b1c] hover:text-white"
        >
          <X className="h-4 w-4" />
        </WindowButton>
      </div>
    </div>
  );
}

function WindowButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
