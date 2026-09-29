import * as React from "react";

import type { HighlightRange } from "@/lib/highlight";

interface HighlightedProps {
  text: string;
  ranges: HighlightRange[];
}

/** Rendert den Text und hebt die uebergebenen Bereiche hervor. */
export const Highlighted = React.memo(function Highlighted({
  text,
  ranges,
}: HighlightedProps) {
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    // Defensiv: ueberlappende oder ungueltige Bereiche ueberspringen.
    if (range.start < cursor || range.end > text.length) continue;
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark
        key={range.start}
        className="rounded-[3px] bg-amber-300/45 px-px text-foreground dark:bg-amber-400/30"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
});
