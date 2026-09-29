//! Betriebssystem-Integration: Explorer oeffnen, Laufwerke auflisten.

use std::path::{Path, PathBuf};

use serde::Serialize;

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

#[cfg(test)]
mod tests {
    use super::*;

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
