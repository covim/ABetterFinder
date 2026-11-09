import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, HardDrive, History, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { filterExistingPaths, listDrives, type DriveInfo } from "@/lib/api";
import { samePath } from "@/lib/paths";
import { loadRecentRoots, pushRecent, saveRecentRoots } from "@/lib/settings";
import { cn } from "@/lib/utils";

interface RootPickerProps {
  roots: string[];
  onChange: (roots: string[]) => void;
  onError: (message: string) => void;
}

export function RootPicker({ roots, onChange, onError }: RootPickerProps) {
  const [drives, setDrives] = React.useState<DriveInfo[]>([]);
  const [recent, setRecent] = React.useState<string[]>(loadRecentRoots);

  React.useEffect(() => {
    listDrives()
      .then(setDrives)
      .catch(() => onError("Laufwerke konnten nicht gelesen werden."));
  }, [onError]);

  const updateRecent = (next: string[]) => {
    setRecent(next);
    saveRecentRoots(next);
  };

  const remember = (paths: string[]) => updateRecent(pushRecent(recent, paths));

  const add = (paths: string[]) => {
    const merged = [...roots];
    for (const path of paths) {
      if (!merged.some((r) => samePath(r, path))) {
        merged.push(path);
      }
    }
    onChange(merged);
  };

  const remove = (path: string) =>
    onChange(roots.filter((r) => !samePath(r, path)));

  /** Ersetzt einen Suchort an seiner Stelle. Gibt es das Ziel schon, faellt
   *  der alte Eintrag einfach weg, statt doppelt zu stehen. */
  const replace = (old: string, next: string) => {
    const duplicate = roots.some((r) => r !== old && samePath(r, next));
    onChange(
      duplicate
        ? roots.filter((r) => r !== old)
        : roots.map((r) => (r === old ? next : r)),
    );
    remember([next]);
  };

  const pickFolders = async () => {
    try {
      const picked = await open({ directory: true, multiple: true });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      add(paths);
      remember(paths);
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {roots.map((root) => (
        <RootChip
          key={root}
          root={root}
          onReplace={(next) => replace(root, next)}
          onRemove={() => onChange(roots.filter((r) => r !== root))}
          onError={onError}
        />
      ))}

      <Button variant="outline" size="sm" onClick={pickFolders}>
        <Plus />
        Ordner
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={recent.length === 0}>
            <History />
            Zuletzt
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[440px] max-w-[calc(100vw-2rem)]">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Zuletzt verwendete Ordner
          </div>
          {recent.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              Keine Einträge.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {recent.map((path) => {
                const active = roots.some((r) => samePath(r, path));
                return (
                  <li
                    key={path}
                    className="flex items-center rounded-sm hover:bg-accent"
                  >
                    <button
                      type="button"
                      title={path}
                      onClick={() => {
                        if (active) {
                          remove(path);
                        } else {
                          add([path]);
                          remember([path]);
                        }
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          active ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{path}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${path} aus der Liste entfernen`}
                      title="Aus der Liste entfernen"
                      onClick={() =>
                        updateRecent(recent.filter((r) => r !== path))
                      }
                      className="mr-1 shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </PopoverContent>
      </Popover>

      {drives.map((drive) => {
        const active = roots.some((r) => samePath(r, drive.path));
        return (
          <Button
            key={drive.path}
            variant={active ? "secondary" : "ghost"}
            size="sm"
            className="px-2"
            onClick={() => (active ? remove(drive.path) : add([drive.path]))}
          >
            <HardDrive />
            {drive.label}
          </Button>
        );
      })}
    </div>
  );
}

interface RootChipProps {
  root: string;
  onReplace: (next: string) => void;
  onRemove: () => void;
  onError: (message: string) => void;
}

/** Ein Suchort als Chip. Ein Klick auf den Pfad macht ihn editierbar: von
 *  Hand eintippen oder per Dialog neu waehlen. */
function RootChip({ root, onReplace, onRemove, onError }: RootChipProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(root);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Laeuft gerade eine Pruefung oder ist der Dialog offen? Dann darf der
   *  Blur — der auch beim Wechsel in den Dialog feuert — nicht uebernehmen. */
  const busyRef = React.useRef(false);
  /** Spiegelt `editing` synchron: auch beim Schliessen verliert das Feld den
   *  Fokus, und dieser Blur darf nicht noch einmal uebernehmen. */
  const editingRef = React.useRef(false);

  const startEditing = () => {
    setDraft(root);
    editingRef.current = true;
    setEditing(true);
  };

  const close = () => {
    editingRef.current = false;
    setEditing(false);
  };

  /** `keepOpen`: bei ungueltiger Eingabe weiter editieren (Enter) statt zu
   *  verwerfen (Fokus verlassen). */
  const commit = async (keepOpen: boolean) => {
    if (busyRef.current || !editingRef.current) return;
    const next = draft.trim();
    if (next === "" || next === root) {
      close();
      return;
    }
    busyRef.current = true;
    try {
      const [found] = await filterExistingPaths([next]);
      if (found) {
        close();
        onReplace(found);
      } else {
        onError(`Ordner nicht gefunden: ${next}`);
        if (!keepOpen) close();
      }
    } catch (e) {
      onError(String(e));
    } finally {
      busyRef.current = false;
    }
  };

  const browse = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const picked = await open({ directory: true, defaultPath: root });
      if (typeof picked === "string") {
        close();
        if (!samePath(picked, root)) onReplace(picked);
      } else {
        inputRef.current?.focus();
      }
    } catch (e) {
      onError(String(e));
    } finally {
      busyRef.current = false;
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-0.5">
        <Input
          ref={inputRef}
          autoFocus
          value={draft}
          aria-label="Ordnerpfad"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(true);
            } else if (e.key === "Escape") {
              // Sonst bricht der globale Esc-Handler zusaetzlich die Suche ab.
              e.stopPropagation();
              close();
            }
          }}
          className="h-7 w-[320px] px-2 text-xs"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Ordner wählen"
          title="Ordner wählen"
          // Verhindert den Blur des Eingabefelds vor dem Klick.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void browse()}
        >
          <FolderOpen />
        </Button>
      </div>
    );
  }

  return (
    <Badge variant="outline" className="h-7 gap-1 pl-2 pr-1">
      <button
        type="button"
        title={`${root} — zum Bearbeiten klicken`}
        onClick={startEditing}
        className="max-w-[240px] truncate rounded-sm hover:underline"
      >
        {root}
      </button>
      <button
        type="button"
        aria-label={`${root} neu wählen`}
        title="Ordner neu wählen"
        onClick={() => void browse()}
        className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderOpen className="h-3 w-3" />
      </button>
      <button
        type="button"
        aria-label={`${root} entfernen`}
        onClick={onRemove}
        className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
