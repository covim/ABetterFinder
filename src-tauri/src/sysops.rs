//! Betriebssystem-Integration: Explorer oeffnen, Laufwerke auflisten,
//! Dateien verschieben und kopieren.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,
    pub label: String,
}

/// Ein gemapptes Netzlaufwerk und die Freigabe, auf die es zeigt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveMapping {
    /// Laufwerksbuchstabe mit Doppelpunkt, z. B. `Z:`.
    pub letter: String,
    /// Freigabe ohne abschliessenden Backslash, z. B. `\\server\share`.
    pub unc: String,
}

/// Alle Laufwerksbuchstaben, die auf eine Netzwerkfreigabe zeigen. Lokale
/// Laufwerke tauchen bewusst nicht auf: ihr Admin-Share (`\\PC\c$`) waere fuer
/// andere ohnehin nur mit Administratorrechten erreichbar.
#[cfg(windows)]
pub fn unc_mappings() -> Vec<DriveMapping> {
    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::NetworkManagement::WNet::WNetGetConnectionW;

    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let local: Vec<u16> = format!("{}:", letter as char)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // MAX_PATH reicht in der Praxis; bei ERROR_MORE_DATA liefert die API
        // die noetige Groesse in `len` zurueck und wir fragen erneut.
        let mut len: u32 = 256;
        let mut buf = vec![0u16; len as usize];
        // SAFETY: `local` ist nullterminiert, `buf` hat `len` Elemente, und
        // `len` beschreibt genau diese Kapazitaet in WCHARs.
        let mut rc = unsafe { WNetGetConnectionW(local.as_ptr(), buf.as_mut_ptr(), &mut len) };
        if rc == ERROR_MORE_DATA {
            buf = vec![0u16; len as usize];
            // SAFETY: wie oben, mit dem von der API geforderten Puffer.
            rc = unsafe { WNetGetConnectionW(local.as_ptr(), buf.as_mut_ptr(), &mut len) };
        }
        // Alles ausser NO_ERROR heisst: kein Netzlaufwerk auf diesem Buchstaben.
        if rc != 0 {
            continue;
        }

        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let unc = String::from_utf16_lossy(&buf[..end]);
        let unc = unc.trim_end_matches('\\');
        // Nur echte Freigaben; alles andere waere als Pfad fuer andere wertlos.
        if !unc.starts_with(r"\\") {
            continue;
        }
        out.push(DriveMapping {
            letter: format!("{}:", letter as char),
            unc: unc.to_string(),
        });
    }
    out
}

#[cfg(not(windows))]
pub fn unc_mappings() -> Vec<DriveMapping> {
    Vec::new()
}

/// Alle erreichbaren Laufwerke. Unter Windows werden A: bis Z: geprueft, auf
/// anderen Plattformen ist die Wurzel das einzige "Laufwerk".
pub fn list_drives() -> Vec<DriveInfo> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let root = format!("{}:\\", letter as char);
                // Nur tatsaechlich eingebundene Laufwerke; nicht eingelegte
                // Wechselmedien fallen hier raus.
                if Path::new(&root).is_dir() {
                    Some(DriveInfo {
                        label: format!("{}:", letter as char),
                        path: root,
                    })
                } else {
                    None
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![DriveInfo {
            path: "/".into(),
            label: "/".into(),
        }]
    }
}

/// Behaelt nur die Pfade, die es noch gibt. Gedacht fuer die gespeicherten
/// Suchordner beim Start: ein getrenntes Netzlaufwerk oder ein geloeschter
/// Ordner soll nicht als Suchort stehenbleiben und stillschweigend nichts
/// liefern.
pub fn existing_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect()
}

fn validated(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("Pfad existiert nicht mehr: {path}"));
    }
    Ok(p)
}

