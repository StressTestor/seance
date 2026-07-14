// Read-only, locale-safe time formatting. No mutation, no network.

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "22:14:07" from epoch ms. */
export function clockTime(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "--:--:--";
  return TIME.format(new Date(tsMs));
}

/** A human day label for date dividers; "TONIGHT" for today. */
export function dayLabel(tsMs: number): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "UNKNOWN";
  const d = new Date(tsMs);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? "TONIGHT" : DAY.format(d).toUpperCase();
}

/** A stable day bucket key (local midnight) for grouping. */
export function dayKey(tsMs: number): number {
  const d = new Date(tsMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
