const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}

const dateTimeFormat = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  return dateTimeFormat.format(new Date(ms));
}

/** Ortszeit als `YYYY-MM-DDTHH:mm:ss` fuer den Export. Bewusst nicht
 *  `toISOString()`: das rechnet nach UTC um und verschiebt die Uhrzeiten
 *  gegenueber der Anzeige. */
export function toIsoLocal(ms: number | null): string {
  if (ms === null || ms === undefined) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const numberFormat = new Intl.NumberFormat("de-DE");

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `YYYY-MM-DD` aus einem Datumsfeld in Millisekunden zum Tagesbeginn. */
export function startOfDayMs(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** `YYYY-MM-DD` in Millisekunden zum Tagesende, damit "bis" inklusiv ist. */
export function endOfDayMs(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** Datum als `YYYY-MM-DD` fuer `<input type="date">`. */
export function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}
