// The two typefaces are commercial and the repo is public, so no
// font file may ever be tracked. Used by CI and by the pre-commit hook.
//
//   node scripts/check-no-fonts.ts            checks every tracked file
//   node scripts/check-no-fonts.ts --staged   checks only what is staged

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const FONT_EXTENSION = /\.(?:woff2?|ttf|otf)$/i;

/** The paths that are font files, in input order. */
export function findTrackedFonts(paths: string[]): string[] {
  return paths.filter((path) => FONT_EXTENSION.test(path));
}

function gitPaths(...args: string[]): string[] {
  // -z: NUL-separated and unquoted, so unusual file names can't hide an extension.
  return execFileSync("git", [...args, "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { staged: { type: "boolean", default: false } } });
  // --diff-filter=d leaves out staged deletions, so removing a font is never blocked.
  const paths = values.staged
    ? gitPaths("diff", "--cached", "--name-only", "--diff-filter=d")
    : gitPaths("ls-files");
  const fonts = findTrackedFonts(paths);
  if (fonts.length > 0) {
    console.error(`Font files must never be committed (the typefaces are commercial):\n${fonts.map((path) => `  ${path}`).join("\n")}`);
    process.exit(1);
  }
}
