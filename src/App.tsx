import * as React from "react";
import { homeDir } from "@tauri-apps/api/path";
import {
  AlertCircle,
  CalendarRange,
  Loader2,
  Search,
  Settings2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResultList } from "@/components/ResultList";
import { RootPicker } from "@/components/RootPicker";
import {
  cancelSearch,
  filterExistingPaths,
  listUncMappings,
  onDone,
  onHits,
  onProgress,
  startSearch,
  type DateField,
  type DriveMapping,
  type MatchMode,
  type MovedPath,
  type SearchHit,
  type SearchQuery,
} from "@/lib/api";
import {
  daysAgo,
  endOfDayMs,
  formatCount,
  formatDuration,
  startOfDayMs,
  toDateInput,
} from "@/lib/format";
import { createHighlighter } from "@/lib/highlight";
import { isInsideRoots } from "@/lib/paths";
import { createUncResolver } from "@/lib/unc";
import { loadRoots, saveRoots } from "@/lib/settings";
import {
  makeComparator,
  mergeSorted,
  sortSignature,
  type Comparator,
  type SortState,
} from "@/lib/sort";

interface Status {
  scanned: number;
  matched: number;
  elapsedMs: number;
  truncated: boolean;
  cancelled: boolean;
  finished: boolean;
}

const EMPTY_STATUS: Status = {
  scanned: 0,
  matched: 0,
  elapsedMs: 0,
  truncated: false,
  cancelled: false,
  finished: false,
};

/** Muster der laufenden bzw. zuletzt ausgefuehrten Suche. Die Markierung muss
 *  zu den angezeigten Treffern passen, nicht zur aktuellen Eingabe. */
interface ActiveMatch {
  pattern: string;
  mode: MatchMode;
  caseSensitive: boolean;
  /** Nur dann ist auch der Ordnerpfad am Treffer beteiligt und darf markiert
   *  werden — sonst kam der Treffer allein ueber den Dateinamen zustande. */
  matchFullPath: boolean;
  /** Suchorte dieser Suche: wer Treffer dorthin verschiebt, behaelt sie in
   *  der Liste, alles andere faellt heraus. */
  roots: string[];
}

const EMPTY_MATCH: ActiveMatch = {
  pattern: "",
  mode: "auto",
  caseSensitive: false,
  matchFullPath: false,
  roots: [],
};

