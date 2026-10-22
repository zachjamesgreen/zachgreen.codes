// Facts about the two self-hosted typefaces (spec §5.3) that site.css and the
// tests rely on.
//
// - MONOLISA_RANGES: the MonoLisa subsets the site ships. site.css has one
//   @font-face per range and style, and nothing else draws text in MonoLisa.
// - codePointsOutside: the characters of a text that those subsets can't draw,
//   which the browser then takes from the fallback font instead.
// - fallbackOverrides: the size-adjust and ascent/descent/line-gap overrides
//   that make a local monospace font take up the same space as the web font,
//   so the swap doesn't move the layout. Metrics come from @capsizecss/unpack.
//
//   node scripts/font-metrics.ts             prints the fallback @font-face descriptors
//   node scripts/font-metrics.ts --coverage  lists characters in site/**/*.html outside MONOLISA_RANGES
//
//   --fonts <dir>      where the woff2 files are (default site/fonts)
//   --fallback <file>  the local fallback font (default: DejaVu Sans Mono, found with fc-match)
//
// The fallback faces in site.css list Menlo, DejaVu Sans Mono, Liberation Mono
// and Courier New. Menlo is derived from DejaVu Sans Mono and has the same
// advance width (1233/2048 em). Liberation Mono and Courier New are 1229/2048,
// 0.3% narrower, so one set of descriptors serves all four. Consolas (0.55 em)
// is left out because it would need its own.

import { execFileSync } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** An inclusive range of code points, as in a `unicode-range` of `U+first-last`. */
export type Range = readonly [first: number, last: number];

export interface Subset {
  normal: string;
  italic: string;
  range: Range;
}

/**
 * Every subset in MonoLisa's web package, as listed in the vendor's
 * monolisa.css. Each file holds only glyphs inside its range, and there is no
 * Latin-1 or General Punctuation subset: é, — and ’ are not in MonoLisa at all.
 */
export const MONOLISA_SUBSETS: readonly Subset[] = [
  { normal: "0-MonoLisaCode-normal.woff2", italic: "1-MonoLisaCode-italic.woff2", range: [0x0020, 0x007f] },
  { normal: "2-MonoLisaCode-normal.woff2", italic: "3-MonoLisaCode-italic.woff2", range: [0x2600, 0x26ff] },
  { normal: "4-MonoLisaCode-normal.woff2", italic: "5-MonoLisaCode-italic.woff2", range: [0x2300, 0x23ff] },
  { normal: "6-MonoLisaCode-normal.woff2", italic: "7-MonoLisaCode-italic.woff2", range: [0x2100, 0x214f] },
  { normal: "8-MonoLisaCode-normal.woff2", italic: "9-MonoLisaCode-italic.woff2", range: [0x2190, 0x21ff] },
  { normal: "10-MonoLisaCode-normal.woff2", italic: "11-MonoLisaCode-italic.woff2", range: [0x2b00, 0x2bff] },
  { normal: "12-MonoLisaCode-normal.woff2", italic: "13-MonoLisaCode-italic.woff2", range: [0x20a0, 0x20cf] },
  { normal: "14-MonoLisaCode-normal.woff2", italic: "15-MonoLisaCode-italic.woff2", range: [0x2200, 0x22ff] },
  { normal: "16-MonoLisaCode-normal.woff2", italic: "17-MonoLisaCode-italic.woff2", range: [0x2580, 0x259f] },
  { normal: "18-MonoLisaCode-normal.woff2", italic: "19-MonoLisaCode-italic.woff2", range: [0x25a0, 0x25ff] },
  { normal: "20-MonoLisaCode-normal.woff2", italic: "21-MonoLisaCode-italic.woff2", range: [0x2500, 0x257f] },
  { normal: "22-MonoLisaCode-normal.woff2", italic: "23-MonoLisaCode-italic.woff2", range: [0x0300, 0x036f] },
  { normal: "24-MonoLisaCode-normal.woff2", italic: "25-MonoLisaCode-italic.woff2", range: [0x02b0, 0x02ff] },
  { normal: "26-MonoLisaCode-normal.woff2", italic: "27-MonoLisaCode-italic.woff2", range: [0xe000, 0xf8ff] },
];

/**
 * The ranges the site ships, in ascending order: Basic Latin (`0-`/`1-`), box
 * drawing for the terminal UI snapshot (`20-`/`21-`) and Miscellaneous Symbols
 * (`2-`/`3-`). The last file has only 18 glyphs in it (☐ ☑ ☒ ☺ ♥ and a few
 * more); it does not have ★.
 */
export const MONOLISA_RANGES: readonly Range[] = [
  [0x0020, 0x007f],
  [0x2500, 0x257f],
  [0x2600, 0x26ff],
];

const covers = (ranges: readonly Range[], cp: number) => ranges.some(([first, last]) => cp >= first && cp <= last);

/** The code points in `text` that no range covers, each once, ascending. Whitespace is ignored. */
export function codePointsOutside(text: string, ranges: readonly Range[]): number[] {
  const outside = new Set<number>();
  for (const char of text) {
    if (/^\s$/u.test(char)) continue;
    const cp = char.codePointAt(0)!;
    if (!covers(ranges, cp)) outside.add(cp);
  }
  return [...outside].sort((a, b) => a - b);
}

