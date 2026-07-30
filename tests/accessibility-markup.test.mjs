import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
