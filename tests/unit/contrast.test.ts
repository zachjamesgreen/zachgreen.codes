// The color tokens in site/css/site.css must meet WCAG 2.2 AA:
// 4.5:1 for body text, 3:1 for large text and UI borders. The ratios written
// next to the tokens are checked too, so the comments can't go stale.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { displayable, parse, wcagContrast, type Color } from "culori";

const css = await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8");

/** The text between the `{` at `open` and its matching `}`. */
function blockAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in site.css");
}

/** The body of the first `:root` rule inside `@layer tokens { … }`, comments kept. */
function rootTokensSource(source: string): string {
  const layer = /@layer\s+tokens\s*\{/.exec(source);
  assert.ok(layer, "site.css has no `@layer tokens { … }` block");
  const tokens = blockAt(source, layer.index + layer[0].length - 1);
  const root = /:root\s*\{/.exec(tokens);
  assert.ok(root, "@layer tokens has no :root rule");
  return blockAt(tokens, root.index + root[0].length - 1);
}

const rootSource = rootTokensSource(css);

// Top-level declarations only: nested rules (a media query inside :root) are
// dropped so a token's base value is the one that is read.
const declarations = new Map<string, string>();
{
  let flat = rootSource.replace(/\/\*[\s\S]*?\*\//g, "");
  let nested: RegExpExecArray | null;
  while ((nested = /[^;{}]*\{/.exec(flat)) !== null) {
    const body = blockAt(flat, nested.index + nested[0].length - 1);
    flat = flat.slice(0, nested.index) + flat.slice(nested.index + nested[0].length + body.length + 1);
  }
  for (const [, name, value] of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) declarations.set(name!, value!.trim());
}

function tokenValue(name: string, seen: string[] = []): string {
  const value = declarations.get(name);
  assert.ok(value !== undefined, `:root defines no ${name}`);
  assert.ok(!seen.includes(name), `circular var() reference: ${[...seen, name].join(" -> ")}`);
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  return reference ? tokenValue(reference[1]!, [...seen, name]) : value;
}

function color(name: string): Color {
  const value = tokenValue(name);
  const parsed = parse(value);
  assert.ok(parsed, `${name}: culori cannot parse ${value}`);
  return parsed;
}

function ratio(foreground: string, background: string): number {
  return wcagContrast(color(foreground), color(background));
}

const COLOR_TOKENS = [
  "--bg",
  "--surface",
  "--sunken",
  "--ink",
  "--ink-muted",
  "--line",
  "--accent-yellow",
  "--accent-pink",
  "--accent-blue",
  "--on-accent",
] as const;

const ACCENTS = ["--accent-yellow", "--accent-pink", "--accent-blue"] as const;

describe("site.css color tokens", () => {
  for (const name of COLOR_TOKENS) {
    it(`${name} is written in oklch() and is inside the sRGB gamut`, () => {
      assert.match(tokenValue(name), /^oklch\(/);
      // Out-of-gamut colors get mapped by the browser, so the ratios measured
      // here would not be the ones on screen.
      assert.ok(displayable(color(name)), `${name} = ${tokenValue(name)} is not displayable in sRGB`);
    });
  }
});

describe("WCAG 2.2 AA contrast", () => {
  const pairs: [foreground: string, background: string, minimum: number, why: string][] = [
    ["--ink", "--bg", 4.5, "body text on the page"],
    ["--ink", "--surface", 4.5, "body text in cards"],
    ["--ink-muted", "--bg", 4.5, "secondary text on the page"],
    ["--ink-muted", "--surface", 4.5, "secondary text in cards"],
    ["--ink", "--sunken", 4.5, "terminal text in .tui-frame"],
    ...ACCENTS.map((accent): [string, string, number, string] => [
      "--on-accent",
      accent,
      4.5,
      "button text on an accent fill",
    ]),
    ["--on-accent", "--ink", 4.5, "text on the off-white .btn--alt"],
    ...ACCENTS.map((accent): [string, string, number, string] => [
      accent,
      "--surface",
      3,
      "headings and shadows on cards",
    ]),
    ...ACCENTS.map((accent): [string, string, number, string] => [
      accent,
      "--bg",
      3,
      "section headings and the focus ring on the page",
    ]),
    ["--line", "--bg", 3, "UI borders on the page"],
    ["--line", "--surface", 3, "UI borders around cards"],
  ];

  for (const [foreground, background, minimum, why] of pairs) {
    it(`${foreground} on ${background} >= ${minimum}:1 (${why})`, () => {
      const measured = ratio(foreground, background);
      assert.ok(measured >= minimum, `${foreground} on ${background} is ${measured.toFixed(2)}:1, below ${minimum}:1`);
    });
  }
});

describe("contrast comments next to the tokens", () => {
  // A claim reads `/* 15.95:1 on --bg */` on the same line as the token.
  const claims = [...rootSource.matchAll(/^\s*(--[\w-]+)\s*:[^;]+;[ \t]*\/\*(.*?)\*\//gm)].flatMap(
    ([, token, comment]) =>
      [...comment!.matchAll(/(\d+(?:\.\d+)?):1 on (--[\w-]+)/g)].map(([, stated, background]) => ({
        token: token!,
        background: background!,
        stated: Number(stated),
      })),
  );

  it("there are ratio comments to check", () => {
    assert.ok(claims.length >= COLOR_TOKENS.length, `found only ${claims.length} ratio comments`);
  });

  for (const { token, background, stated } of claims) {
    it(`${token} on ${background} really is ${stated}:1`, () => {
      const measured = ratio(token, background);
      assert.ok(
        Math.abs(measured - stated) < 0.01,
        `the comment says ${stated}:1 but ${token} on ${background} measures ${measured.toFixed(2)}:1`,
      );
    });
  }
});

describe("shared shape, type and spacing tokens", () => {
  it("--border-w is 3px", () => {
    assert.equal(tokenValue("--border-w"), "3px");
  });

  for (const name of ["--shadow-x", "--shadow-y", "--font-display", "--font-body"]) {
    it(`defines ${name}`, () => {
      assert.ok(tokenValue(name).length > 0);
    });
  }

  it("defines --space-1 through --space-8, each larger than the last", () => {
    const sizes = Array.from({ length: 8 }, (_, i) => tokenValue(`--space-${i + 1}`));
    const rem = sizes.map((size) => {
      const match = /^(\d*\.?\d+)rem$/.exec(size);
      assert.ok(match, `spacing tokens are plain rem lengths, got ${size}`);
      return Number(match[1]);
    });
    for (let i = 1; i < rem.length; i++) assert.ok(rem[i]! > rem[i - 1]!, `--space-${i + 1} is not larger than --space-${i}`);
  });
});