/// Oeffnet den Explorer und markiert den Eintrag darin.
pub fn reveal(path: &str) -> Result<(), String> {
    let p = validated(path)?;

    #[cfg(windows)]
    {
        use std::process::Command;
        // explorer.exe liefert auch im Erfolgsfall Exitcode 1, der Status wird
        // deshalb bewusst nicht geprueft. Das Argument muss als ein Token
        // "/select,<pfad>" uebergeben werden.
        Command::new("explorer.exe")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| format!("Explorer konnte nicht gestartet werden: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", &p.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Finder konnte nicht gestartet werden: {e}"))?;
        Ok(())
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        // Kein verlaesslicher "select"-Standard: den Ordner oeffnen.
        let dir = if p.is_dir() {
            p.clone()
        } else {
            p.parent().map(Path::to_path_buf).unwrap_or(p.clone())
        };
        open_dir(&dir.to_string_lossy())
    }
}

/// Oeffnet Datei oder Ordner mit der Standardanwendung des Systems.
pub fn open_with_default_app(path: &str) -> Result<(), String> {
    let p = validated(path)?;

    #[cfg(windows)]
    {
        use std::process::Command;
        // explorer.exe delegiert an den registrierten Standard-Handler und
        // erspart uns den direkten ShellExecute-Aufruf.
        Command::new("explorer.exe")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| format!("Datei konnte nicht geoeffnet werden: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| format!("Datei konnte nicht geoeffnet werden: {e}"))?;
        return Ok(());
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(p.as_os_str())
            .spawn()
            .map_err(|e| format!("xdg-open fehlgeschlagen: {e}"))?;
        Ok(())
    }
}

/// Oeffnet den Ordner selbst (bei Dateien den enthaltenden Ordner).
pub fn open_dir(path: &str) -> Result<(), String> {
    let p = validated(path)?;
    let dir = if p.is_dir() {
        p
    } else {
        p.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("Kein uebergeordneter Ordner fuer: {path}"))?
    };

    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("explorer.exe")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("Explorer konnte nicht gestartet werden: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("Finder konnte nicht gestartet werden: {e}"))?;
        return Ok(());
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| format!("xdg-open fehlgeschlagen: {e}"))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Move,
    Copy,
}

/// Ein tatsaechlich verschobener Eintrag: alter und neuer Pfad.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedPath {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    /// Nur beim Verschieben gefuellt; Eintraege, die Windows wegen eines
    /// Namenskonflikts uebersprungen hat, fehlen hier.
    pub moved: Vec<MovedPath>,
    /// Der Nutzer hat im Fortschritts- oder Konfliktdialog abgebrochen.
    pub aborted: bool,
}

/// Verschiebt oder kopiert die Eintraege in den Zielordner. Unter Windows
/// uebernimmt das die Shell: sie zeigt den gewohnten Fortschrittsdialog,
/// fragt selbst bei Namenskonflikten und traegt die Aktion ins Explorer-Undo
/// ein. `owner` ist das Fensterhandle, an dem die Dialoge haengen (0 = keins).
pub fn transfer(
    paths: Vec<String>,
    dest: &str,
    mode: TransferMode,
    owner: isize,
) -> Result<TransferResult, String> {
    transfer_with(paths, dest, mode, owner, false)
}

fn transfer_with(
    paths: Vec<String>,
    dest: &str,
    mode: TransferMode,
    owner: isize,
    silent: bool,
) -> Result<TransferResult, String> {
    let dest_dir = validated(dest)?;
    if !dest_dir.is_dir() {
        return Err(format!("Ziel ist kein Ordner: {dest}"));
    }

    let mut sources: Vec<(String, PathBuf)> = Vec::with_capacity(paths.len());
    for path in paths {
        let src = validated(&path)?;
        // Verschieben an denselben Ort ist ein No-op; die Shell wuerde dafuer
        // einen Fehlerdialog zeigen.
        if mode == TransferMode::Move && src.parent().is_some_and(|p| same_path(p, &dest_dir)) {
            continue;
        }
        if is_within(&dest_dir, &src) {
            return Err(format!(
                "Ein Ordner kann nicht in sich selbst verschoben oder kopiert werden: {path}"
            ));
        }
        sources.push((path, src));
    }

    if sources.is_empty() {
        return Ok(TransferResult {
            moved: Vec::new(),
            aborted: false,
        });
    }

    let src_paths: Vec<PathBuf> = sources.iter().map(|(_, p)| p.clone()).collect();
    let aborted = shell_transfer(&src_paths, &dest_dir, mode, owner, silent)?;

    let moved = if mode == TransferMode::Move {
        collect_moved(&sources, &dest_dir)
    } else {
        Vec::new()
    };
    Ok(TransferResult { moved, aborted })
}

