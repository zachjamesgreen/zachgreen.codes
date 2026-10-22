// Content guard for everything under site/ (spec §6.1, §6.2): no internal
// Settlor names and no phone number. Scans only site/, because the spec and the
// plan list the forbidden names on purpose.
//
//   node scripts/check-content.ts          scans site/**/*.{html,css,txt,xml,svg}
//   ... | node scripts/check-content.ts --stdin   scans piped text instead

import { glob, readFile } from "node:fs/promises";
import { text as readAll } from "node:stream/consumers";
import { parseArgs } from "node:util";

export const FORBIDDEN_TERMS = ["redacted-a", "redacted-b", "redacted-c", "redacted-d"] as const;

// A word break in the source must not hide a name, so spaces match any whitespace.
const NAMES = FORBIDDEN_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+"));

// A 10-digit NANP number: optional +1, optional parentheses around the area
// code, and `-`, `.` or a space between the groups (or nothing at all). Area
// code and exchange start with 2-9. The lookarounds keep it from matching
// inside a longer digit run or a decimal such as 0.7205550100.
const PHONE = String.raw`(?<![\d.])(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)`;

const FORBIDDEN = new RegExp(`${NAMES.join("|")}|${PHONE}`, "gi");

/** Every forbidden name or phone number in `text`: the text as found, and where. */
export function findForbidden(text: string): { term: string; index: number }[] {
  return [...text.matchAll(FORBIDDEN)].map((match) => ({ term: match[0], index: match.index }));
}

function report(label: string, content: string): number {
  const hits = findForbidden(content);
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
  let hits = 0;
  let summary: string | undefined;
  if (values.stdin) {
    hits = report("stdin", await readAll(process.stdin));
  } else {
    let scanned = 0;
    for await (const path of glob("site/**/*.{html,css,txt,xml,svg}")) {
      scanned++;
      hits += report(path, await readFile(path, "utf8"));
    }
    // A scan of nothing proves nothing (wrong directory, moved site/), so it fails.
    if (scanned === 0) {
      console.error("No files to scan: nothing matched site/**/*.{html,css,txt,xml,svg}. Run from the repo root.");
      process.exit(1);
    }
    summary = `scanned ${scanned} file${scanned === 1 ? "" : "s"}`;
  }
  if (hits > 0) {
    console.error(`${hits} forbidden term${hits === 1 ? "" : "s"} found (spec §6.1, §6.2)`);
    process.exit(1);
  }
  if (summary !== undefined) console.log(summary);
}
