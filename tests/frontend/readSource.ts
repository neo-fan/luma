/**
 * Shared helpers for the few source-contract tests that intentionally read
 * source text instead of rendering components (the Vitest env has no jsdom).
 *
 * The helpers make a missing anchor fail loudly. Plain `slice(indexOf(...))`
 * silently degrades to `slice(-1)` and turns the assertion into a tautology.
 */
export function requireAnchor(text: string, marker: string, label = marker): number {
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`source anchor missing: ${label}`);
  return at;
}

export function blockAfter(text: string, start: string, end: string, label = start): string {
  const from = requireAnchor(text, start, label);
  const tail = text.slice(from);
  const to = tail.indexOf(end, start.length);
  if (to < 0) throw new Error(`source block end missing: ${end} (after ${label})`);
  return tail.slice(0, to);
}

export function blockFrom(text: string, start: string, label = start): string {
  return text.slice(requireAnchor(text, start, label));
}