/// Was nach der Operation wirklich umgezogen ist: die Quelle ist weg und am
/// Ziel liegt ein gleichnamiger Eintrag. Uebersprungene Konflikte und
/// abgebrochene Reste fallen dadurch heraus.
fn collect_moved(sources: &[(String, PathBuf)], dest: &Path) -> Vec<MovedPath> {
    sources
        .iter()
        .filter_map(|(original, src)| {
            let target = dest.join(src.file_name()?);
            (!src.exists() && target.exists()).then(|| MovedPath {
                from: original.clone(),
                to: target.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// Pfadvergleich ohne Ruecksicht auf abschliessende Trenner; unter Windows
/// zusaetzlich ohne Gross-/Kleinschreibung.
fn same_path(a: &Path, b: &Path) -> bool {
    normalized(a) == normalized(b)
}

/// `inner` liegt in `outer` oder ist es selbst.
fn is_within(inner: &Path, outer: &Path) -> bool {
    let inner = normalized(inner);
    let outer = normalized(outer);
    inner == outer || inner.starts_with(&format!("{outer}{}", std::path::MAIN_SEPARATOR))
}

fn normalized(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s.to_string()
    }
}

/// Liste fuer `SHFILEOPSTRUCTW`: jeder Pfad nullterminiert, das Ganze mit
/// einer zusaetzlichen Null abgeschlossen.
#[cfg(windows)]
fn to_multi_sz<'a>(items: impl IntoIterator<Item = &'a std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut out = Vec::new();
    for item in items {
        out.extend(item.encode_wide());
        out.push(0);
    }
    out.push(0);
    out
}

/// Liefert `true`, wenn der Nutzer abgebrochen hat.
#[cfg(windows)]
fn shell_transfer(
    sources: &[PathBuf],
    dest: &Path,
    mode: TransferMode,
    owner: isize,
    silent: bool,
) -> Result<bool, String> {
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOCONFIRMMKDIR,
        FOF_NOERRORUI, FOF_SILENT, FO_COPY, FO_MOVE, SHFILEOPSTRUCTW,
    };

    let from = to_multi_sz(sources.iter().map(|p| p.as_os_str()));
    let to = to_multi_sz(std::iter::once(dest.as_os_str()));

    let mut flags = FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR;
    if silent {
        flags |= FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI;
    }

    let mut op = SHFILEOPSTRUCTW {
        hwnd: owner as _,
        wFunc: match mode {
            TransferMode::Move => FO_MOVE,
            TransferMode::Copy => FO_COPY,
        },
        pFrom: from.as_ptr(),
        pTo: to.as_ptr(),
        // Alle FOF_*-Werte passen in 16 Bit; die Struktur fuehrt das Feld als WORD.
        fFlags: flags as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `from` und `to` sind doppelt nullterminiert und leben bis nach
    // dem Aufruf; alle uebrigen Zeiger sind null.
    let rc = unsafe { SHFileOperationW(&mut op) };

    // Ein Abbruch liefert je nach Zeitpunkt auch einen Fehlercode — der ist
    // dann keine Fehlermeldung wert.
    if op.fAnyOperationsAborted != 0 {
        return Ok(true);
    }
    if rc != 0 {
        let verb = match mode {
            TransferMode::Move => "Verschieben",
            TransferMode::Copy => "Kopieren",
        };
        return Err(format!("{verb} fehlgeschlagen (Windows-Fehler {rc:#x})"));
    }
    Ok(false)
}

/// Einfacher Ersatz ausserhalb von Windows: vorhandene Ziele werden
/// uebersprungen, Ordner nur per `rename` verschoben, nicht kopiert.
#[cfg(not(windows))]
fn shell_transfer(
    sources: &[PathBuf],
    dest: &Path,
    mode: TransferMode,
    _owner: isize,
    _silent: bool,
) -> Result<bool, String> {
    for src in sources {
        let Some(name) = src.file_name() else { continue };
        let target = dest.join(name);
        if target.exists() {
            continue;
        }
        match mode {
            TransferMode::Move => {
                if std::fs::rename(src, &target).is_err() && src.is_file() {
                    // Ueber Dateisystemgrenzen hinweg geht rename nicht.
                    std::fs::copy(src, &target)
                        .and_then(|_| std::fs::remove_file(src))
                        .map_err(|e| format!("Verschieben fehlgeschlagen: {e}"))?;
                }
            }
            TransferMode::Copy => {
                if src.is_file() {
                    std::fs::copy(src, &target)
                        .map_err(|e| format!("Kopieren fehlgeschlagen: {e}"))?;
                }
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frisches Testverzeichnis mit Quell- und Zielordner.
    fn sandbox(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("abf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("quelle");
        let dst = root.join("ziel");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        (root, src, dst)
    }

    fn touch(dir: &Path, name: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, name).unwrap();
        p.to_string_lossy().to_string()
    }

    #[cfg(windows)]
    #[test]
    fn multi_sz_ist_doppelt_nullterminiert() {
        use std::ffi::OsStr;
        let out = to_multi_sz([OsStr::new("a"), OsStr::new("bc")]);
        assert_eq!(out, vec![b'a' as u16, 0, b'b' as u16, b'c' as u16, 0, 0]);
    }

    #[test]
    fn verschieben_meldet_neue_pfade() {
        let (root, src, dst) = sandbox("move");
        let a = touch(&src, "a.txt");
        let b = touch(&src, "b.txt");

        let res = transfer_with(
            vec![a.clone(), b.clone()],
            &dst.to_string_lossy(),
            TransferMode::Move,
            0,
            true,
        )
        .unwrap();

        assert!(!res.aborted);
        assert_eq!(res.moved.len(), 2);
        assert_eq!(res.moved[0].from, a);
        assert_eq!(res.moved[0].to, dst.join("a.txt").to_string_lossy());
        assert!(!Path::new(&a).exists());
        assert!(dst.join("b.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn kopieren_laesst_quellen_stehen() {
        let (root, src, dst) = sandbox("copy");
        let a = touch(&src, "a.txt");

        let res = transfer_with(
            vec![a.clone()],
            &dst.to_string_lossy(),
            TransferMode::Copy,
            0,
            true,
        )
        .unwrap();

        assert!(res.moved.is_empty());
        assert!(Path::new(&a).exists());
        assert!(dst.join("a.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verschieben_in_denselben_ordner_ist_noop() {
        let (root, src, _) = sandbox("same");
        let a = touch(&src, "a.txt");

        let res = transfer_with(
            vec![a.clone()],
            &src.to_string_lossy(),
            TransferMode::Move,
            0,
            true,
        )
        .unwrap();

        assert!(res.moved.is_empty());
        assert!(Path::new(&a).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ordner_nicht_in_sich_selbst() {
        let (root, src, _) = sandbox("self");
        let inner = src.join("unter");
        std::fs::create_dir_all(&inner).unwrap();

        let err = transfer_with(
            vec![src.to_string_lossy().to_string()],
            &inner.to_string_lossy(),
            TransferMode::Copy,
            0,
            true,
        );

        assert!(err.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Welche Laufwerke gemappt sind, haengt am Testrechner — pruefbar ist
    /// aber die Form der Rueckgabe, auf die sich das Frontend verlaesst.
    #[test]
    fn unc_mappings_sind_wohlgeformt() {
        for m in unc_mappings() {
            assert_eq!(m.letter.len(), 2, "Laufwerk als 'X:' erwartet: {m:?}");
            assert!(m.letter.ends_with(':'), "kein Doppelpunkt: {m:?}");
            assert!(m.unc.starts_with(r"\\"), "kein UNC-Pfad: {m:?}");
            assert!(!m.unc.ends_with('\\'), "Backslash am Ende: {m:?}");
        }
    }

    #[test]
    fn existing_paths_filtert_verschwundene() {
        let vorhanden = std::env::temp_dir();
        let weg = vorhanden.join(format!("abf-gibt-es-nicht-{}", std::process::id()));
        assert!(!weg.exists(), "Testpfad duerfte nicht existieren");

        let out = existing_paths(vec![
            vorhanden.to_string_lossy().to_string(),
            weg.to_string_lossy().to_string(),
        ]);

        assert_eq!(out, vec![vorhanden.to_string_lossy().to_string()]);
    }

    #[test]
    fn existing_paths_behaelt_die_reihenfolge() {
        let a = std::env::temp_dir();
        let b = std::env::current_dir().unwrap();
        let out = existing_paths(vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], a.to_string_lossy().to_string());
    }
}
