//! Paralleler Dateisystem-Scan mit Streaming der Treffer ins Frontend.
//!
//! Ablauf einer Suche:
//!   1. `start_search` kompiliert das Muster (schlaegt bei Syntaxfehlern sofort
//!      synchron fehl) und startet einen Hintergrund-Thread.
//!   2. Der Walker laeuft mit mehreren Threads ueber alle Wurzelverzeichnisse
//!      und legt Treffer in einen gemeinsamen Puffer.
//!   3. Ein Emitter-Thread leert diesen Puffer alle 60 ms und schickt Batches
//!      als Events. Dadurch erscheinen Ergebnisse sofort, ohne dass pro Datei
//!      ein Event ueber die IPC-Bruecke geht.
//!   4. Abbruch und Ergebnislimit stoppen den Walk kooperativ.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::matcher::{self, MatchMode, Matcher};

pub const EVENT_HITS: &str = "search:hits";
pub const EVENT_PROGRESS: &str = "search:progress";
pub const EVENT_DONE: &str = "search:done";

/// Taktung des Emitter-Threads und damit die Obergrenze fuer die Verzoegerung,
/// mit der ein gefundener Treffer im Frontend erscheint.
const FLUSH_INTERVAL: Duration = Duration::from_millis(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateField {
    Modified,
    Created,
}

impl Default for DateField {
    fn default() -> Self {
        DateField::Modified
    }
}

fn default_true() -> bool {
    true
}
fn default_max_results() -> usize {
    50_000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub pattern: String,
    pub roots: Vec<String>,
    #[serde(default)]
    pub mode: MatchMode,
    #[serde(default)]
    pub case_sensitive: bool,
    /// Muster gegen den kompletten Pfad statt nur gegen den Dateinamen pruefen.
    #[serde(default)]
    pub match_full_path: bool,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default = "default_true")]
    pub include_files: bool,
    #[serde(default)]
    pub include_dirs: bool,
    #[serde(default)]
    pub follow_links: bool,
    /// Welches Zeitfeld die Datumsgrenzen filtern.
    #[serde(default)]
    pub date_field: DateField,
    /// Untere Grenze in Millisekunden seit Epoch (inklusiv).
    pub date_from: Option<i64>,
    /// Obere Grenze in Millisekunden seit Epoch (inklusiv).
    pub date_to: Option<i64>,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub created: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HitsEvent {
    id: u64,
    hits: Vec<SearchHit>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: u64,
    scanned: u64,
    matched: u64,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    id: u64,
    scanned: u64,
    matched: u64,
    elapsed_ms: u64,
    truncated: bool,
    cancelled: bool,
    error: Option<String>,
}

/// Haelt die laufende Suche. `generation` ist die ID der aktuellen Suche; jede
/// neue Suche und jeder Abbruch erhoeht sie, wodurch alte Worker beim naechsten
/// Check aussteigen.
#[derive(Default)]
pub struct SearchState {
    generation: AtomicU64,
}

impl SearchState {
    fn begin(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    #[inline]
    fn is_current(&self, id: u64) -> bool {
        self.generation.load(Ordering::Relaxed) == id
    }
}

#[inline]
fn to_millis(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

#[cfg(windows)]
#[inline]
fn is_hidden(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    md.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(windows))]
#[inline]
fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

fn worker_threads() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    // Der Walk ist I/O-gebunden, mehr Threads als Kerne zahlen sich aus.
    (cores * 2).clamp(4, 32)
}

/// Startet die Suche im Hintergrund. Gibt die ID der Suche zurueck; alle Events
/// tragen diese ID, damit das Frontend Nachzuegler alter Suchen verwerfen kann.
pub fn start(app: AppHandle, state: Arc<SearchState>, query: SearchQuery) -> Result<u64, String> {
    if query.roots.is_empty() {
        return Err("Kein Suchordner ausgewaehlt.".into());
    }
    if !query.include_files && !query.include_dirs {
        return Err("Es muessen Dateien oder Ordner in die Suche einbezogen werden.".into());
    }

    // Muster vor dem Thread-Start kompilieren, damit Syntaxfehler direkt beim
    // Aufruf zurueckkommen statt als Event.
    let matcher = matcher::build(&query.pattern, query.mode, query.case_sensitive)?;

    let id = state.begin();
    let thread_state = Arc::clone(&state);

    std::thread::Builder::new()
        .name(format!("search-{id}"))
        .spawn(move || run(app, thread_state, id, query, matcher))
        .map_err(|e| format!("Suchthread konnte nicht gestartet werden: {e}"))?;

    Ok(id)
}

