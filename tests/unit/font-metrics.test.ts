import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { create } from "fontkitten";

import {
  MONOLISA_RANGES,
  codePointsOutside,
  fallbackOverrides,
  fontFaceDescriptors,
  subsetOf,
} from "../../scripts/font-metrics.ts";

const text = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const digits = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");
const hex = (cp: number) => `U+${digits(cp)}`;

const css = await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
  const get = (name: string) => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(body!)?.[1]?.trim();
  return {
    family: get("font-family")?.replace(/^["']|["']$/g, ""),
    style: get("font-style") ?? "normal",
    weight: get("font-weight"),
    unicodeRange: get("unicode-range"),
    src: get("src") ?? "",
    body: body!,
  };
});
const monolisaFaces = faces.filter((face) => face.family === "MonoLisa");

// The commercial fonts are never committed, so tests that open them only run
// where site/fonts/ exists; CI skips them.
const fontsDir = new URL("../../site/fonts/", import.meta.url);
const noFonts = !existsSync(fontsDir) && "site/fonts/ is absent (CI has no fonts), so the font files can't be read";

describe("MONOLISA_RANGES", () => {
  it("is Basic Latin without DEL, then box drawing, in ascending order", () => {
    assert.deepEqual(MONOLISA_RANGES, [
      [0x0020, 0x007e],
      [0x2500, 0x257f],
    ]);
  });

  // The guard against MONOLISA_RANGES claiming a glyph MonoLisa doesn't have:
  // every code point it lists must be in a font file site.css actually loads.
  for (const style of ["normal", "italic"] as const) {
    it(`has a glyph for every code point in the shipped ${style} files`, { skip: noFonts }, async () => {
      const files = monolisaFaces
        .filter((face) => face.style === style)
        .map((face) => /url\("?\/fonts\/([^")]+)"?\)/.exec(face.src)?.[1]);
      assert.ok(files.length > 0, `site.css loads no ${style} MonoLisa file`);
      const glyphs = new Set<number>();
      for (const file of files) {
        assert.ok(file, `a ${style} MonoLisa face has no /fonts/ url`);
        const font = create(await readFile(new URL(file, fontsDir)));
        if (font.isCollection) assert.fail(`${file} is a font collection, not a single font`);
        for (const cp of font.characterSet) glyphs.add(cp);
      }
      const missing = MONOLISA_RANGES.flatMap(([first, last]) =>
        Array.from({ length: last - first + 1 }, (_, i) => first + i).filter((cp) => !glyphs.has(cp)),
      );
      assert.deepEqual(
        missing.map(hex),
        [],
        `MONOLISA_RANGES claims ${missing.length} code points that no shipped ${style} file (${files.join(", ")}) can draw`,
      );
    });
  }
});

describe("codePointsOutside", () => {
  it("returns nothing for plain ASCII text", () => {
    assert.deepEqual(codePointsOutside("Hello, world! {x: [1, 2]} ~ `undo`", MONOLISA_RANGES), []);
  });

  it("returns each uncovered code point once, in ascending order", () => {
    // ï é — ’ ‘, each more than once.
    assert.deepEqual(codePointsOutside("naïve café — café’s ‘ï’", MONOLISA_RANGES), [0xe9, 0xef, 0x2014, 0x2018, 0x2019]);
  });

  it("reports the terminal snapshot's symbols, which MonoLisa's web package can't draw", () => {
    // ★ ↑ ↓ › … as used in the tagshelf TUI.
    assert.deepEqual(codePointsOutside(text(0x2605, 0x2191, 0x2193, 0x203a, 0x2026), MONOLISA_RANGES), [
      0x2026, 0x203a, 0x2191, 0x2193, 0x2605,
    ]);
  });

  it("ignores whitespace, including no-break, em and narrow no-break spaces", () => {
    assert.deepEqual(codePointsOutside(`a\tb\nc${text(0xa0)}d${text(0x2003)}e${text(0x202f)}`, MONOLISA_RANGES), []);
  });

  it("treats range ends as inclusive", () => {
    assert.deepEqual(codePointsOutside(text(0x21, 0x7e, 0x2500, 0x257f), MONOLISA_RANGES), []);
    assert.deepEqual(codePointsOutside(text(0x7f, 0x24ff, 0x2580), MONOLISA_RANGES), [0x7f, 0x24ff, 0x2580]);
  });

  it("counts an astral character as one code point, not two surrogates", () => {
    assert.deepEqual(codePointsOutside(`ok ${text(0x1f600)}`, MONOLISA_RANGES), [0x1f600]);
  });

  it("uses the ranges it is given", () => {
    assert.deepEqual(codePointsOutside("abcab", [[0x61, 0x62]]), [0x63]);
    assert.deepEqual(codePointsOutside("abc", []), [0x61, 0x62, 0x63]);
  });
});

describe("subsetOf", () => {
  it("names the vendor files whose unicode-range holds a code point", () => {
    assert.deepEqual(subsetOf(0x2192), {
      normal: "8-MonoLisaCode-normal.woff2",
      italic: "9-MonoLisaCode-italic.woff2",
      range: [0x2190, 0x21ff],
    });
    assert.equal(subsetOf(0x41)?.normal, "0-MonoLisaCode-normal.woff2");
  });

  it("returns undefined for a code point no MonoLisa file's range holds", () => {
    assert.equal(subsetOf(0xe9), undefined); // é: the web package has no Latin-1 subset
    assert.equal(subsetOf(0x2014), undefined); // em dash: no General Punctuation subset either
  });
});

