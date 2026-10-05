import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FileText,
  Table,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Highlighted } from "@/components/Highlighted";
import { cn } from "@/lib/utils";
import { formatCount, formatDate, formatSize } from "@/lib/format";
import type { Highlighter, HighlightRange } from "@/lib/highlight";
import { buildTsv } from "@/lib/table";
import type { SortKey, SortState } from "@/lib/sort";
import type { UncResolver } from "@/lib/unc";
import {
  openContainingFolder,
  openPath,
  revealInExplorer,
  transferPaths,
  type MovedPath,
  type SearchHit,
  type TransferMode,
} from "@/lib/api";

/** Kompakte Zeilenhoehe; Kopf- und Trefferzeilen sind gleich hoch, damit die
 *  Virtualisierung ohne Hoehenmessung auskommt. */
const ROW_HEIGHT = 28;
const OVERSCAN = 12;

const folderCollator = new Intl.Collator("de-DE", {
  numeric: true,
  sensitivity: "base",
});

/** Stabile Referenz, damit `Highlighted` memoisiert bleibt. */
const NO_RANGES: HighlightRange[] = [];

type RowItem =
  | { kind: "group"; folder: string; count: number; collapsed: boolean }
  | { kind: "hit"; hit: SearchHit };

/** Identitaet einer Zeile (Fokus bzw. Anker). Der Index allein reicht nicht: seit die
 *  Sortierung auch waehrend der Suche greift, kann derselbe Index nach dem
 *  naechsten Treffer-Batch auf eine andere Datei zeigen. */
interface Selection {
  index: number;
  kind: "group" | "hit";
  /** Ordnerpfad bzw. Dateipfad — beides eindeutig. */
  id: string;
}

const rowId = (row: RowItem): string =>
  row.kind === "group" ? row.folder : row.hit.path;

const isSameRow = (row: RowItem, sel: Selection): boolean =>
  row.kind === sel.kind && rowId(row) === sel.id;

const toSelection = (index: number, row: RowItem): Selection => ({
  index,
  kind: row.kind,
  id: rowId(row),
});

interface ClickModifiers {
  /** Strg: einzeln hinzufuegen/entfernen. */
  toggle: boolean;
  /** Shift: Bereich ab dem Anker. */
  range: boolean;
}

const PLAIN_CLICK: ClickModifiers = { toggle: false, range: false };

const modifiersOf = (e: React.MouseEvent | React.KeyboardEvent): ClickModifiers => ({
  toggle: e.ctrlKey || e.metaKey,
  range: e.shiftKey,
});

interface ResultListProps {
  items: SearchHit[];
  /** Aendert sich bei jedem Treffer-Batch; `items` bleibt beim Streamen
   *  dieselbe Referenz, deshalb haengen die Memos zusaetzlich hieran. */
  version: number;
  dateField: "modified" | "created";
  groupByFolder: boolean;
  highlight: Highlighter;
  /** Ob der Ordnerpfad mitmarkiert wird — nur wenn im ganzen Pfad gesucht
   *  wurde, war er ueberhaupt am Treffer beteiligt. */
  highlightPath: boolean;
  sort: SortState | null;
  onSortChange: (sort: SortState | null) => void;
  onError: (message: string) => void;
  /** Kurze Erfolgsmeldung fuer die Statuszeile. */
  onNotice: (message: string) => void;
  /** Meldet verschobene Treffer, damit die Liste ihre Pfade nachzieht. */
  onMoved: (moved: MovedPath[], dest: string) => void;
  /** Macht beim Kopieren aus Netzlaufwerk-Pfaden die UNC-Form. */
  toUnc: UncResolver;
  emptyState: React.ReactNode;
}

