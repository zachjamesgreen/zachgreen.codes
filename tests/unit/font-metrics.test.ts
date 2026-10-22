import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  MONOLISA_RANGES,
  MONOLISA_SUBSETS,
  codePointsOutside,
  fallbackOverrides,
  fontFaceDescriptors,
  subsetOf,
} from "../../scripts/font-metrics.ts";

describe("MONOLISA_RANGES", () => {
  it("is the shipped subsets: Basic Latin, box drawing and miscellaneous symbols, in order", () => {
    assert.deepEqual(MONOLISA_RANGES, [
      [0x0020, 0x007f],
      [0x2500, 0x257f],
      [0x2600, 0x26ff],
    ]);
  });

  it("matches the vendor's unicode-range for every shipped subset", () => {
    for (const range of MONOLISA_RANGES) {
      const subset = MONOLISA_SUBSETS.find(({ range: [first] }) => first === range[0]);
      assert.ok(subset, `no vendor subset starts at U+${range[0].toString(16)}`);
      assert.deepEqual(subset.range, range);
    }
  });
});

describe("codePointsOutside", () => {
  it("returns nothing for plain ASCII text", () => {
    assert.deepEqual(codePointsOutside("Hello, world! {x: [1, 2]} ~ `undo`", MONOLISA_RANGES), []);
  });

  it("returns each uncovered code point once, in ascending order", () => {
    // ï é — ’ ‘, each more than once.
    assert.deepEqual(codePointsOutside("naïve café — café’s ‘ï’", MONOLISA_RANGES), [0xe9, 0xef, 0x2014, 0x2018, 0x2019]);
  });

  it("ignores whitespace, including no-break and em spaces", () => {
    assert.deepEqual(codePointsOutside("a\tb\nc d e ", MONOLISA_RANGES), []);
  });

  it("treats range ends as inclusive", () => {
    assert.deepEqual(codePointsOutside("─╿☀⛿", MONOLISA_RANGES), []);
    assert.deepEqual(codePointsOutside("⓿▀", MONOLISA_RANGES), [0x24ff, 0x2580]);
  });

  it("counts an astral character as one code point, not two surrogates", () => {
    assert.deepEqual(codePointsOutside("ok 😀", MONOLISA_RANGES), [0x1f600]);
  });

  it("uses the ranges it is given", () => {
    assert.deepEqual(codePointsOutside("abcab", [[0x61, 0x62]]), [0x63]);
    assert.deepEqual(codePointsOutside("abc", []), [0x61, 0x62, 0x63]);
  });
});

describe("subsetOf", () => {
  it("names the vendor files for a code point MonoLisa covers", () => {
    assert.deepEqual(subsetOf(0x2192), {
      normal: "8-MonoLisaCode-normal.woff2",
      italic: "9-MonoLisaCode-italic.woff2",
      range: [0x2190, 0x21ff],
    });
    assert.equal(subsetOf(0x41)?.normal, "0-MonoLisaCode-normal.woff2");
  });

  it("returns undefined for a code point no MonoLisa file covers", () => {
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
describe("site.css @font-face rules", async () => {
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

  const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");

  it("declares one MonoLisa face per shipped range and style, with the vendor file and range", () => {
    const monolisa = faces.filter((face) => face.family === "MonoLisa");
    const expected = MONOLISA_RANGES.flatMap((range) => {
      const subset = subsetOf(range[0])!;
      return (["normal", "italic"] as const).map((style) => ({
        style,
        unicodeRange: `U+${hex(range[0])}-${hex(range[1])}`,
        file: subset[style],
      }));
    });
    assert.equal(monolisa.length, expected.length);
    for (const { style, unicodeRange, file } of expected) {
      const face = monolisa.find((f) => f.style === style && f.unicodeRange === unicodeRange);
      assert.ok(face, `no ${style} MonoLisa face for ${unicodeRange}`);
      assert.ok(face.src.includes(`/fonts/${file}`), `${style} ${unicodeRange} should load /fonts/${file}`);
      assert.equal(face.weight, "1 900");
      assert.match(face.body, /font-display\s*:\s*swap/);
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

  // Needs the commercial fonts and DejaVu Sans Mono, so it only runs on a
  // machine that has them; CI skips it.
  const fontsDir = new URL("../../site/fonts/", import.meta.url);
  const dejaVu = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
  const haveFonts = existsSync(new URL("0-MonoLisaCode-normal.woff2", fontsDir)) && existsSync(dejaVu);
  it("fallback descriptors equal what scripts/font-metrics.ts computes", { skip: !haveFonts && "fonts not present" }, async () => {
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