describe("fallbackOverrides", () => {
  const monolisa = { unitsPerEm: 1000, ascent: 1040, descent: -340, lineGap: 0, xWidthAvg: 640 };
  const dejaVuMono = { unitsPerEm: 2048, ascent: 1901, descent: -483, lineGap: 0, xWidthAvg: 1233 };

  it("scales the fallback so its average advance matches the web font's", () => {
    const { sizeAdjust } = fallbackOverrides(monolisa, dejaVuMono);
    assert.ok(Math.abs(sizeAdjust - 640 / 1000 / (1233 / 2048)) < 1e-9);
  });

  it("expresses ascent, descent and line gap relative to the adjusted size", () => {
    const { sizeAdjust, ascentOverride, descentOverride, lineGapOverride } = fallbackOverrides(monolisa, dejaVuMono);
    assert.ok(Math.abs(ascentOverride - 1.04 / sizeAdjust) < 1e-9);
    assert.ok(Math.abs(descentOverride - 0.34 / sizeAdjust) < 1e-9);
    assert.equal(lineGapOverride, 0);
  });

  it("formats the overrides as @font-face descriptors, rounded to 0.01%", () => {
    assert.equal(
      fontFaceDescriptors(fallbackOverrides(monolisa, dejaVuMono)),
      "size-adjust: 106.3%;\nascent-override: 97.83%;\ndescent-override: 31.98%;\nline-gap-override: 0%;",
    );
  });
});

// Ties site.css to the constants above, so the @font-face rules and the
// coverage check Task 3 runs against MONOLISA_RANGES can't drift apart.
describe("site.css @font-face rules", () => {
  it("loads, for each MONOLISA_RANGES entry, the vendor file whose range holds it, with the vendor's unicode-range", () => {
    const subsets = MONOLISA_RANGES.map(([first, last]) => {
      const subset = subsetOf(first);
      assert.ok(subset, `no vendor subset holds ${hex(first)}`);
      assert.ok(last <= subset.range[1], `${hex(first)}-${hex(last)} runs past ${subset.normal}'s range`);
      return subset;
    });
    assert.equal(monolisaFaces.length, subsets.length * 2, "one normal and one italic face per shipped subset, and no others");
    for (const subset of subsets) {
      const unicodeRange = `${hex(subset.range[0])}-${digits(subset.range[1])}`;
      for (const style of ["normal", "italic"] as const) {
        const face = monolisaFaces.find((f) => f.style === style && f.unicodeRange === unicodeRange);
        assert.ok(face, `no ${style} MonoLisa face with unicode-range ${unicodeRange}`);
        assert.ok(face.src.includes(`/fonts/${subset[style]}`), `${style} ${unicodeRange} should load /fonts/${subset[style]}`);
        assert.equal(face.weight, "1 900");
        assert.match(face.body, /font-display\s*:\s*swap/);
      }
    }
  });

  it("declares Calling Code in regular, bold, italic and bold italic", () => {
    const calling = faces.filter((face) => face.family === "Calling Code");
    for (const [weight, style, file] of [
      ["400", "normal", "regular"],
      ["700", "normal", "bold"],
      ["400", "italic", "italic"],
      ["700", "italic", "bolditalic"],
    ] as const) {
      const face = calling.find((f) => f.weight === weight && f.style === style);
      assert.ok(face, `no Calling Code ${weight} ${style}`);
      assert.ok(face.src.includes(`/fonts/callingcode-${file}-webfont.woff2`));
      assert.match(face.body, /font-display\s*:\s*swap/);
    }
    assert.equal(calling.length, 4);
  });

  it("declares regular and bold fallback faces over local fonts only", () => {
    for (const family of ["MonoLisa Fallback", "Calling Code Fallback"]) {
      const fallback = faces.filter((face) => face.family === family);
      assert.deepEqual(fallback.map((f) => f.weight).sort(), ["400", "700"], family);
      for (const face of fallback) {
        assert.doesNotMatch(face.src, /url\(/, `${family} must not download anything`);
        for (const descriptor of ["size-adjust", "ascent-override", "descent-override", "line-gap-override"]) {
          assert.match(face.body, new RegExp(`${descriptor}\\s*:\\s*\\d+(?:\\.\\d+)?%`), `${family} ${face.weight} ${descriptor}`);
        }
      }
    }
  });

  // Also needs DejaVu Sans Mono, the font the descriptors are measured against.
  const dejaVu = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
  const noMetrics = noFonts || (!existsSync(dejaVu) && `${dejaVu} is absent`);
  it("fallback descriptors equal what scripts/font-metrics.ts computes", { skip: noMetrics }, async () => {
    const { fromFile } = await import("@capsizecss/unpack/fs");
    const fallbackMetrics = await fromFile(dejaVu);
    for (const [family, weight, file] of [
      ["MonoLisa Fallback", "400", "0-MonoLisaCode-normal.woff2"],
      ["MonoLisa Fallback", "700", "0-MonoLisaCode-normal.woff2"],
      ["Calling Code Fallback", "400", "callingcode-regular-webfont.woff2"],
      ["Calling Code Fallback", "700", "callingcode-bold-webfont.woff2"],
    ] as const) {
      const metrics = await fromFile(new URL(file, fontsDir).pathname);
      const face = faces.find((f) => f.family === family && f.weight === weight)!;
      for (const line of fontFaceDescriptors(fallbackOverrides(metrics, fallbackMetrics)).split("\n")) {
        assert.ok(face.body.includes(line), `${family} ${weight} should have \`${line}\``);
      }
    }
  });
});
