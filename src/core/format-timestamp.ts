// Compact local timestamp for CLI detail output: "YYYY-MM-DD HH:mm:ss".
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const UNITS: [seconds: number, suffix: string][] = [
  [31_536_000, "y"],
  [2_592_000, "mo"],
  [86_400, "d"],
  [3600, "h"],
  [60, "m"],
  [1, "s"],
];

// Age of `iso` relative to `now`, for CLI list output: "3d ago", "12m ago".
// A clock-skewed future timestamp reads as "just now" rather than a negative age.
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (seconds < 1) return "just now";
  for (const [unit, suffix] of UNITS) {
    if (seconds >= unit) return `${Math.floor(seconds / unit)}${suffix} ago`;
  }
  return "just now";
}
