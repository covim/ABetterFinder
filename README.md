# A Better Finder

Schnelle Dateisuche für Windows — Tauri 2 + Rust im Backend, React + shadcn/ui im Frontend.

## Starten

```bash
npm install          # einmalig
npm run app          # Entwicklungsmodus (tauri dev)
npm run app:build    # eigenständige exe
```

`app:build` läuft mit `--no-bundle` und `bundle.active = false` in
[tauri.conf.json](src-tauri/tauri.conf.json) — es entstehen bewusst **keine
Installer** (MSI/NSIS), sondern nur:

```
src-tauri/target/release/abetterfinder.exe    (~5,6 MB)
```

Die exe ist eigenständig und braucht keine Installation. Voraussetzung ist
lediglich die WebView2-Runtime, die unter Windows 10/11 zum System gehört.

Die fertige exe wird zusätzlich nach [bin/](bin/) kopiert. Der Ordner
`src-tauri/target/` ist reiner Build-Cache und kann jederzeit gelöscht werden —
der nächste Build erzeugt ihn neu (dauert dann einige Minuten, weil alle
Abhängigkeiten erneut kompiliert werden).

## Funktionen

**Wildcards.** Das Suchfeld akzeptiert Glob-Muster:

| Muster | Bedeutung | Beispiel |
| --- | --- | --- |
| `*` | beliebig viele Zeichen | `*.pdf` |
| `?` | genau ein Zeichen | `bericht_202?.xlsx` |
| `{a,b}` | Alternativen | `foto*.{jpg,png}` |
| `[0-9]` | Zeichenklasse | `IMG_[0-9][0-9].jpg` |

Der Modus **Automatisch** entscheidet selbst: Enthält die Eingabe eines dieser
Zeichen, wird als Wildcard gesucht, sonst als einfacher Teilstring. Wer das
nicht will, stellt **Wildcards**, **Enthält Text** oder **Regex** fest ein.

`*` überschreitet dabei Ordnergrenzen. Mit gesetztem Haken **Im ganzen Pfad
suchen** wirkt das Muster deshalb auf den kompletten Pfad und nicht nur auf den
Dateinamen: `*proof*.def` findet auch `C:\Projekte\proof_stuff\xyz.def`, wo
"proof" im Ordnernamen steckt. `**` bleibt für explizit segmentweise Muster
nutzbar, etwa `**/berichte/*.pdf`.

**Datumsfilter beim Suchen.** Die Filter sind Teil der Suchanfrage und werden im
Rust-Backend während des Scans ausgewertet — es wird also nicht erst alles
gesucht und danach gefiltert. Umschaltbar zwischen *Geändert* und *Erstellt*,
mit Von/Bis-Feldern (beide Grenzen inklusiv) und den Presets Heute / 7 Tage /
30 Tage / 1 Jahr.

**Explorer-Button pro Treffer.** Jede Ergebniszeile hat einen fest sichtbaren
Button, der den Explorer öffnet und die Datei darin markiert (`explorer.exe
/select,<pfad>`). Daneben: enthaltenden Ordner öffnen, mit Standardprogramm
öffnen, Pfad kopieren.

**Trefferhervorhebung.** Die passenden Textstellen werden im Namen (und im
Pfad) farbig markiert. Bei Teilstring-Suche sind das alle Fundstellen, bei
Wildcards die festen Textteile des Musters in ihrer Reihenfolge, bei Regex die
Treffer des Ausdrucks. Maßgeblich ist immer das *ausgeführte* Muster, nicht das
gerade Getippte — die Markierung springt beim Weitertippen also nicht herum.

**Kompakte Zeilen.** Eine Ergebniszeile ist 28 px hoch und einzeilig: Name,
Ordner, Größe, Datum und Aktionen nebeneinander. Auf einen Bildschirm passt
damit rund die dreifache Trefferzahl gegenüber einem zweizeiligen Layout.

**Optionale Ordner-Clusterung.** Der Schalter *Nach Ordner gruppieren* fasst die
Treffer unter einem Kopf je Ordner zusammen, mit Trefferzahl und einem eigenen
Explorer-Button für den Ordner. Gruppen lassen sich zuklappen; die Pfadspalte
entfällt dann, weil sie im Gruppenkopf steht.

