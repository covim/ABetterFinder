//! Kompilierung des Suchmusters (Substring / Wildcard / Regex).
//!
//! Das Muster wird genau einmal pro Suche kompiliert und danach von allen
//! Worker-Threads geteilt. Im Hot Path werden keine Allokationen gemacht,
//! solange Muster und Dateiname ASCII sind.

use globset::{Glob, GlobBuilder, GlobMatcher};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    /// Enthaelt das Muster Wildcard-Zeichen, wird als Glob gesucht, sonst als
    /// Teilstring. Das ist der Default und deckt den Alltag ab.
    Auto,
    /// Immer Glob: `*`, `?`, `[abc]`, `{a,b}`.
    Wildcard,
    /// Volle Regex-Syntax.
    Regex,
    /// Immer Teilstring, auch wenn das Muster Sonderzeichen enthaelt.
    Substring,
}

impl Default for MatchMode {
    fn default() -> Self {
        MatchMode::Auto
    }
}

pub enum Matcher {
    /// Leeres Muster: alles passt (nur Datums-/Typfilter greifen).
    All,
    /// Bereits kleingeschriebener ASCII-Teilstring.
    SubstringCi(String),
    /// Teilstring mit Beachtung der Gross-/Kleinschreibung.
    Substring(String),
    /// Teilstring mit Unicode-Faltung (Umlaute), allokiert pro Treffer-Test.
    SubstringUnicodeCi(String),
    Glob(GlobMatcher),
    Regex(Regex),
}

impl Matcher {
    #[inline]
    pub fn is_match(&self, haystack: &str) -> bool {
        match self {
            Matcher::All => true,
            Matcher::SubstringCi(needle) => contains_ascii_ci(haystack, needle),
            Matcher::Substring(needle) => haystack.contains(needle.as_str()),
            Matcher::SubstringUnicodeCi(needle) => {
                haystack.to_lowercase().contains(needle.as_str())
            }
            Matcher::Glob(g) => g.is_match(haystack),
            Matcher::Regex(r) => r.is_match(haystack),
        }
    }
}

/// Teilstringsuche ohne Allokation. `needle` muss bereits kleingeschrieben und
/// reines ASCII sein.
#[inline]
fn contains_ascii_ci(haystack: &str, needle: &str) -> bool {
    let h = haystack.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() {
        return true;
    }
    if n.len() > h.len() {
        return false;
    }
    let first = n[0];
    'outer: for i in 0..=(h.len() - n.len()) {
        if h[i].to_ascii_lowercase() != first {
            continue;
        }
        for j in 1..n.len() {
            if h[i + j].to_ascii_lowercase() != n[j] {
                continue 'outer;
            }
        }
        return true;
    }
    false
}

fn has_wildcards(pattern: &str) -> bool {
    pattern
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}'))
}

