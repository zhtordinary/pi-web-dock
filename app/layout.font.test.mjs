import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const subsets = {
  "cyrillic-ext": ["0c24f21ad3bd248e39d428679cddd7969f90eb6cebe20f1670e81a89e8d3f751", "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F"],
  cyrillic: ["f7e1023ce0099ebc4a67d26607f6f2ebaa5de1388635fdf748e8f290354147d6", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  "greek-ext": ["109a84229e44cc35b5e2e9eb0bfbd0633af0c2b6f819e7752a39426446f52a84", "U+1F00-1FFF"],
  greek: ["25f926be2f80fdf964d14e56bb9baa7ddc1ed015f14449d40fd4f12322e5ec68", "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF"],
  vietnamese: ["3075bd69d52719d6f573da7d02a83d881f50801311a13e91dc2931f1fb46d251", "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB"],
  "latin-ext": ["aed68c8758d2a5e224dd849fe4caf0728bc33e29b471662f9a6b36f606d14202", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  latin: ["71f6c22d5dd256eaa9e48347bda6ac2c65f58980dd372ed5780fbdaca1186331", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
};

test("Noto Sans Mono is bundled locally with the existing subsets and preloads", () => {
  assert.doesNotMatch(layout, /next\/font\/google/, "production builds must not fetch fonts from the network");
  assert.match(layout, /import\s+["']\.\/noto-sans-mono\.css["']/);
  const links = [...layout.matchAll(/<link\s+([^>]+)\/>/g)].map((match) => match[1]);
  for (const subset of ["latin", "cyrillic"]) {
    const link = links.find((entry) => entry.includes(`href="/fonts/noto-sans-mono-v37-${subset}.woff2"`));
    assert.ok(link, `${subset} font must be preloaded`);
    assert.match(link, /rel="preload"/);
    assert.match(link, /as="font"/);
    assert.match(link, /crossOrigin="anonymous"/);
  }

  const css = readFileSync(new URL("./noto-sans-mono.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /https?:\/\//i, "font CSS must not reference a remote host");
  assert.match(css, /--font-noto-mono:\s*["']Noto Sans Mono["']/);
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
  const notoFaces = faces.filter((face) => face.includes('font-family: "Noto Sans Mono"'));
  assert.equal(notoFaces.length, Object.keys(subsets).length);
  for (const [subset, [sha256, unicodeRange]] of Object.entries(subsets)) {
    const name = `noto-sans-mono-v37-${subset}.woff2`;
    const face = faces.find((entry) => entry.includes(`/fonts/${name}`));
    assert.ok(face, `${subset} font face is missing`);
    assert.match(face, /font-weight:\s*100\s+900/);
    assert.match(face, /font-display:\s*swap/);
    assert.ok(face.includes(`unicode-range: ${unicodeRange};`), `${subset} coverage must match Google Fonts`);
    const font = readFileSync(new URL(`../public/fonts/${name}`, import.meta.url));
    assert.equal(font.subarray(0, 4).toString("ascii"), "wOF2", `${subset} must be WOFF2`);
    assert.equal(createHash("sha256").update(font).digest("hex"), sha256, `${subset} must match the approved source`);
  }
  const license = readFileSync(new URL("../public/licenses/noto-sans-mono-OFL.txt", import.meta.url), "utf8");
  assert.match(license, /Copyright 2022 The Noto Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE\s+Version 1\.1/);
});

test("Symbols Nerd Font is bundled for terminal private-use glyphs", () => {
  const css = readFileSync(new URL("./noto-sans-mono.css", import.meta.url), "utf8");
  const link = [...layout.matchAll(/<link\s+([^>]+)\/>/g)]
    .map((match) => match[1])
    .find((entry) => entry.includes("/fonts/symbols-nerd-font-mono-v3.5.1.ttf"));
  assert.ok(link, "Symbols Nerd Font must be preloaded");
  assert.match(link, /rel="preload"/);
  assert.match(link, /as="font"/);
  assert.match(link, /type="font\/ttf"/);
  assert.match(link, /crossOrigin="anonymous"/);

  const face = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)]
    .map((match) => match[1])
    .find((entry) => entry.includes("Symbols Nerd Font Mono"));
  assert.ok(face, "Symbols Nerd Font face is missing");
  assert.match(face, /src:\s*url\("\/fonts\/symbols-nerd-font-mono-v3\.5\.1\.ttf"\)\s+format\("truetype"\)/);
  assert.match(face, /unicode-range:[^;]*U\+E000-F8FF/);

  const font = readFileSync(new URL("../public/fonts/symbols-nerd-font-mono-v3.5.1.ttf", import.meta.url));
  assert.equal(font.readUInt32BE(0), 0x00010000, "Symbols Nerd Font must be a TrueType font");
  assert.equal(createHash("sha256").update(font).digest("hex"), "fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749");
  const license = readFileSync(new URL("../public/licenses/nerd-font-symbols-MIT.txt", import.meta.url), "utf8");
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /Copyright \(c\) 2014 Ryan L McIntyre/);
});
