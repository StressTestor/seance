// Shared palette constants for data-driven color. CSS owns structure and static
// color (via tokens in styles.css); these are the values views set inline via
// setStyles() from aggregate/verdict data — trusted, never from untrusted text.
// Kept in one place so the verdict/category language stays consistent across the
// timeline, the dashboard, and the presence.

export const HEX = "#ff2e88"; // magenta accent
export const EMBER = "#ff5c4d"; // deny
export const SPECTRAL = "#4e9e7b"; // pass
export const TOXIC = "#c4f92e"; // bypass alarm
export const AMBER = "#e8a33d"; // rule / fraying
export const INK = "#ede6d8";
export const SMOKE = "#9a9187";
export const INK_DIM = "#6b6560";
export const FAINT = "#423e48";
export const VIOLET = "#b78bff";

export const CATEGORY_COLORS: Record<string, string> = {
  "cred-access": "#e7c15a",
  "pipe-to-shell": "#9b7bff",
  destructive: "#ff7a3d",
  persistence: "#3fb5b0",
  "network-exfil": "#4fc2ff",
  unknown: "#a99db5",
};

export function catColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? FAINT;
}

/** The row/verdict color, bypass outranking the base verdict. */
export function verdictColor(verdict: string, bypass: boolean): string {
  if (bypass) return TOXIC;
  if (verdict === "deny") return EMBER;
  if (verdict === "loose") return INK_DIM;
  return SPECTRAL;
}