/** The vendor subset whose range holds `cp`, or undefined when MonoLisa has no file for it. */
export function subsetOf(cp: number): Subset | undefined {
  return MONOLISA_SUBSETS.find(({ range }) => covers([range], cp));
}

/** The font metrics @capsizecss/unpack reports, in font units. */
export interface Metrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  xWidthAvg: number;
}

/** Ratios, so 1 is 100%. */
export interface Overrides {
  sizeAdjust: number;
  ascentOverride: number;
  descentOverride: number;
  lineGapOverride: number;
}

/**
 * Capsize's method: scale the fallback until its average character width
 * equals the web font's, then state the web font's ascent, descent and line
 * gap as fractions of that scaled em.
 */
export function fallbackOverrides(font: Metrics, fallback: Pick<Metrics, "unitsPerEm" | "xWidthAvg">): Overrides {
  const sizeAdjust = font.xWidthAvg / font.unitsPerEm / (fallback.xWidthAvg / fallback.unitsPerEm);
  const em = font.unitsPerEm * sizeAdjust;
  return {
    sizeAdjust,
    ascentOverride: font.ascent / em,
    descentOverride: Math.abs(font.descent) / em,
    lineGapOverride: font.lineGap / em,
  };
}

const percent = (ratio: number) => `${Number((ratio * 100).toFixed(2))}%`;

/** The overrides as @font-face descriptor lines, ready to paste into site.css. */
export function fontFaceDescriptors(overrides: Overrides): string {
  return [
    `size-adjust: ${percent(overrides.sizeAdjust)};`,
    `ascent-override: ${percent(overrides.ascentOverride)};`,
    `descent-override: ${percent(overrides.descentOverride)};`,
    `line-gap-override: ${percent(overrides.lineGapOverride)};`,
  ].join("\n");
}

/** The visible text of an HTML file: no tags, comments, scripts or styles, entities decoded. */
function htmlText(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
      if (body[0] !== "#") return named[body.toLowerCase()] ?? entity;
      return String.fromCodePoint(body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1)));
    });
}

const label = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(cp)}`;

async function printCoverage(): Promise<void> {
  const byChar = new Map<number, Set<string>>();
  for await (const path of glob("site/**/*.html")) {
    for (const cp of codePointsOutside(htmlText(await readFile(path, "utf8")), MONOLISA_RANGES)) {
      byChar.set(cp, (byChar.get(cp) ?? new Set()).add(path));
    }
  }
  if (byChar.size === 0) {
    console.log("Every character in site/**/*.html is inside the shipped MonoLisa ranges.");
    return;
  }
  console.log("Characters outside the shipped MonoLisa ranges (headings are set in Calling Code, so not every hit matters):");
  for (const cp of [...byChar.keys()].sort((a, b) => a - b)) {
    const subset = subsetOf(cp);
    const where = subset ? `in ${subset.normal} / ${subset.italic}` : "in no MonoLisa file";
    console.log(`  ${label(cp)}  ${where}  (${[...byChar.get(cp)!].join(", ")})`);
  }
}

async function printDescriptors(fontsDir: string, fallbackFile: string): Promise<void> {
  const { fromFile } = await import("@capsizecss/unpack/fs");
  const fallback = await fromFile(fallbackFile);
  console.log(`Fallback: ${fallback.fullName} (${fallbackFile}), xWidthAvg ${fallback.xWidthAvg}/${fallback.unitsPerEm}\n`);
  const faces = [
    ["MonoLisa Fallback (from 0-MonoLisaCode-normal)", "0-MonoLisaCode-normal.woff2"],
    ["MonoLisa Fallback (from 1-MonoLisaCode-italic)", "1-MonoLisaCode-italic.woff2"],
    ["Calling Code Fallback 400 (from regular)", "callingcode-regular-webfont.woff2"],
    ["Calling Code Fallback 400 italic (from italic)", "callingcode-italic-webfont.woff2"],
    ["Calling Code Fallback 700 (from bold)", "callingcode-bold-webfont.woff2"],
    ["Calling Code Fallback 700 italic (from bolditalic)", "callingcode-bolditalic-webfont.woff2"],
  ] as const;
  for (const [title, file] of faces) {
    const metrics = await fromFile(join(fontsDir, file));
    const { unitsPerEm, ascent, descent, lineGap, xWidthAvg } = metrics;
    console.log(`/* ${title}: upm ${unitsPerEm}, ascent ${ascent}, descent ${descent}, lineGap ${lineGap}, xWidthAvg ${xWidthAvg} */`);
    console.log(`${fontFaceDescriptors(fallbackOverrides(metrics, fallback))}\n`);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      coverage: { type: "boolean", default: false },
      fonts: { type: "string", default: "site/fonts" },
      fallback: { type: "string" },
    },
  });
  if (values.coverage) {
    await printCoverage();
  } else {
    const fallback =
      values.fallback ?? execFileSync("fc-match", ["--format=%{file}", "DejaVu Sans Mono"], { encoding: "utf8" }).trim();
    await printDescriptors(values.fonts, fallback);
  }
}
