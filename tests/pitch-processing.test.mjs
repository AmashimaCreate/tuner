import assert from "node:assert/strict";
import test from "node:test";

import {
  centsBetween,
  nearestStringIndex,
  robustMeanHz,
} from "../pitch-processing.js";

const STANDARD_NOTES = ["E2", "A2", "D3", "G3", "B3", "E4"];
const STANDARD_TARGETS = STANDARD_NOTES.map(noteToHz);

test("centsBetween reports octave and whole-tone offsets", () => {
  assert.ok(Math.abs(centsBetween(220, 110) - 1200) < 1e-9);
  assert.ok(Math.abs(centsBetween(noteToHz("D2"), noteToHz("E2")) + 200) < 1e-9);
});

test("all six standard open strings select their own target", () => {
  STANDARD_TARGETS.forEach((hz, index) => {
    assert.equal(nearestStringIndex(hz, STANDARD_TARGETS, 600), index);
  });
});

test("observed D2 regression stays on sixth string at about -200 cents", () => {
  assertObservedDetune({ hz: 73.416, expectedIndex: 0, forbiddenIndex: 2 });
});

test("observed D4 regression stays on first string at about -200 cents", () => {
  assertObservedDetune({ hz: 293.665, expectedIndex: 5, forbiddenIndex: 2 });
});

test("observed G2 regression stays on fifth string at about -200 cents", () => {
  assertObservedDetune({ hz: 97.999, expectedIndex: 1, forbiddenIndex: 3 });
});

test("a pitch farther than the match range is rejected", () => {
  assert.equal(nearestStringIndex(40, STANDARD_TARGETS, 600), -1);
});

test("the maximum match distance is inclusive", () => {
  const target = STANDARD_TARGETS[0];
  assert.equal(nearestStringIndex(target * 2 ** (-600 / 1200), [target], 600), 0);
  assert.equal(nearestStringIndex(target * 2 ** (-600.01 / 1200), [target], 600), -1);
});

test("target count is not hard-coded for four- and seven-string instruments", () => {
  const bassTargets = ["E1", "A1", "D2", "G2"].map(noteToHz);
  bassTargets.forEach((hz, index) => {
    assert.equal(nearestStringIndex(hz, bassTargets, 600), index);
  });

  const sevenStringTargets = ["B1", ...STANDARD_NOTES].map(noteToHz);
  sevenStringTargets.forEach((hz, index) => {
    assert.equal(nearestStringIndex(hz, sevenStringTargets, 600), index);
  });
});

test("duplicate-note tunings deterministically choose the first matching index", () => {
  const ostrichTargets = ["D2", "D3", "D3", "D4", "D4", "D4"].map(noteToHz);
  assert.equal(nearestStringIndex(noteToHz("D3"), ostrichTargets, 600), 1);
  assert.equal(nearestStringIndex(noteToHz("D4"), ostrichTargets, 600), 3);
});

test("invalid source and target values never become candidates", () => {
  for (const hz of [Number.NaN, Infinity, 0, -1]) {
    assert.equal(nearestStringIndex(hz, STANDARD_TARGETS, 600), -1);
  }
  assert.equal(nearestStringIndex(110, null, 600), -1);
  assert.equal(nearestStringIndex(110, [Number.NaN, -1, 110], 600), 2);
});

test("median-neighborhood mean removes one octave outlier without bias", () => {
  const target = STANDARD_TARGETS[0];
  const stable = robustMeanHz([
    target,
    target * 2 ** (1 / 1200),
    target * 2 ** (-1 / 1200),
    target,
    target * 2,
  ]);
  assert.ok(Math.abs(centsBetween(stable, target)) < 0.5);
});

test("observed octave-error mix returns the E2 majority, not a synthetic midpoint", () => {
  const stable = robustMeanHz([82.41, 82.41, 82.41, 164.81, 164.81]);
  assertWithinCents(stable, 82.41, 5);
  assert.ok(Math.abs(centsBetween(stable, 103.35)) > 300);
});

test("a single octave error cannot move the majority cluster", () => {
  const stable = robustMeanHz([82.41, 82.41, 82.41, 82.41, 164.81]);
  assertWithinCents(stable, 82.41, 5);
});

test("octave-error rejection is independent of sample order", () => {
  const stable = robustMeanHz([82.41, 164.81, 82.41, 164.81, 82.41]);
  assertWithinCents(stable, 82.41, 5);
});

test("a seven-sample ring keeps the four-sample E2 majority", () => {
  const stable = robustMeanHz([
    164.81,
    82.41,
    164.81,
    82.41,
    82.41,
    164.81,
    82.41,
  ]);
  assertWithinCents(stable, 82.41, 5);
});

test("an octave-error majority returns an observed octave, never a midpoint", () => {
  const stable = robustMeanHz([82.41, 82.41, 164.81, 164.81, 164.81]);
  assertWithinCents(stable, 164.81, 5);
});

test("downward octave errors cannot move an E4 majority", () => {
  const stable = robustMeanHz([329.63, 164.81, 329.63, 164.81, 329.63]);
  assertWithinCents(stable, 329.63, 5);
});

test("clean samples all contribute to the log-domain mean", () => {
  const samples = [329.5, 329.7, 329.6, 329.8, 329.4];
  const expected = 2 ** (
    samples.reduce((sum, hz) => sum + Math.log2(hz), 0) / samples.length
  );
  const stable = robustMeanHz(samples);
  assert.ok(Math.abs(stable - expected) < 1e-6);
});

test("invalid samples are ignored without changing the majority", () => {
  assert.ok(Number.isNaN(robustMeanHz([Number.NaN, Infinity, 0, -1])));
  const stable = robustMeanHz([
    Number.NaN,
    82.41,
    Infinity,
    164.81,
    82.41,
    -1,
    164.81,
    82.41,
  ]);
  assertWithinCents(stable, 82.41, 5);
});

test("octave-error mix still selects the sixth-string target", () => {
  const stable = robustMeanHz([82.41, 82.41, 82.41, 164.81, 164.81]);
  assert.equal(nearestStringIndex(stable, STANDARD_TARGETS, 600), 0);
});

function assertObservedDetune({ hz, expectedIndex, forbiddenIndex }) {
  const actualIndex = nearestStringIndex(hz, STANDARD_TARGETS, 600);
  const cents = centsBetween(hz, STANDARD_TARGETS[actualIndex]);
  assert.equal(actualIndex, expectedIndex);
  assert.notEqual(actualIndex, forbiddenIndex);
  assert.ok(Math.abs(cents + 200) < 0.05, `expected about -200 cents, got ${cents}`);
}

function assertWithinCents(actualHz, expectedHz, toleranceCents) {
  const errorCents = centsBetween(actualHz, expectedHz);
  assert.ok(
    Math.abs(errorCents) <= toleranceCents,
    `expected ${actualHz}Hz within ${toleranceCents} cents of ${expectedHz}Hz; got ${errorCents}`,
  );
}

function noteToHz(note) {
  const names = {
    C: 0,
    "C#": 1,
    D: 2,
    "D#": 3,
    E: 4,
    F: 5,
    "F#": 6,
    G: 7,
    "G#": 8,
    A: 9,
    "A#": 10,
    B: 11,
  };
  const match = /^([A-G]#?)(-?\d+)$/.exec(note);
  assert.ok(match, `valid note: ${note}`);
  const midi = names[match[1]] + (Number(match[2]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}
