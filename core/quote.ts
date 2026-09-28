/**
 * Finding a quoted passage again in a newer version of a text.
 *
 * Like a W3C TextQuoteSelector: the quote plus a little context on each side.
 * The occurrence whose surroundings match best wins; distance from the old
 * position only breaks ties. Shared by the server (feedback) and the UI.
 */

export const CONTEXT = 32;

export type Quote = { quote: string; source?: string; start: number; prefix?: string; suffix?: string };

/** Occurrences of `needle`, exact first, else whitespace-insensitive. */
export function occurrences(haystack: string, needle: string, limit = 500): [number, number][] {
  const found: [number, number][] = [];
  for (let at = haystack.indexOf(needle); at >= 0 && found.length < limit; at = haystack.indexOf(needle, at + 1)) found.push([at, at + needle.length]);
  if (found.length) return found;
  const words = needle.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return found;
  const pattern = new RegExp(words.join("\\s+"), "g");
  for (let m; (m = pattern.exec(haystack)) && found.length < limit;) found.push([m.index, m.index + m[0].length]);
  return found;
}

function commonSuffix(a: string, b: string) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
function commonPrefix(a: string, b: string) { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

export function locateQuote(text: string, q: Quote): [number, number] | null {
  for (const needle of [q.source, q.quote]) {
    if (!needle || !needle.trim()) continue;
    const hits = occurrences(text, needle);
    if (!hits.length) continue;
    let best = hits[0], bestScore = -1, bestDistance = Infinity;
    for (const hit of hits) {
      const score = (q.prefix ? commonSuffix(text.slice(Math.max(0, hit[0] - CONTEXT), hit[0]), q.prefix) : 0)
        + (q.suffix ? commonPrefix(text.slice(hit[1], hit[1] + CONTEXT), q.suffix) : 0);
      const distance = Math.abs(hit[0] - q.start);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) { best = hit; bestScore = score; bestDistance = distance; }
    }
    return best;
  }
  return null;
}

export const contextOf = (text: string, start: number, end: number) => ({
  prefix: text.slice(Math.max(0, start - CONTEXT), start),
  suffix: text.slice(end, end + CONTEXT),
});