pub fn cancel(state: &SearchState) {
    state.cancel();
}

fn run(app: AppHandle, state: Arc<SearchState>, id: u64, query: SearchQuery, matcher: Matcher) {
    let started = Instant::now();

    let scanned = Arc::new(AtomicU64::new(0));
    let matched = Arc::new(AtomicU64::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let buffer: Arc<Mutex<Vec<SearchHit>>> = Arc::new(Mutex::new(Vec::with_capacity(1024)));

    let emitter = spawn_emitter(
        app.clone(),
        id,
        Arc::clone(&buffer),
        Arc::clone(&scanned),
        Arc::clone(&matched),
        Arc::clone(&stop),
        started,
    );

    let mut builder = WalkBuilder::new(&query.roots[0]);
    for root in &query.roots[1..] {
        builder.add(root);
    }
    builder
        // Ein Dateimanager darf nichts wegen .gitignore verstecken.
        .standard_filters(false)
        .follow_links(query.follow_links)
        .same_file_system(false)
        .threads(worker_threads());

    let matcher = Arc::new(matcher);
    let max_results = query.max_results.max(1);

    builder.build_parallel().run(|| {
        let state = Arc::clone(&state);
        let matcher = Arc::clone(&matcher);
        let buffer = Arc::clone(&buffer);
        let scanned = Arc::clone(&scanned);
        let matched = Arc::clone(&matched);
        let truncated = Arc::clone(&truncated);
        let stop = Arc::clone(&stop);
        let query = query.clone();

        Box::new(move |result| {
            if stop.load(Ordering::Relaxed) || !state.is_current(id) {
                return WalkState::Quit;
            }

            let entry = match result {
                Ok(entry) => entry,
                // Zugriffsfehler (z.B. gesperrte Systemordner) stoppen die
                // Suche nicht, sie werden uebersprungen.
                Err(_) => return WalkState::Continue,
            };

            // Die Wurzelverzeichnisse selbst sind kein Suchergebnis.
            if entry.depth() == 0 {
                return WalkState::Continue;
            }

            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let metadata = entry.metadata().ok();

            if !query.include_hidden {
                #[cfg(windows)]
                let hidden = metadata.as_ref().map(is_hidden).unwrap_or(false);
                #[cfg(not(windows))]
                let hidden = entry
                    .file_name()
                    .to_str()
                    .map(is_hidden_name)
                    .unwrap_or(false);

                if hidden {
                    // Versteckte Ordner gar nicht erst betreten.
                    return if is_dir {
                        WalkState::Skip
                    } else {
                        WalkState::Continue
                    };
                }
            }

            scanned.fetch_add(1, Ordering::Relaxed);

            if (is_dir && !query.include_dirs) || (!is_dir && !query.include_files) {
                return WalkState::Continue;
            }

            let name = entry.file_name().to_string_lossy();
            let path = entry.path();

            let hit = if query.match_full_path {
                let full = path.to_string_lossy();
                matcher.is_match(&full)
            } else {
                matcher.is_match(&name)
            };
            if !hit {
                return WalkState::Continue;
            }

            let modified = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(to_millis);
            let created = metadata
                .as_ref()
                .and_then(|m| m.created().ok())
                .and_then(to_millis);

            if query.date_from.is_some() || query.date_to.is_some() {
                let stamp = match query.date_field {
                    DateField::Modified => modified,
                    DateField::Created => created,
                };
                if !in_date_window(stamp, query.date_from, query.date_to) {
                    return WalkState::Continue;
                }
            }

            let count = matched.fetch_add(1, Ordering::Relaxed) + 1;
            if count > max_results as u64 {
                // Das Limit war schon voll, als dieser Thread hochgezaehlt hat.
                matched.store(max_results as u64, Ordering::Relaxed);
                truncated.store(true, Ordering::Relaxed);
                stop.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            push_hit(
                &buffer,
                SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    name: name.into_owned(),
                    parent: path
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    is_dir,
                    size: if is_dir {
                        0
                    } else {
                        metadata.as_ref().map(|m| m.len()).unwrap_or(0)
                    },
                    modified,
                    created,
                },
            );

            if count == max_results as u64 {
                // Genau das Limit erreicht: aufhoeren, es koennte mehr geben.
                truncated.store(true, Ordering::Relaxed);
                stop.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            WalkState::Continue
        })
    });

    // Emitter beenden und letzten Rest ausliefern.
    stop.store(true, Ordering::Relaxed);
    let _ = emitter.join();
    drain_and_emit(&app, id, &buffer);

    let cancelled = !state.is_current(id);
    let _ = app.emit(
        EVENT_DONE,
        DoneEvent {
            id,
            scanned: scanned.load(Ordering::Relaxed),
            matched: matched.load(Ordering::Relaxed),
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: truncated.load(Ordering::Relaxed),
            cancelled,
            error: None,
        },
    );
}

/// Prueft den Zeitstempel gegen die Datumsgrenzen. Beide Grenzen sind
/// inklusiv; das Frontend liefert `date_to` bereits als Tagesende. Eintraege
/// ohne lesbaren Zeitstempel koennen die Bedingung nicht erfuellen und fallen
/// heraus, sobald ueberhaupt eine Grenze gesetzt ist.
#[inline]
fn in_date_window(stamp: Option<i64>, from: Option<i64>, to: Option<i64>) -> bool {
    let Some(stamp) = stamp else {
        return from.is_none() && to.is_none();
    };
    if from.is_some_and(|from| stamp < from) {
        return false;
    }
    if to.is_some_and(|to| stamp > to) {
        return false;
    }
    true
}

/// Legt einen Treffer in den gemeinsamen Puffer.
///
/// Bewusst ohne thread-lokale Zwischenpufferung: die wuerde Treffer so lange
/// zurueckhalten, bis genug zusammengekommen sind, und bei einer Suche mit nur
/// einer Handvoll Treffer wuerde nichts erscheinen, bis der komplette Scan
/// durch ist. Der kritische Abschnitt ist ein einzelnes `Vec::push`, der
/// Emitter leert den Puffer per `mem::take` in O(1), und Treffer sind
/// gegenueber den gescannten Eintraegen selten und bei `max_results`
/// gedeckelt — die Sperre kostet hier praktisch nichts.
#[inline]
fn push_hit(buffer: &Mutex<Vec<SearchHit>>, hit: SearchHit) {
    // Vergifteter Mutex: Treffer verwerfen statt die Suche zu killen.
    if let Ok(mut shared) = buffer.lock() {
        shared.push(hit);
    }
}

fn drain_and_emit(app: &AppHandle, id: u64, buffer: &Mutex<Vec<SearchHit>>) {
    let batch = match buffer.lock() {
        Ok(mut shared) if !shared.is_empty() => std::mem::take(&mut *shared),
        _ => return,
    };
    let _ = app.emit(EVENT_HITS, HitsEvent { id, hits: batch });
}

#[allow(clippy::too_many_arguments)]
fn spawn_emitter(
    app: AppHandle,
    id: u64,
    buffer: Arc<Mutex<Vec<SearchHit>>>,
    scanned: Arc<AtomicU64>,
    matched: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    started: Instant,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);
        drain_and_emit(&app, id, &buffer);
        let _ = app.emit(
            EVENT_PROGRESS,
            ProgressEvent {
                id,
                scanned: scanned.load(Ordering::Relaxed),
                matched: matched.load(Ordering::Relaxed),
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
        );
        if stop.load(Ordering::Relaxed) {
            return;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_wechselt_bei_abbruch() {
        let state = SearchState::default();
        let id = state.begin();
        assert!(state.is_current(id));
        state.cancel();
        assert!(!state.is_current(id));
    }

    #[test]
    fn datumsgrenzen_sind_inklusiv() {
        assert!(in_date_window(Some(100), Some(100), Some(200)));
        assert!(in_date_window(Some(200), Some(100), Some(200)));
        assert!(!in_date_window(Some(99), Some(100), Some(200)));
        assert!(!in_date_window(Some(201), Some(100), Some(200)));
    }

    #[test]
    fn offene_datumsgrenzen() {
        assert!(in_date_window(Some(5), None, Some(10)));
        assert!(in_date_window(Some(50), Some(10), None));
        assert!(!in_date_window(Some(5), Some(10), None));
    }

    #[test]
    fn ohne_zeitstempel_nur_ohne_filter() {
        assert!(in_date_window(None, None, None));
        assert!(!in_date_window(None, Some(1), None));
        assert!(!in_date_window(None, None, Some(1)));
    }

    #[test]
    fn neue_suche_entwertet_die_alte() {
        let state = SearchState::default();
        let first = state.begin();
        let second = state.begin();
        assert!(!state.is_current(first));
        assert!(state.is_current(second));
    }
}
