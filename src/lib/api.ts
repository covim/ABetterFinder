import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MatchMode = "auto" | "wildcard" | "regex" | "substring";
export type DateField = "modified" | "created";

export interface SearchQuery {
  pattern: string;
  roots: string[];
  mode: MatchMode;
  caseSensitive: boolean;
  matchFullPath: boolean;
  includeHidden: boolean;
  includeFiles: boolean;
  includeDirs: boolean;
  followLinks: boolean;
  dateField: DateField;
  /** Millisekunden seit Epoch, inklusiv. */
  dateFrom: number | null;
  /** Millisekunden seit Epoch, inklusiv. */
  dateTo: number | null;
  maxResults: number;
}

export interface SearchHit {
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
  modified: number | null;
  created: number | null;
}

export interface HitsEvent {
  id: number;
  hits: SearchHit[];
}

export interface ProgressEvent {
  id: number;
  scanned: number;
  matched: number;
  elapsedMs: number;
}

export interface DoneEvent extends ProgressEvent {
  truncated: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface DriveInfo {
  path: string;
  label: string;
}

/** Ein gemapptes Netzlaufwerk und die Freigabe, auf die es zeigt. */
export interface DriveMapping {
  /** Laufwerksbuchstabe mit Doppelpunkt, z. B. `Z:`. */
  letter: string;
  /** Freigabe ohne abschliessenden Backslash, z. B. `\\server\share`. */
  unc: string;
}

export const startSearch = (query: SearchQuery): Promise<number> =>
  invoke<number>("start_search", { query });

export const cancelSearch = (): Promise<void> => invoke("cancel_search");

export const listDrives = (): Promise<DriveInfo[]> =>
  invoke<DriveInfo[]>("list_drives");

export const listUncMappings = (): Promise<DriveMapping[]> =>
  invoke<DriveMapping[]>("list_unc_mappings");

/** Behaelt nur die Pfade, die es noch gibt. */
export const filterExistingPaths = (paths: string[]): Promise<string[]> =>
  invoke<string[]>("filter_existing_paths", { paths });

/** Explorer oeffnen und den Eintrag darin markieren. */
export const revealInExplorer = (path: string): Promise<void> =>
  invoke("reveal_in_explorer", { path });

export const openContainingFolder = (path: string): Promise<void> =>
  invoke("open_containing_folder", { path });

export const openPath = (path: string): Promise<void> =>
  invoke("open_path", { path });

export const onHits = (cb: (e: HitsEvent) => void): Promise<UnlistenFn> =>
  listen<HitsEvent>("search:hits", (e) => cb(e.payload));

export const onProgress = (cb: (e: ProgressEvent) => void): Promise<UnlistenFn> =>
  listen<ProgressEvent>("search:progress", (e) => cb(e.payload));

export const onDone = (cb: (e: DoneEvent) => void): Promise<UnlistenFn> =>
  listen<DoneEvent>("search:done", (e) => cb(e.payload));
