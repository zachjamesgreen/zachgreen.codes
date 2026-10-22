// Structure rules for site/css/site.css. Shared components belong in the
// `components` layer; the `pages` layer holds only what one page needs. A rule
// copied into each page's styles drifts apart over time, so these keep the shared
// .lead and .split from being redefined per page.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// Comments are dropped first, so braces and class names in them can't confuse the scan.
const css = (await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

/** The text between the `{` after `@layer <name>` and its matching `}`. */
function layerBlock(source: string, name: string): string {
  const layer = new RegExp(`@layer\\s+${name}\\s*\\{`).exec(source);
  assert.ok(layer, `site.css has no \`@layer ${name} { … }\` block`);
  const open = layer.index + layer[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces in @layer ${name}`);
}

/** The selector list of every style rule in a block, nested rules included. At-rule preludes are skipped. */
function selectors(block: string): string[] {
  const found: string[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    const char = block[i];
    if (char === "{") {
      const prelude = block.slice(start, i).trim();
      if (prelude && !prelude.startsWith("@")) found.push(prelude);
      start = i + 1;
    } else if (char === ";" || char === "}") {
      start = i + 1;
    }
  }
  return found;
}

const classesIn = (selectorList: string[]) => selectorList.flatMap((selector) => selector.match(/\.[\w-]+/g) ?? []);

describe("site.css layers", () => {
  const components = classesIn(selectors(layerBlock(css, "components")));
  const pages = classesIn(selectors(layerBlock(css, "pages")));

  it("defines .lead and .split as shared components", () => {
    assert.ok(components.includes(".lead"), ".lead is not in @layer components");
    assert.ok(components.includes(".split"), ".split is not in @layer components");
  });

  it("keeps .lead and .split out of the pages layer", () => {
    assert.deepEqual(
      pages.filter((name) => name === ".lead" || name === ".split"),
      [],
    );
  });

  it("has no page-local *-lead or *-split selector in the pages layer", () => {
    // A page's own intro line or two-column row is the shared .lead or .split,
    // never a page-local copy such as .about-lead.
    assert.deepEqual(
      [...new Set(pages.filter((name) => /[-_](lead|split)$/.test(name)))],
      [],
    );
  });
});
