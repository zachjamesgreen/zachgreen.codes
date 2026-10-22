// Content guard for everything under site/: no phone number, and none of the
// terms that must stay off the site (Settlor's internal names). The repo is
// public, so the terms are not in it: they are read at run time from
//   - FORBIDDEN_TERMS, comma- or newline-separated (in CI, a repository secret), and
//   - .forbidden-terms in the working directory (the repo root): one term per
//     line, `#` starts a comment. It is gitignored.
// Both are read and combined. With no term from either, the check fails rather
// than pass on a scan that could never find one.
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

/** What may sit between the groups of a phone number: a space, `.`, `-`, or a typographic dash or hyphen. */
const SEPARATOR = String.raw`(?:${SPACE}|[.\-‐-—−])`;

// A 10-digit NANP number: optional +1, optional parentheses around the area
// code, and one separator between the groups (or nothing at all). Area code and
// exchange start with 2-9. The lookarounds keep it from matching inside a
// longer digit run or a decimal such as 0.7205550100.
const PHONE = String.raw`(?<![\d.])(?:\+?1${SEPARATOR}?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})${SEPARATOR}?[2-9]\d{2}${SEPARATOR}?\d{4}(?!\d)`;

/**
 * A term as a pattern: its words, with any run of whitespace or NBSP references
 * between them, and no letter or digit on either side. Undefined for a blank term.
 */
function termPattern(term: string): string | undefined {
  const words = term.replace(new RegExp(SPACE, "giv"), " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return `(?<!${WORD})${words.map((word) => RegExp.escape(word)).join(`${SPACE}+`)}(?!${WORD})`;
}

/** Every forbidden term (in any letter case) or phone number in `text`: the text as found, and where. */
export function findForbidden(text: string, terms: readonly string[]): { term: string; index: number }[] {
  // Longest first, so a term that contains another is reported whole.
  const names = terms
    .map(termPattern)
    .filter((pattern) => pattern !== undefined)
    .toSorted((a, b) => b.length - a.length);
  const forbidden = new RegExp([...names, PHONE].join("|"), "giv");
  return [...text.matchAll(forbidden)].map((match) => ({ term: match[0], index: match.index }));
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
  for (const { term, index } of hits) {
    const before = content.slice(0, index);
    const line = before.split("\n").length;
    const column = index - (before.lastIndexOf("\n") + 1) + 1;
    console.error(`${label}:${line}:${column}  forbidden: ${JSON.stringify(term)}`);
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
