import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HardDrive, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listDrives, type DriveInfo } from "@/lib/api";

interface RootPickerProps {
  roots: string[];
  onChange: (roots: string[]) => void;
  onError: (message: string) => void;
}

export function RootPicker({ roots, onChange, onError }: RootPickerProps) {
  const [drives, setDrives] = React.useState<DriveInfo[]>([]);

  React.useEffect(() => {
    listDrives()
      .then(setDrives)
      .catch(() => onError("Laufwerke konnten nicht gelesen werden."));
  }, [onError]);

  const add = (paths: string[]) => {
    const merged = [...roots];
    for (const path of paths) {
      if (!merged.some((r) => r.toLowerCase() === path.toLowerCase())) {
        merged.push(path);
      }
    }
    onChange(merged);
  };

  const pickFolders = async () => {
    try {
      const picked = await open({ directory: true, multiple: true });
      if (!picked) return;
      add(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {roots.map((root) => (
        <Badge key={root} variant="outline" className="h-7 gap-1 pl-2 pr-1">
          <span className="max-w-[240px] truncate" title={root}>
            {root}
          </span>
          <button
            type="button"
            aria-label={`${root} entfernen`}
            onClick={() => onChange(roots.filter((r) => r !== root))}
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      <Button variant="outline" size="sm" onClick={pickFolders}>
        <Plus />
        Ordner
      </Button>

      {drives.map((drive) => {
        const active = roots.some(
          (r) => r.toLowerCase() === drive.path.toLowerCase(),
        );
        return (
          <Button
            key={drive.path}
            variant={active ? "secondary" : "ghost"}
            size="sm"
            className="px-2"
            onClick={() =>
              active
                ? onChange(
                    roots.filter(
                      (r) => r.toLowerCase() !== drive.path.toLowerCase(),
                    ),
                  )
                : add([drive.path])
            }
          >
            <HardDrive />
            {drive.label}
          </Button>
        );
      })}
    </div>
  );
}