export default function App() {
  const [pattern, setPattern] = React.useState("");
  const [mode, setMode] = React.useState<MatchMode>("auto");
  const [roots, setRoots] = React.useState<string[]>([]);
  const [caseSensitive, setCaseSensitive] = React.useState(false);
  const [matchFullPath, setMatchFullPath] = React.useState(false);
  const [includeHidden, setIncludeHidden] = React.useState(false);
  const [includeFiles, setIncludeFiles] = React.useState(true);
  const [includeDirs, setIncludeDirs] = React.useState(false);
  const [dateField, setDateField] = React.useState<DateField>("modified");
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [maxResults, setMaxResults] = React.useState(50000);
  const [liveSearch, setLiveSearch] = React.useState(true);
  const [groupByFolder, setGroupByFolder] = React.useState(false);
  const [showOptions, setShowOptions] = React.useState(false);
  const [activeMatch, setActiveMatch] =
    React.useState<ActiveMatch>(EMPTY_MATCH);

  const [searching, setSearching] = React.useState(false);
  const [status, setStatus] = React.useState<Status>(EMPTY_STATUS);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<SortState | null>(null);

  // Treffer liegen in einer Ref, damit die Batches nicht bei jedem Event ein
  // neues Array erzeugen. `version` stoesst das Rendern an.
  const hitsRef = React.useRef<SearchHit[]>([]);
  const [version, setVersion] = React.useState(0);
  const searchIdRef = React.useRef<number>(-1);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Sortierte Sicht auf `hitsRef`. Sie wird pro Treffer-Batch inkrementell
  // fortgeschrieben, damit die Sortierung auch waehrend der laufenden Suche
  // greift, ohne bei jedem Batch alles neu zu sortieren.
  const sortedRef = React.useRef<SearchHit[]>([]);
  /** Signatur, mit der `sortedRef` tatsaechlich aufgebaut wurde. */
  const sortedSigRef = React.useRef("");
  /** Gewuenschte Signatur; pro Render gespiegelt, damit die einmalig
   *  registrierten Event-Handler nicht auf veralteten Werten arbeiten. */
  const sortSigRef = React.useRef("");
  const cmpRef = React.useRef<Comparator | null>(null);

  const sortSig = sortSignature(sort, dateField);
  sortSigRef.current = sortSig;
  cmpRef.current = sort ? makeComparator(sort, dateField) : null;

  const showError = React.useCallback((message: string) => {
    setError(message);
  }, []);

  // Kurze Erfolgsmeldung in der Statuszeile; blendet sich selbst wieder aus.
  const noticeTimerRef = React.useRef<number | null>(null);
  const showNotice = React.useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2500);
  }, []);

  React.useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  /** Auswahl des Nutzers — nur sie wird gespeichert, nicht der Startvorschlag
   *  und nicht das Aussortieren nicht erreichbarer Ordner. */
  const changeRoots = React.useCallback((next: string[]) => {
    setRoots(next);
    saveRoots(next);
  }, []);

  // Beim Start die zuletzt gewaehlten Suchordner wiederherstellen; erst wenn
  // es keine gibt, ist das Benutzerprofil der Vorschlag.
  React.useEffect(() => {
    const saved = loadRoots();
    if (!saved) {
      homeDir()
        .then((home) => setRoots([home]))
        .catch(() => setRoots([]));
      return;
    }

    setRoots(saved);
    // Erreichbarkeit erst danach im Hintergrund pruefen: bei einem getrennten
    // Netzlaufwerk kann das dauern, und solange soll das Fenster schon stehen.
    filterExistingPaths(saved)
      .then((alive) => {
        if (alive.length === saved.length) return;
        // Bewusst ohne `saveRoots`: der Eintrag bleibt gespeichert und ist
        // wieder da, sobald das Laufwerk erneut verbunden ist.
        setRoots(alive);
        const fehlend = saved.length - alive.length;
        showNotice(
          fehlend === 1
            ? "Ein gespeicherter Suchordner ist derzeit nicht erreichbar"
            : `${fehlend} gespeicherte Suchordner sind derzeit nicht erreichbar`,
        );
      })
      .catch(() => undefined);
  }, [showNotice]);

  // Netzlaufwerke fuer die UNC-Umschreibung beim Kopieren. Die Suchorte sind
  // der natuerliche Ausloeser zum Nachladen: wer ein Laufwerk neu verbindet,
  // waehlt es anschliessend hier aus. Schlaegt der Abruf fehl, bleiben die
  // Pfade unveraendert — die Umschreibung ist reiner Komfort.
  const [uncMappings, setUncMappings] = React.useState<DriveMapping[]>([]);
  React.useEffect(() => {
    listUncMappings()
      .then(setUncMappings)
      .catch(() => undefined);
  }, [roots]);

  const toUnc = React.useMemo(
    () => createUncResolver(uncMappings),
    [uncMappings],
  );

  const query = React.useMemo<SearchQuery>(
    () => ({
      pattern,
      roots,
      mode,
      caseSensitive,
      matchFullPath,
      includeHidden,
      includeFiles,
      includeDirs,
      followLinks: false,
      dateField,
      dateFrom: startOfDayMs(dateFrom),
      dateTo: endOfDayMs(dateTo),
      maxResults,
    }),
    [
      pattern,
      roots,
      mode,
      caseSensitive,
      matchFullPath,
      includeHidden,
      includeFiles,
      includeDirs,
      dateField,
      dateFrom,
      dateTo,
      maxResults,
    ],
  );

  const queryRef = React.useRef(query);
  queryRef.current = query;

  const hasCriteria =
    pattern.trim().length > 0 || dateFrom !== "" || dateTo !== "";

  const runSearch = React.useCallback(async () => {
    const current = queryRef.current;
    if (current.roots.length === 0) {
      showError("Bitte mindestens einen Suchordner auswählen.");
      return;
    }
    setError(null);
    hitsRef.current = [];
    sortedRef.current = [];
    sortedSigRef.current = "";
    setVersion((v) => v + 1);
    setStatus(EMPTY_STATUS);
    setActiveMatch({
      pattern: current.pattern,
      mode: current.mode,
      caseSensitive: current.caseSensitive,
      matchFullPath: current.matchFullPath,
      roots: current.roots,
    });
    setSearching(true);
    try {
      searchIdRef.current = await startSearch(current);
    } catch (e) {
      searchIdRef.current = -1;
      setSearching(false);
      showError(String(e));
    }
  }, [showError]);

  const stopSearch = React.useCallback(() => {
    cancelSearch().catch(() => undefined);
  }, []);

  // Event-Abos einmalig aufsetzen; Nachzuegler alter Suchen werden verworfen.
  React.useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const register = (p: Promise<() => void>) => {
      p.then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      }).catch(() => undefined);
    };

    register(
      onHits((e) => {
        if (e.id !== searchIdRef.current) return;
        // Bewusst eine Schleife statt `push(...e.hits)`: der Spread gibt jeden
        // Treffer als eigenes Argument weiter und sprengt bei grossen Batches
        // das Argumentlimit der Engine.
        const target = hitsRef.current;
        for (const hit of e.hits) target.push(hit);
        // Ist eine Sortierung aktiv, wird der Batch fuer sich sortiert und in
        // die bestehende sortierte Sicht gemerged — das kostet nur `n + m`
        // Vergleiche statt einer Vollsortierung pro Batch.
        const cmp = cmpRef.current;
        if (cmp && sortedSigRef.current === sortSigRef.current) {
          sortedRef.current = mergeSorted(
            sortedRef.current,
            e.hits.slice().sort(cmp),
            cmp,
          );
        }
        // Passt die Signatur nicht, wurde gerade umsortiert und noch nicht neu
        // gerendert: der naechste Render baut ohnehin komplett aus `hitsRef`
        // auf, das den Batch bereits enthaelt.
        setVersion((v) => v + 1);
      }),
    );
    register(
      onProgress((e) => {
        if (e.id !== searchIdRef.current) return;
        setStatus((s) => ({
          ...s,
          scanned: e.scanned,
          matched: e.matched,
          elapsedMs: e.elapsedMs,
        }));
      }),
    );
    register(
      onDone((e) => {
        if (e.id !== searchIdRef.current) return;
        setSearching(false);
        setStatus({
          scanned: e.scanned,
          matched: e.matched,
          elapsedMs: e.elapsedMs,
          truncated: e.truncated,
          cancelled: e.cancelled,
          finished: true,
        });
        if (e.error) showError(e.error);
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [showError]);

  // Live-Suche: Eingaben werden gebuendelt, jede neue Suche bricht die alte ab.
  const queryKey = JSON.stringify(query);
  React.useEffect(() => {
    if (!liveSearch || !hasCriteria || roots.length === 0) return;
    const timer = setTimeout(() => void runSearch(), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, liveSearch, hasCriteria, runSearch]);

  React.useEffect(() => {
    return () => {
      cancelSearch().catch(() => undefined);
    };
  }, []);

  // Globale Tastenkuerzel.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "l")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape") {
        stopSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopSearch]);

  // Die Vollsortierung passiert bewusst hier und nicht in einem Effect: sonst
  // wuerde React einen Frame lang mit neuem Sortierschluessel, aber noch alter
  // sortierter Sicht rendern — sichtbares Flackern. Der Ref-Zugriff ist ein
  // idempotenter Cache.
  const items = React.useMemo(() => {
    if (!sortSig) {
      sortedRef.current = [];
      sortedSigRef.current = "";
      return hitsRef.current;
    }
    if (sortedSigRef.current !== sortSig) {
      sortedRef.current = hitsRef.current.slice().sort(cmpRef.current!);
      sortedSigRef.current = sortSig;
    }
    return sortedRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, sortSig]);

  // Nach dem Verschieben: liegt das Ziel noch in den Suchorten, zeigt der
  // Treffer auf den neuen Ort, sonst verschwindet er. Bewusst neue Objekte,
  // weil die Zeilen auf Referenzgleichheit memoisiert sind.
  const activeRootsRef = React.useRef<string[]>([]);
  activeRootsRef.current = activeMatch.roots;
  const applyMoves = React.useCallback((moved: MovedPath[], dest: string) => {
    if (moved.length === 0) return;
    const targets = new Map(moved.map((m) => [m.from, m.to]));
    const keep = isInsideRoots(dest, activeRootsRef.current);
    const next: SearchHit[] = [];
    for (const hit of hitsRef.current) {
      const to = targets.get(hit.path);
      if (to === undefined) next.push(hit);
      else if (keep) next.push({ ...hit, path: to, parent: dest });
    }
    hitsRef.current = next;
    // Erzwingt im `items`-Memo eine Neusortierung aus `hitsRef`.
    sortedSigRef.current = "";
    setVersion((v) => v + 1);
  }, []);

  const highlight = React.useMemo(
    () =>
      createHighlighter(
        activeMatch.pattern,
        activeMatch.mode,
        activeMatch.caseSensitive,
      ),
    [activeMatch],
  );

  const setPreset = (days: number | null) => {
    if (days === null) {
      setDateFrom("");
      setDateTo("");
      return;
    }
    setDateFrom(toDateInput(daysAgo(days)));
    setDateTo("");
  };

  const dateActive = dateFrom !== "" || dateTo !== "";

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col gap-3 p-3">
        {/* Suchzeile */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              autoFocus
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
              placeholder="Suchbegriff oder Wildcard, z. B. *.pdf, bericht_202?.xlsx, foto*.{jpg,png}"
              className="h-11 pl-9 pr-9 text-base"
            />
            {pattern && (
              <button
                type="button"
                aria-label="Eingabe löschen"
                onClick={() => setPattern("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <Select value={mode} onValueChange={(v) => setMode(v as MatchMode)}>
            <SelectTrigger className="h-11 w-[168px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatisch</SelectItem>
              <SelectItem value="wildcard">Wildcards</SelectItem>
              <SelectItem value="substring">Enthält Text</SelectItem>
              <SelectItem value="regex">Regex</SelectItem>
            </SelectContent>
          </Select>

          {searching ? (
            <Button
              variant="destructive"
              className="h-11 w-28"
              onClick={stopSearch}
            >
              <Loader2 className="animate-spin" />
              Stopp
            </Button>
          ) : (
            <Button className="h-11 w-28" onClick={() => void runSearch()}>
              <Search />
              Suchen
            </Button>
          )}

          <Button
            variant={showOptions ? "secondary" : "outline"}
            size="icon"
            className="h-11 w-11"
            onClick={() => setShowOptions((v) => !v)}
            aria-label="Optionen"
          >
            <Settings2 />
          </Button>
        </div>

        {/* Datumsfilter direkt beim Suchen */}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CalendarRange className="h-4 w-4" />
            <Select
              value={dateField}
              onValueChange={(v) => setDateField(v as DateField)}
            >
              <SelectTrigger className="h-8 w-[124px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modified">Geändert</SelectItem>
                <SelectItem value="created">Erstellt</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="date-from">von</Label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-[150px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="date-to">bis</Label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-[150px]"
            />
          </div>

          <Separator orientation="vertical" className="h-8" />

          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setPreset(0)}>
              Heute
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPreset(7)}>
              7 Tage
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPreset(30)}>
              30 Tage
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPreset(365)}>
              1 Jahr
            </Button>
            {dateActive && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPreset(null)}
              >
                <X />
                Datum
              </Button>
            )}
          </div>

          <div className="ml-auto flex items-center gap-4">
            <Toggle
              id="group"
              label="Nach Ordner gruppieren"
              checked={groupByFolder}
              onChange={setGroupByFolder}
            />
            <Toggle
              id="live"
              label="Live-Suche beim Tippen"
              checked={liveSearch}
              onChange={setLiveSearch}
            />
          </div>
        </div>

        {/* Suchorte */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Suchen in
          </span>
          <RootPicker roots={roots} onChange={changeRoots} onError={showError} />
        </div>

        {/* Erweiterte Optionen */}
        {showOptions && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-3 py-2.5">
            <Toggle
              id="opt-files"
              label="Dateien"
              checked={includeFiles}
              onChange={setIncludeFiles}
            />
            <Toggle
              id="opt-dirs"
              label="Ordner"
              checked={includeDirs}
              onChange={setIncludeDirs}
            />
            <Toggle
              id="opt-hidden"
              label="Versteckte & Systemdateien"
              checked={includeHidden}
              onChange={setIncludeHidden}
            />
            <Toggle
              id="opt-case"
              label="Groß-/Kleinschreibung beachten"
              checked={caseSensitive}
              onChange={setCaseSensitive}
            />
            <Toggle
              id="opt-path"
              label="Im ganzen Pfad suchen"
              checked={matchFullPath}
              onChange={setMatchFullPath}
            />
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="opt-max">max. Treffer</Label>
              <Input
                id="opt-max"
                type="number"
                min={100}
                step={1000}
                value={maxResults}
                onChange={(e) =>
                  setMaxResults(Math.max(100, Number(e.target.value) || 100))
                }
                className="h-8 w-28"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="selectable min-w-0 flex-1 break-words">{error}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setError(null)}
              aria-label="Meldung schließen"
            >
              <X />
            </Button>
          </div>
        )}

        <ResultList
          items={items}
          version={version}
          dateField={dateField}
          groupByFolder={groupByFolder}
          highlight={highlight}
          highlightPath={activeMatch.matchFullPath}
          sort={sort}
          onSortChange={setSort}
          onError={showError}
          onNotice={showNotice}
          onMoved={applyMoves}
          toUnc={toUnc}
          emptyState={
            <EmptyState
              searching={searching}
              finished={status.finished}
              hasCriteria={hasCriteria}
              hasRoots={roots.length > 0}
            />
          }
        />

        {/* Statuszeile */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-1 text-xs text-muted-foreground">
          <span>
            <strong className="text-foreground">
              {formatCount(items.length)}
            </strong>{" "}
            Treffer
          </span>
          <span>{formatCount(status.scanned)} Einträge geprüft</span>
          <span>{formatDuration(status.elapsedMs)}</span>
          {searching && (
            <Badge variant="default" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Suche läuft
            </Badge>
          )}
          {status.truncated && (
            <Badge variant="outline" className="text-amber-500">
              Limit von {formatCount(maxResults)} erreicht
            </Badge>
          )}
          {status.cancelled && !searching && (
            <Badge variant="secondary">Abgebrochen</Badge>
          )}
          {notice && (
            <span className="font-medium text-foreground">{notice}</span>
          )}
          <span className="ml-auto">
            Strg+F Suchfeld · Esc Stopp · Strg+X/C Verschieben/Kopieren · Rechtsklick für Menü
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
    </div>
  );
}

function EmptyState({
  searching,
  finished,
  hasCriteria,
  hasRoots,
}: {
  searching: boolean;
  finished: boolean;
  hasCriteria: boolean;
  hasRoots: boolean;
}) {
  if (!hasRoots) {
    return (
      <p className="text-sm text-muted-foreground">
        Wähle oben mindestens einen Ordner oder ein Laufwerk aus.
      </p>
    );
  }
  if (searching) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Suche läuft …
      </p>
    );
  }
  if (finished) {
    return (
      <p className="text-sm text-muted-foreground">
        Keine Treffer für diese Kriterien.
      </p>
    );
  }
  return (
    <div className="max-w-md space-y-2 text-center text-sm text-muted-foreground">
      <p>
        {hasCriteria
          ? "Drücke Enter oder klicke auf Suchen."
          : "Suchbegriff eingeben oder einen Datumsfilter setzen."}
      </p>
      <p className="text-xs">
        Wildcards: <code>*</code> beliebig viele Zeichen, <code>?</code> genau
        eins, <code>{"{jpg,png}"}</code> Alternativen, <code>[0-9]</code>{" "}
        Zeichenklassen.
      </p>
    </div>
  );
}
