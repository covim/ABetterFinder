import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Folder,
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
  type SearchHit,
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

/** Identitaet der markierten Zeile. Der Index allein reicht nicht: seit die
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
  toUnc,
  emptyState,
}: ResultListProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(600);
  const [selected, setSelected] = React.useState<Selection | null>(null);
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
      setSelected(null);
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

  // Die Auswahl haengt am Zeilenschluessel; nach jeder Umsortierung wird ihr
  // Index einmal linear nachgezogen. Ein reiner Stringvergleich ueber die
  // Zeilen ist selbst bei 50 000 Treffern im Millisekundenbereich.
  const selectedIndex = React.useMemo(() => {
    if (!selected) return null;
    const atIndex = rowAt(selected.index);
    if (atIndex && isSameRow(atIndex, selected)) return selected.index;
    if (grouped) {
      for (let i = 0; i < grouped.length; i++) {
        if (isSameRow(grouped[i], selected)) return i;
      }
      return null;
    }
    if (selected.kind !== "hit") return null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].path === selected.id) return i;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, grouped, items, version, rowAt]);

  const selectRow = React.useCallback((index: number, row: RowItem) => {
    setSelected({ index, kind: row.kind, id: rowId(row) });
  }, []);

  const toggleGroup = React.useCallback((folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });
  }, []);

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

  // Anzahl der Zeilen, die "Mit Kopfzeile kopieren" ausgeben wuerde:
  // eingeklappte Gruppen sind nicht sichtbar und damit auch nicht dabei.
  const exportCount = React.useMemo(() => {
    if (!grouped) return itemCount;
    let n = 0;
    for (const row of grouped) if (row.kind === "hit") n++;
    return n;
  }, [grouped, itemCount]);

  const copyWithHeaders = React.useCallback(() => {
    let hits: SearchHit[];
    if (grouped) {
      hits = [];
      for (const row of grouped) if (row.kind === "hit") hits.push(row.hit);
    } else {
      hits = items;
    }
    navigator.clipboard
      .writeText(buildTsv(hits, dateField, toUnc))
      .then(() => onNotice(`${formatCount(hits.length)} Zeilen kopiert`))
      .catch(() => onError("Tabelle konnte nicht kopiert werden."));
  }, [grouped, items, dateField, onError, onNotice, toUnc]);

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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        selectedIndex === null
          ? first
          : Math.min(
              rowCount - 1,
              Math.max(0, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)),
            );
      const row = rowAt(next);
      if (!row) return;
      selectRow(next, row);
      scrollRowIntoView(next);
      return;
    }
    if (selectedIndex === null) return;
    const row = rowAt(selectedIndex);
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
    selectRow(index, row);
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
                        selected={selectedIndex === first + index}
                        highlight={highlightPath ? highlight : null}
                        onSelect={() => selectRow(first + index, row)}
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
                        selected={selectedIndex === first + index}
                        onSelect={() => selectRow(first + index, row)}
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
  selected,
  highlight,
  onSelect,
  onContextMenu,
  onToggle,
  onOpenFolder,
}: {
  folder: string;
  count: number;
  collapsed: boolean;
  selected: boolean;
  highlight: Highlighter | null;
  onSelect: () => void;
  onContextMenu: () => void;
  onToggle: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div
      onMouseDown={onSelect}
      onContextMenu={onContextMenu}
      onClick={onToggle}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 border-b border-border/40 bg-muted/50 px-2 text-[13px]",
        selected && "bg-primary/15",
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
  selected: boolean;
  onSelect: () => void;
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
  selected,
  onSelect,
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
      onMouseDown={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={onOpen}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "flex items-center gap-2 border-b border-border/30 px-2 text-[13px] transition-colors",
        indented && "pl-7",
        selected ? "bg-primary/15" : "hover:bg-accent/60",
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