/// Baut den Matcher. Gegen welchen Text er laeuft — Dateiname oder ganzer Pfad
/// — entscheidet der Aufrufer; das Muster selbst ist in beiden Faellen gleich.
pub fn build(pattern: &str, mode: MatchMode, case_sensitive: bool) -> Result<Matcher, String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Ok(Matcher::All);
    }

    let effective = match mode {
        MatchMode::Auto => {
            if has_wildcards(pattern) {
                MatchMode::Wildcard
            } else {
                MatchMode::Substring
            }
        }
        other => other,
    };

    match effective {
        MatchMode::Regex => RegexBuilder::new(pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(8 << 20)
            .build()
            .map(Matcher::Regex)
            .map_err(|e| format!("Ungueltige Regex: {e}")),

        MatchMode::Wildcard => {
            let glob: Glob = GlobBuilder::new(pattern)
                .case_insensitive(!case_sensitive)
                // `*` darf Ordnergrenzen ueberschreiten. Beim Suchen im ganzen
                // Pfad ist das entscheidend: `*proof*.def` soll auch greifen,
                // wenn "proof" in einem Ordnernamen steckt und nicht im
                // Dateinamen. `**` bleibt weiterhin nutzbar.
                .literal_separator(false)
                // Unter Windows ist `\` ein Pfadtrenner, kein Escape-Zeichen.
                .backslash_escape(false)
                .build()
                .map_err(|e| format!("Ungueltiges Wildcard-Muster: {e}"))?;
            Ok(Matcher::Glob(glob.compile_matcher()))
        }

        // Auto ist oben bereits aufgeloest.
        MatchMode::Substring | MatchMode::Auto => {
            if case_sensitive {
                Ok(Matcher::Substring(pattern.to_string()))
            } else if pattern.is_ascii() {
                Ok(Matcher::SubstringCi(pattern.to_ascii_lowercase()))
            } else {
                Ok(Matcher::SubstringUnicodeCi(pattern.to_lowercase()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, mode: MatchMode, cs: bool) -> Matcher {
        build(pattern, mode, cs).expect("matcher baut")
    }

    #[test]
    fn substring_ist_case_insensitiv() {
        let matcher = m("report", MatchMode::Auto, false);
        assert!(matcher.is_match("Quartalsreport.pdf"));
        assert!(!matcher.is_match("Rechnung.pdf"));
    }

    #[test]
    fn substring_respektiert_case_sensitive() {
        let matcher = m("Report", MatchMode::Auto, true);
        assert!(matcher.is_match("Report.pdf"));
        assert!(!matcher.is_match("report.pdf"));
    }

    #[test]
    fn umlaute_werden_case_insensitiv_gefunden() {
        let matcher = m("prüfung", MatchMode::Auto, false);
        assert!(matcher.is_match("PRÜFUNG-2024.docx"));
    }

    #[test]
    fn auto_erkennt_wildcards() {
        let matcher = m("*.txt", MatchMode::Auto, false);
        assert!(matcher.is_match("notizen.txt"));
        assert!(!matcher.is_match("notizen.md"));
    }

    #[test]
    fn wildcard_fragezeichen_und_klassen() {
        let matcher = m("bild_?.{png,jpg}", MatchMode::Wildcard, false);
        assert!(matcher.is_match("bild_1.png"));
        assert!(matcher.is_match("bild_9.jpg"));
        assert!(!matcher.is_match("bild_12.png"));
    }

    #[test]
    fn wildcard_im_vollen_pfad_matcht_ueber_ordner() {
        let matcher = m("*.txt", MatchMode::Wildcard, false);
        assert!(matcher.is_match("C:/Projekte/notizen.txt"));
        assert!(matcher.is_match(r"C:\Projekte\notizen.txt"));
    }

    /// Der Suchbegriff darf auch in einem Ordnernamen stecken, nicht nur im
    /// Dateinamen: `*proof*.def` muss im Pfadmodus ueber Ordnergrenzen greifen.
    #[test]
    fn wildcard_findet_muster_im_ordnernamen() {
        let matcher = m("*proof*.def", MatchMode::Wildcard, false);
        assert!(matcher.is_match(r"C:\Projekte\proof_stuff\xyz.def"));
        assert!(matcher.is_match("C:/Projekte/proof_stuff/xyz.def"));
        // Auch der klassische Fall im Dateinamen selbst.
        assert!(matcher.is_match(r"C:\Projekte\mein_proof_v2.def"));
        // Falsche Endung bleibt aussen vor.
        assert!(!matcher.is_match(r"C:\Projekte\proof_stuff\xyz.txt"));
        // "proof" muss irgendwo vorkommen.
        assert!(!matcher.is_match(r"C:\Projekte\andere\xyz.def"));
    }

    #[test]
    fn doppelstern_bleibt_nutzbar() {
        let matcher = m("**/berichte/*.pdf", MatchMode::Wildcard, false);
        assert!(matcher.is_match(r"C:\Firma\2024\berichte\q1.pdf"));
        assert!(!matcher.is_match(r"C:\Firma\2024\anhang\q1.pdf"));
    }

    #[test]
    fn leeres_muster_matcht_alles() {
        let matcher = m("   ", MatchMode::Auto, false);
        assert!(matcher.is_match("irgendwas"));
    }

    #[test]
    fn ungueltige_regex_meldet_fehler() {
        assert!(build("([a-z", MatchMode::Regex, false).is_err());
    }
}
