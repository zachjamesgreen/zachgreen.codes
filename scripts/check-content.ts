// Content guard for everything under site/: no phone number, and none of the
// terms that must stay off the site (Settlor's internal names). The repo is
// public, so the terms are not in it: they are read at run time from
//   - FORBIDDEN_TERMS, comma- or newline-separated (in CI, a repository secret), and
//   - .forbidden-terms in the working directory (the repo root): one term per
//     line, `#` starts a comment. It is gitignored.
// Both are read and combined. With no term from either, the check fails rather
// than pass on a scan that could never find one. A hit is reported by file, line,
// column and kind only: the matched text is never printed, as the logs are public.
//
//   node scripts/check-content.ts          scans site/**/*.{html,css,txt,xml,svg}
//   ... | node scripts/check-content.ts --stdin   scans piped text instead

import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { text as readAll } from "node:stream/consumers";
import { parseArgs } from "node:util";

export const TERMS_FILE = ".forbidden-terms";

export const NO_TERMS = [
  "No forbidden terms to check for, so the content check fails closed. Give it at least one term:",
  "  - FORBIDDEN_TERMS: comma- or newline-separated. In CI it comes from the repository secret of that name.",
  `  - ${TERMS_FILE} in the repo root: one term per line, # starts a comment. It is gitignored; never commit it.`,
].join("\n");

/** One space as HTML source can spell it: whitespace (NBSP included) or an NBSP character reference. */
const SPACE = String.raw`(?:\s|&nbsp;|&NonBreakingSpace;|&#0*160;|&#x0*a0;)`;

/** A letter, combining mark or digit. None may touch a term, so a term never matches inside a longer word. */
const WORD = String.raw`[\p{L}\p{M}\p{N}]`;

/**
 * A hyphen as HTML source can spell it: `-`, a typographic dash or hyphen (U+2010 to
 * U+2014, U+2212), or a character reference to one of those: &ndash;, &mdash;,
 * &minus;, or &#8208;-&#8212; / &#8722; and &#x2010;-&#x2014; / &#x2212; (leading
 * zeros allowed). It is matched in place, as SPACE is, not by rewriting the text
 * first, so a hit's index stays an index into the source.
 */
const DASH = String.raw`(?:-|[\u2010-\u2014\u2212]|&(?:ndash|mdash|minus|#0*(?:820[89]|821[0-2]|8722)|#x0*(?:201[0-4]|2212));)`;

/** What may sit between the groups of a phone number: a space, `.`, or a dash. */
const SEPARATOR = String.raw`(?:${SPACE}|\.|${DASH})`;

// A 10-digit NANP number: optional +1, optional parentheses around the area
// code, and one separator between the groups (or nothing at all). Area code and
// exchange start with 2-9. The lookarounds keep it from matching inside a
// longer digit run or a decimal such as 0.7205550100. The group's name is how
// findForbidden tells a number from a term.
const PHONE = String.raw`(?<phone>(?<![\d.])(?:\+?1${SEPARATOR}?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})${SEPARATOR}?[2-9]\d{2}${SEPARATOR}?\d{4}(?!\d))`;

/**
 * A term as a pattern: its words, with any run of whitespace or NBSP references
 * between them and any spelling of a hyphen where it has one, and no letter or
 * digit on either side. Undefined for a blank term.
 */
function termPattern(term: string): string | undefined {
  const words = term.replace(new RegExp(SPACE, "giv"), " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const spelled = words.map((word) =>
    word
      .split(/[-\u2010-\u2014\u2212]/)
      .map((part) => RegExp.escape(part))
      .join(DASH),
  );
  return `(?<!${WORD})${spelled.join(`${SPACE}+`)}(?!${WORD})`;
}

/**
 * One hit of the guard. `term` is the text as found, for the caller to compare:
 * it can be a forbidden name or a phone number, and the output goes to public logs,
 * so print `index` and `kind`, never `term` (see hitSummary).
 */
export type Hit = { kind: "term" | "phone"; term: string; index: number };

/** Every forbidden term (in any letter case) or phone number in `text`: which, the text as found, and where. */
export function findForbidden(text: string, terms: readonly string[]): Hit[] {
  // Longest first, so a term that contains another is reported whole.
  const names = terms
    .map(termPattern)
    .filter((pattern) => pattern !== undefined)
    .toSorted((a, b) => b.length - a.length);
  const forbidden = new RegExp([...names, PHONE].join("|"), "giv");
  return [...text.matchAll(forbidden)].map((match) => ({
    kind: match.groups?.phone === undefined ? "term" : "phone",
    term: match[0],
    index: match.index,
  }));
}

/** How many hits there are and at which character offsets, for a failure message. Never the text found. */
export function hitSummary(hits: readonly Pick<Hit, "index">[]): string {
  if (hits.length === 0) return "no forbidden terms or phone numbers";
  const s = hits.length === 1 ? "" : "s";
  return `${hits.length} forbidden term${s} or phone number${s}, at character offset${s} ${hits.map(({ index }) => index).join(", ")}`;
}

/** The terms in a FORBIDDEN_TERMS value: separated by commas or newlines. */
export function termsFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/** The terms in a .forbidden-terms file: one per line, `#` to the end of the line is a comment. */
export function termsFromFile(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** The terms from FORBIDDEN_TERMS and from `cwd`'s .forbidden-terms, combined. Empty when neither has one. */
export async function loadForbiddenTerms({ env = process.env, cwd = process.cwd() } = {}): Promise<string[]> {
  let file = "";
  try {
    file = await readFile(join(cwd, TERMS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...new Set([...termsFromEnv(env.FORBIDDEN_TERMS), ...termsFromFile(file)])];
}

function report(label: string, content: string, terms: readonly string[]): number {
  const hits = findForbidden(content, terms);
  // The location and the kind of hit, never the text: CI logs are public, and a
  // matched term or number is exactly what must not be in them.
  for (const { kind, index } of hits) {
    const before = content.slice(0, index);
    const line = before.split("\n").length;
    const column = index - (before.lastIndexOf("\n") + 1) + 1;
    console.error(`${label}:${line}:${column}  ${kind === "phone" ? "phone number" : "forbidden term"}`);
  }
  return hits.length;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { stdin: { type: "boolean", default: false } } });
  const terms = await loadForbiddenTerms();
  if (terms.length === 0) {
    console.error(NO_TERMS);
    process.exit(1);
  }
  let hits = 0;
  let summary: string | undefined;
  if (values.stdin) {
    hits = report("stdin", await readAll(process.stdin), terms);
  } else {
    let scanned = 0;
    for await (const path of glob("site/**/*.{html,css,txt,xml,svg}")) {
      scanned++;
      hits += report(path, await readFile(path, "utf8"), terms);
    }
    // A scan of nothing proves nothing (wrong directory, moved site/), so it fails.
    if (scanned === 0) {
      console.error("No files to scan: nothing matched site/**/*.{html,css,txt,xml,svg}. Run from the repo root.");
      process.exit(1);
    }
    summary = `scanned ${scanned} file${scanned === 1 ? "" : "s"}`;
  }
  if (hits > 0) {
    console.error(`${hits} forbidden term${hits === 1 ? "" : "s"} or phone number${hits === 1 ? "" : "s"} found`);
    process.exit(1);
  }
  if (summary !== undefined) console.log(summary);
}