**Weitere Optionen** (Zahnrad-Button): Dateien/Ordner einbeziehen, versteckte und
Systemdateien, Groß-/Kleinschreibung, Suche im gesamten Pfad statt nur im
Dateinamen, Trefferlimit.

## Tastenkürzel

| Taste | Wirkung |
| --- | --- |
| `Strg`+`F` | Suchfeld fokussieren |
| `Enter` | Suche starten; in der Liste: Datei öffnen bzw. Gruppe auf-/zuklappen |
| `Esc` | laufende Suche abbrechen |
| `↑` / `↓` | Zeile auswählen |
| `←` / `→` | Ordnergruppe zu-/aufklappen |
| Doppelklick | Datei öffnen |

## Warum es schnell ist

- **Paralleler Walk.** `ignore::WalkBuilder` läuft mit `2 × CPU-Kerne` Threads
  (max. 32) über alle Wurzelverzeichnisse. Der Scan ist I/O-gebunden, deshalb
  zahlen sich mehr Threads als Kerne aus.
- **Keine Ignore-Regeln.** `standard_filters(false)` — ein Dateimanager darf
  nichts wegen einer `.gitignore` verstecken, und die Regelauswertung entfällt.
- **Muster einmal kompilieren.** Glob bzw. Regex wird vor dem Start gebaut und
  von allen Threads geteilt. Bei ASCII-Mustern läuft der Teilstring-Vergleich
  ohne Allokation.
- **Metadaten aus dem Verzeichnis-Eintrag.** Unter Windows liefert die
  Verzeichnis-Enumeration Größe und Zeitstempel bereits mit; es ist kein
  zusätzlicher `stat`-Aufruf pro Datei nötig.
- **Treffer erscheinen sofort.** Jeder Treffer landet unmittelbar im
  gemeinsamen Puffer; ein Emitter-Thread leert diesen alle 60 ms und schickt
  den Inhalt als *ein* Event ans Frontend. Die Anzeige hängt damit höchstens
  60 ms hinter dem Fund her — unabhängig davon, ob die Suche drei Treffer
  liefert oder dreißigtausend, und ohne pro Datei die IPC-Brücke zu belasten.
  Bewusst gibt es *keine* thread-lokale Zwischenpufferung: die würde einzelne
  Treffer bis zum Ende des Scans zurückhalten.
- **Virtualisierte Liste.** Es werden nur die sichtbaren Zeilen gerendert, damit
  auch 50.000 Treffer flüssig scrollen. Gruppenköpfe und Trefferzeilen sind
  gleich hoch, dadurch bleibt die Positionsrechnung eine Multiplikation ohne
  Höhenmessung.
- **Hervorhebung nur im Sichtbereich.** Die Trefferbereiche werden im Frontend
  und nur für die ~40 gerenderten Zeilen berechnet. Der Rust-Scan bleibt davon
  unberührt.
- **Sofortiger Abbruch.** Jede neue Suche erhöht einen Generations-Zähler; alte
  Worker steigen beim nächsten Eintrag aus. Die Live-Suche beim Tippen ist
  dadurch unproblematisch.

### Grenzen

Die Suche scannt das Dateisystem live. Das ist ohne Vorbereitung und ohne
Hintergrunddienst sofort einsatzbereit, aber ein indexbasiertes Werkzeug wie
*Everything* ist beim ersten Durchlauf über ein ganzes Laufwerk schneller — es
liest die NTFS-MFT direkt, was Administratorrechte und einen laufenden Index
voraussetzt. Nach dem ersten Scan ist der Windows-Dateisystem-Cache warm und
Folgesuchen im selben Baum sind deutlich schneller.

## Aufbau

```
src/                      React-Frontend
  App.tsx                 Suchmaske, Filter, Status
  components/ResultList   virtualisierte Ergebnisliste
  components/RootPicker   Ordner- und Laufwerksauswahl
  components/ui/          shadcn/ui-Komponenten
  lib/api.ts              typisierte Brücke zu den Rust-Commands
src-tauri/src/
  matcher.rs              Musterkompilierung (Substring/Glob/Regex)
  search.rs               paralleler Scan, Filter, Event-Streaming
  sysops.rs               Explorer-Integration, Laufwerksliste
```

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Abgedeckt sind die Musterkompilierung (Wildcards, Groß-/Kleinschreibung,
Umlaute, ungültige Regex), die inklusiven Datumsgrenzen und die
Abbruch-Semantik des Generations-Zählers.
