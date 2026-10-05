mod matcher;
mod search;
mod sysops;

use std::sync::Arc;

use search::{SearchQuery, SearchState};
use sysops::{DriveInfo, DriveMapping, TransferMode, TransferResult};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[tauri::command]
fn start_search(
    app: AppHandle,
    state: State<'_, Arc<SearchState>>,
    query: SearchQuery,
) -> Result<u64, String> {
    search::start(app, Arc::clone(&state), query)
}

#[tauri::command]
fn cancel_search(state: State<'_, Arc<SearchState>>) {
    search::cancel(&state);
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    sysops::list_drives()
}

/// Gemappte Netzlaufwerke, damit das Frontend beim Kopieren aus `Z:\...` den
/// fuer andere gueltigen UNC-Pfad machen kann.
#[tauri::command]
fn list_unc_mappings() -> Vec<DriveMapping> {
    sysops::unc_mappings()
}

/// Prueft die gespeicherten Suchordner beim Start. Bewusst `async`: sonst
/// liefe die Pruefung auf dem Main-Thread und ein nicht antwortendes
/// Netzlaufwerk wuerde das Fenster blockieren.
#[tauri::command]
async fn filter_existing_paths(paths: Vec<String>) -> Vec<String> {
    sysops::existing_paths(paths)
}

/// Der feste "Im Explorer zeigen"-Button jedes Suchergebnisses.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    sysops::reveal(&path)
}

#[tauri::command]
fn open_containing_folder(path: String) -> Result<(), String> {
    sysops::open_dir(&path)
}

/// Oeffnet die Datei mit der im System hinterlegten Standardanwendung.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    sysops::open_with_default_app(&path)
}

/// Verschiebt oder kopiert die markierten Treffer in einen Zielordner. Laeuft
/// auf einem Hintergrund-Thread: die Shell zeigt waehrenddessen ihren eigenen
/// Fortschrittsdialog, das Fenster soll dabei nicht einfrieren.
#[tauri::command]
async fn transfer_paths(
    window: WebviewWindow,
    paths: Vec<String>,
    dest: String,
    mode: TransferMode,
) -> Result<TransferResult, String> {
    let owner = window_handle(&window);
    tauri::async_runtime::spawn_blocking(move || sysops::transfer(paths, &dest, mode, owner))
        .await
        .map_err(|e| format!("Dateioperation abgebrochen: {e}"))?
}

/// Fensterhandle als Zahl, damit es in den Hintergrund-Thread darf.
#[cfg(windows)]
fn window_handle(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

#[cfg(not(windows))]
fn window_handle(_window: &WebviewWindow) -> isize {
    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(SearchState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_search,
            cancel_search,
            list_drives,
            list_unc_mappings,
            filter_existing_paths,
            reveal_in_explorer,
            open_containing_folder,
            open_path,
            transfer_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