export function ResultList({
  items,
  version,
  dateField,
  groupByFolder,
  highlight,
  highlightPath,
  sort,
  onSortChange,
  onError,
  onNotice,
  onMoved,
  toUnc,
  emptyState,
}: ResultListProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(600);
  /** Cursor fuer Pfeiltasten und Enter; darf auch ein Gruppenkopf sein. */
  const [focus, setFocus] = React.useState<Selection | null>(null);
  /** Startpunkt fuer Shift-Bereiche. */
  const [anchor, setAnchor] = React.useState<Selection | null>(null);
  /** Markierte Treffer, ueber den Pfad — bleibt so beim Umsortieren und
   *  waehrend neue Treffer einstroemen stabil. */
  const [marked, setMarked] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [contextTarget, setContextTarget] = React.useState<RowItem | null>(null);

  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Bei leerer Ergebnismenge (neue Suche) alles zuruecksetzen.
  const itemCount = items.length;
  React.useEffect(() => {
    if (itemCount === 0) {
      viewportRef.current?.scrollTo({ top: 0 });
      setScrollTop(0);
      setFocus(null);
      setAnchor(null);
      setMarked(new Set());
      setCollapsed(new Set());
    }
  }, [itemCount]);

  const grouped = React.useMemo(
    () => (groupByFolder ? buildGroups(items, collapsed, sort) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, version, groupByFolder, collapsed, sort],
  );

  const rowCount = grouped ? grouped.length : itemCount;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  // Nur das sichtbare Fenster wird materialisiert.
  const visible: RowItem[] = React.useMemo(
    () =>
      grouped
        ? grouped.slice(first, last)
        : items.slice(first, last).map((hit) => ({ kind: "hit" as const, hit })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grouped, items, version, first, last],
  );

  const rowAt = React.useCallback(
    (index: number): RowItem | null => {
      if (index < 0 || index >= rowCount) return null;
      if (grouped) return grouped[index];
      return { kind: "hit", hit: items[index] };
    },
    [grouped, items, rowCount],
  );

  // Fokus und Anker haengen am Zeilenschluessel; nach jeder Umsortierung
  // wird ihr Index einmal linear nachgezogen. Ein reiner Stringvergleich ueber
  // die Zeilen ist selbst bei 50 000 Treffern im Millisekundenbereich.
  const findRowIndex = React.useCallback(
    (sel: Selection | null): number | null => {
      if (!sel) return null;
      const atIndex = rowAt(sel.index);
      if (atIndex && isSameRow(atIndex, sel)) return sel.index;
      if (grouped) {
        for (let i = 0; i < grouped.length; i++) {
          if (isSameRow(grouped[i], sel)) return i;
        }
        return null;
      }
      if (sel.kind !== "hit") return null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].path === sel.id) return i;
      }
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grouped, items, version, rowAt],
  );

  const focusIndex = React.useMemo(
    () => findRowIndex(focus),
    [focus, findRowIndex],
  );

  /** Pfade aller Trefferzeilen zwischen zwei Zeilen (inklusive). */
  const pathsBetween = React.useCallback(
    (from: number, to: number): string[] => {
      const out: string[] = [];
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        const row = rowAt(i);
        if (row?.kind === "hit") out.push(row.hit.path);
      }
      return out;
    },
    [rowAt],
  );

  /** Explorer-Logik: Klick waehlt allein, Strg toggelt, Shift erweitert ab
   *  dem Anker. Gilt fuer Maus und Pfeiltasten gleichermassen. */
  const pickRow = (index: number, row: RowItem, mods: ClickModifiers) => {
    const sel = toSelection(index, row);
    setFocus(sel);

    if (mods.range) {
      const from = findRowIndex(anchor);
      const range = pathsBetween(from ?? index, index);
      setMarked((prev) => {
        const next = mods.toggle ? new Set(prev) : new Set<string>();
        for (const path of range) next.add(path);
        return next;
      });
      if (from === null) setAnchor(sel);
      return;
    }

    setAnchor(sel);
    if (row.kind === "group") {
      if (!mods.toggle) {
        setMarked(new Set());
        return;
      }
      // Strg auf dem Gruppenkopf: den ganzen Ordner an- bzw. abwaehlen.
      const folderPaths = items
        .filter((h) => h.parent === row.folder)
        .map((h) => h.path);
      setMarked((prev) => {
        const next = new Set(prev);
        if (folderPaths.every((p) => next.has(p))) {
          for (const p of folderPaths) next.delete(p);
        } else {
          for (const p of folderPaths) next.add(p);
        }
        return next;
      });
      return;
    }

    const path = row.hit.path;
    if (mods.toggle) {
      setMarked((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      });
    } else {
      setMarked(new Set([path]));
    }
  };

  const onRowMouseDown = (
    e: React.MouseEvent,
    index: number,
    row: RowItem,
  ) => {
    // Rechtsklick regelt `onRowContextMenu`, damit eine Mehrfachauswahl
    // dabei erhalten bleibt.
    if (e.button !== 0) return;
    const mods = modifiersOf(e);
    if (mods.range || mods.toggle) {
      // Sonst zieht Shift+Klick eine Textmarkierung ueber die Zeilen.
      e.preventDefault();
      viewportRef.current?.focus();
    }
    pickRow(index, row, mods);
  };

  const toggleGroup = React.useCallback(
    (folder: string) => {
      // Beim Einklappen fallen die Treffer aus der Auswahl: sonst wuerden
      // unsichtbare Dateien mitverschoben.
      if (!collapsed.has(folder)) {
        setMarked((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          for (const hit of items) {
            if (hit.parent === folder) next.delete(hit.path);
          }
          return next;
        });
      }
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(folder)) next.add(folder);
        return next;
      });
    },
    [collapsed, items],
  );

  const run = React.useCallback(
    (action: (path: string) => Promise<void>, path: string) => {
      action(path).catch((e) => onError(String(e)));
    },
    [onError],
  );

  const copyPath = React.useCallback(
    (path: string) => {
      const text = toUnc(path);
      navigator.clipboard
        .writeText(text)
        // Der Hinweis macht sichtbar, dass statt `Z:\...` die Freigabe im
        // Puffer liegt — sonst wirkt der abweichende Pfad wie ein Fehler.
        .then(() => onNotice(text === path ? "Pfad kopiert" : "UNC-Pfad kopiert"))
        .catch(() => onError("Pfad konnte nicht kopiert werden."));
    },
    [onError, onNotice, toUnc],
  );

  // Sichtbare Treffer in Anzeigereihenfolge: eingeklappte Gruppen sind nicht
  // dabei. Grundlage fuer "Mit Kopfzeile kopieren" und Strg+A.
  const visibleHits = React.useMemo(() => {
    if (!grouped) return items;
    const hits: SearchHit[] = [];
    for (const row of grouped) if (row.kind === "hit") hits.push(row.hit);
    return hits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, items, version]);

  const exportCount = grouped ? visibleHits.length : itemCount;

  const copyWithHeaders = React.useCallback(() => {
    navigator.clipboard
      .writeText(buildTsv(visibleHits, dateField, toUnc))
      .then(() => onNotice(`${formatCount(visibleHits.length)} Zeilen kopiert`))
      .catch(() => onError("Tabelle konnte nicht kopiert werden."));
  }, [visibleHits, dateField, onError, onNotice, toUnc]);

  // Markierte Treffer, die es in der Liste noch gibt — in Anzeigereihenfolge.
  const markedHits = React.useMemo(
    () => (marked.size === 0 ? [] : items.filter((h) => marked.has(h.path))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, version, marked],
  );

  const transferringRef = React.useRef(false);
  const transfer = async (mode: TransferMode) => {
    const hits = markedHits;
    if (hits.length === 0 || transferringRef.current) return;
    transferringRef.current = true;

    const what =
      hits.length === 1
        ? `„${hits[0].name}“`
        : `${formatCount(hits.length)} Einträge`;
    try {
      const dest = await open({
        directory: true,
        multiple: false,
        defaultPath: hits[0].parent,
        title: `${what} ${mode === "move" ? "verschieben" : "kopieren"} nach …`,
      });
      if (typeof dest !== "string") return;

      const result = await transferPaths(
        hits.map((h) => h.path),
        dest,
        mode,
      );

      if (mode === "copy") {
        onNotice(result.aborted ? "Kopieren abgebrochen" : `${what} kopiert`);
        return;
      }

      onMoved(result.moved, dest);
      // Auswahl und Fokus wandern mit an den neuen Ort.
      const renamed = new Map(result.moved.map((m) => [m.from, m.to]));
      const follow = (sel: Selection | null) =>
        sel?.kind === "hit" && renamed.has(sel.id)
          ? { ...sel, id: renamed.get(sel.id)! }
          : sel;
      setMarked((prev) => new Set([...prev].map((p) => renamed.get(p) ?? p)));
      setFocus(follow);
      setAnchor(follow);

      const n = result.moved.length;
      if (result.aborted) {
        onNotice(`Verschieben abgebrochen – ${formatCount(n)} verschoben`);
      } else if (n === hits.length) {
        onNotice(`${what} verschoben`);
      } else {
        onNotice(`${formatCount(n)} von ${formatCount(hits.length)} verschoben`);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      transferringRef.current = false;
      viewportRef.current?.focus();
    }
  };

  const toggleSort = (key: SortKey) => {
    if (!sort || sort.key !== key) onSortChange({ key, dir: "asc" });
    else if (sort.dir === "asc") onSortChange({ key, dir: "desc" });
    else onSortChange(null);
  };

  const scrollRowIntoView = (index: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTo({ top });
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: top - el.clientHeight + ROW_HEIGHT });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (rowCount === 0) return;

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        setMarked(new Set(visibleHits.map((h) => h.path)));
        return;
      }
      if (key === "x" || key === "c") {
        event.preventDefault();
        void transfer(key === "x" ? "move" : "copy");
        return;
      }
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        focusIndex === null
          ? first
          : Math.min(
              rowCount - 1,
              Math.max(0, focusIndex + (event.key === "ArrowDown" ? 1 : -1)),
            );
      const row = rowAt(next);
      if (!row) return;
      // Beim Pfeil zaehlt nur Shift; Strg+Pfeil soll nicht toggeln.
      pickRow(next, row, { toggle: false, range: event.shiftKey });
      scrollRowIntoView(next);
      return;
    }
    if (focusIndex === null) return;
    const row = rowAt(focusIndex);
    if (!row) return;

    if (event.key === "Enter") {
      event.preventDefault();
      if (row.kind === "hit") run(openPath, row.hit.path);
      else toggleGroup(row.folder);
    } else if (row.kind === "group") {
      if (event.key === "ArrowRight" && row.collapsed) toggleGroup(row.folder);
      else if (event.key === "ArrowLeft" && !row.collapsed) toggleGroup(row.folder);
    }
  };

  const onRowContextMenu = (index: number, row: RowItem) => {
    // Rechtsklick in eine bestehende Auswahl laesst sie stehen, ausserhalb
    // waehlt er die Zeile allein — wie im Explorer.
    if (row.kind === "hit" && marked.has(row.hit.path)) {
      setFocus(toSelection(index, row));
    } else {
      pickRow(index, row, PLAIN_CLICK);
    }
    setContextTarget(row);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          // Capture-Phase: laeuft vor den Zeilen-Handlern. Trifft der Rechts-
          // klick eine Zeile, ueberschreibt diese das Ziel gleich wieder.
          onContextMenuCapture={() => setContextTarget(null)}
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
        >
          <ResultHeader
            sort={sort}
            onToggle={toggleSort}
            dateField={dateField}
            showPathColumn={!groupByFolder}
          />

          <div
            ref={viewportRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            className="relative min-h-0 flex-1 overflow-y-auto outline-none"
          >
            {rowCount === 0 ? (
              <div className="flex h-full items-center justify-center p-8">
                {emptyState}
              </div>
            ) : (
              <div style={{ height: rowCount * ROW_HEIGHT }} className="relative">
                <div
                  style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
                  className="absolute inset-x-0 top-0"
                >
                  {visible.map((row, index) =>
                    row.kind === "group" ? (
                      <GroupRow
                        key={`g:${row.folder}`}
                        folder={row.folder}
                        count={row.count}
                        collapsed={row.collapsed}
                        focused={focusIndex === first + index}
                        highlight={highlightPath ? highlight : null}
                        onMouseDown={(e) => onRowMouseDown(e, first + index, row)}
                        onContextMenu={() => onRowContextMenu(first + index, row)}
                        onToggle={() => toggleGroup(row.folder)}
                        onOpenFolder={() => run(openContainingFolder, row.folder)}
                      />
                    ) : (
                      <HitRow
                        key={`h:${row.hit.path}`}
                        hit={row.hit}
                        dateField={dateField}
                        indented={groupByFolder}
                        showPath={!groupByFolder}
                        highlight={highlight}
                        pathHighlight={highlightPath ? highlight : null}
                        marked={marked.has(row.hit.path)}
                        focused={focusIndex === first + index}
                        onMouseDown={(e) => onRowMouseDown(e, first + index, row)}
                        onContextMenu={() => onRowContextMenu(first + index, row)}
                        onReveal={() => run(revealInExplorer, row.hit.path)}
                        onOpenFolder={() => run(openContainingFolder, row.hit.path)}
                        onOpen={() => run(openPath, row.hit.path)}
                        onCopy={() => copyPath(row.hit.path)}
                      />
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        // Fokus zurueck in die Liste, damit die Pfeiltasten sofort
        // weiterfunktionieren.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          viewportRef.current?.focus();
        }}
      >
        {contextTarget?.kind !== "group" && markedHits.length > 0 && (
          <>
            <ContextMenuItem onSelect={() => void transfer("move")}>
              <FolderInput />
              {markedHits.length === 1
                ? "Verschieben nach …"
                : `${formatCount(markedHits.length)} Einträge verschieben nach …`}
              <Shortcut>Strg+X</Shortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void transfer("copy")}>
              <CopyPlus />
              {markedHits.length === 1
                ? "Kopieren nach …"
                : `${formatCount(markedHits.length)} Einträge kopieren nach …`}
              <Shortcut>Strg+C</Shortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        {contextTarget?.kind === "hit" && (
          <>
            <ContextMenuItem onSelect={() => run(openPath, contextTarget.hit.path)}>
              <ExternalLink />
              Mit Standardprogramm öffnen
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => run(revealInExplorer, contextTarget.hit.path)}
            >
              <FolderOpen />
              Im Explorer anzeigen
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => run(openContainingFolder, contextTarget.hit.path)}
            >
              <Folder />
              Enthaltenden Ordner öffnen
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copyPath(contextTarget.hit.path)}>
              <Copy />
              Pfad kopieren
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        {contextTarget?.kind === "group" && (
          <>
            <ContextMenuItem
              onSelect={() => run(openContainingFolder, contextTarget.folder)}
            >
              <FolderOpen />
              Ordner im Explorer öffnen
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copyPath(contextTarget.folder)}>
              <Copy />
              Pfad kopieren
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        <ContextMenuItem disabled={exportCount === 0} onSelect={copyWithHeaders}>
          <Table />
          Mit Kopfzeile kopieren ({formatCount(exportCount)} Zeilen)
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Shortcut({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Baut die flache Zeilenliste aus Gruppenkoepfen und Treffern. Innerhalb einer
 * Gruppe bleibt die Reihenfolge von `items` erhalten, die Ordner selbst werden
 * alphabetisch sortiert (absteigend, wenn nach Name oder Ordner absteigend
 * sortiert wird).
 */
function buildGroups(
  items: SearchHit[],
  collapsed: ReadonlySet<string>,
  sort: SortState | null,
): RowItem[] {
  const byFolder = new Map<string, SearchHit[]>();
  for (const hit of items) {
    const bucket = byFolder.get(hit.parent);
    if (bucket) bucket.push(hit);
    else byFolder.set(hit.parent, [hit]);
  }

  const direction =
    sort?.dir === "desc" && (sort.key === "parent" || sort.key === "name")
      ? -1
      : 1;
  const folders = [...byFolder.keys()].sort(
    (a, b) => folderCollator.compare(a, b) * direction,
  );

  const rows: RowItem[] = [];
  for (const folder of folders) {
    const hits = byFolder.get(folder)!;
    const isCollapsed = collapsed.has(folder);
    rows.push({
      kind: "group",
      folder,
      count: hits.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const hit of hits) rows.push({ kind: "hit", hit });
    }
  }
  return rows;
}

function ResultHeader({
  sort,
  onToggle,
  dateField,
  showPathColumn,
}: {
  sort: SortState | null;
  onToggle: (key: SortKey) => void;
  dateField: "modified" | "created";
  showPathColumn: boolean;
}) {
  const cell = (key: SortKey, label: string, className: string) => (
    <button
      type="button"
      onClick={() => onToggle(key)}
      className={cn(
        "flex items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {sort?.key === key &&
        (sort.dir === "asc" ? (
          <ArrowUp className="h-3 w-3 shrink-0" />
        ) : (
          <ArrowDown className="h-3 w-3 shrink-0" />
        ))}
    </button>
  );

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b bg-muted/40 px-2">
      {cell("name", "Name", "min-w-0 flex-[3]")}
      {showPathColumn && cell("parent", "Ordner", "min-w-0 flex-[4]")}
      {cell("size", "Größe", "w-16 justify-end")}
      {cell(
        "date",
        dateField === "modified" ? "Geändert" : "Erstellt",
        "w-28 justify-end",
      )}
      <div className="w-[108px] shrink-0" />
    </div>
  );
}

const GroupRow = React.memo(function GroupRow({
  folder,
  count,
  collapsed,
  focused,
  highlight,
  onMouseDown,
  onContextMenu,
  onToggle,
  onOpenFolder,
}: {
  folder: string;
  count: number;
  collapsed: boolean;
  focused: boolean;
  highlight: Highlighter | null;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: () => void;
  onToggle: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      // Strg/Shift-Klick waehlt den Ordnerinhalt bzw. einen Bereich und soll
      // die Gruppe dabei nicht auf- oder zuklappen.
      onClick={(e) => {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onToggle();
      }}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 border-b border-border/40 bg-muted/50 px-2 text-[13px]",
        focused && "bg-primary/30 shadow-[inset_3px_0_0_var(--color-primary)]",
      )}
    >
      {collapsed ? (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate font-medium" title={folder}>
        <Highlighted
          text={folder}
          ranges={highlight ? highlight(folder) : NO_RANGES}
        />
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatCount(count)}
      </span>
      <div className="w-[108px] shrink-0 text-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                onOpenFolder();
              }}
              aria-label="Ordner im Explorer öffnen"
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ordner im Explorer öffnen</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});

interface HitRowProps {
  hit: SearchHit;
  dateField: "modified" | "created";
  indented: boolean;
  showPath: boolean;
  highlight: Highlighter;
  pathHighlight: Highlighter | null;
  /** Teil der Mehrfachauswahl. */
  marked: boolean;
  /** Tastatur-Cursor. */
  focused: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: () => void;
  onReveal: () => void;
  onOpenFolder: () => void;
  onOpen: () => void;
  onCopy: () => void;
}

const HitRow = React.memo(function HitRow({
  hit,
  dateField,
  indented,
  showPath,
  highlight,
  pathHighlight,
  marked,
  focused,
  onMouseDown,
  onContextMenu,
  onReveal,
  onOpenFolder,
  onOpen,
  onCopy,
}: HitRowProps) {
  const stamp = dateField === "modified" ? hit.modified : hit.created;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "flex items-center gap-2 border-b border-border/30 px-2 text-[13px] transition-colors",
        indented && "pl-7",
        marked
          ? "bg-primary/30 shadow-[inset_3px_0_0_var(--color-primary)]"
          : "hover:bg-accent/60",
        // Der Cursor faellt nur auf, wo er nicht ohnehin markiert ist, etwa
        // nach Strg+Klick auf eine schon markierte Zeile.
        focused && !marked && "ring-1 ring-inset ring-primary/70",
      )}
    >
      <div className="flex min-w-0 flex-[3] items-center gap-1.5">
        {hit.isDir ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="selectable truncate" title={hit.name}>
          <Highlighted text={hit.name} ranges={highlight(hit.name)} />
        </span>
      </div>

      {showPath && (
        <span
          className="min-w-0 flex-[4] truncate text-xs text-muted-foreground"
          title={hit.parent}
        >
          <Highlighted
            text={hit.parent}
            ranges={pathHighlight ? pathHighlight(hit.parent) : NO_RANGES}
          />
        </span>
      )}

      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatSize(hit.size, hit.isDir)}
      </span>
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatDate(stamp)}
      </span>

      <div className="flex w-[108px] shrink-0 items-center justify-end gap-0.5">
        {/* Fester Explorer-Button: immer sichtbar, nicht nur beim Hover. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon-xs"
              onClick={(e) => {
                stop(e);
                onReveal();
              }}
              onDoubleClick={stop}
              aria-label="Im Explorer anzeigen"
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Im Explorer anzeigen (markiert)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                stop(e);
                onOpenFolder();
              }}
              onDoubleClick={stop}
              aria-label="Ordner öffnen"
            >
              <Folder />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Enthaltenden Ordner öffnen</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                stop(e);
                onOpen();
              }}
              onDoubleClick={stop}
              aria-label="Öffnen"
            >
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Mit Standardprogramm öffnen</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                stop(e);
                onCopy();
              }}
              onDoubleClick={stop}
              aria-label="Pfad kopieren"
            >
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Pfad kopieren</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});
