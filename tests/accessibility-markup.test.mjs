import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TUNINGS } from "../tunings.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(
  await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"),
);

test("the viewport allows browser zoom", () => {
  const viewport = html.match(
    /<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i,
  );

  assert.ok(viewport, "viewport metadata must exist");
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport[1], /maximum-scale\s*=\s*1(?:\D|$)/i);
});

test("the installed app follows the device orientation", () => {
  assert.equal(manifest.orientation, "any");
});

test("release labels describe the controls and duplicate tuning variants", () => {
  assert.match(html, />チューニング完了音</);
  assert.doesNotMatch(html, />効果音</);

  assert.equal(
    TUNINGS.find((tuning) => tuning.id === "openA")?.name,
    "オープンA（E-A-C#-E-A-E）",
  );
  assert.equal(
    TUNINGS.find((tuning) => tuning.id === "openA2")?.name,
    "オープンA（E-A-E-A-C#-E）",
  );
});
