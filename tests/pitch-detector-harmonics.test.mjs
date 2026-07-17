import assert from "node:assert/strict";
import test from "node:test";

import { GuitarPitchAnalyzer, MPM_PICK_RATIO } from "../pitch-processing.js";
import { centsBetween, synthesizeEvenHeavyFrame } from "./helpers.mjs";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const GUITAR_PITCHES = [73.416, 82.4069, 110, 146.832, 196, 246.942, 329.628];

test("even-harmonic attacks resolve to the fundamental, not the octave", () => {
  const analyzer = new GuitarPitchAnalyzer(FRAME_SIZE);

  for (const expectedHz of GUITAR_PITCHES) {
    const frame = synthesizeEvenHeavyFrame(expectedHz, FRAME_SIZE, SAMPLE_RATE);
    const { hz, clarity, folded, candidates } = analyzer.analyze(frame, SAMPLE_RATE);

    // The fixture must still pose the actual trap: a half-period key maximum
    // strong enough that the plain smallest-lag rule would pick the octave.
    const strongest = Math.max(...candidates.map((candidate) => candidate.value));
    const octaveTrap = candidates.find(
      (candidate) =>
        Math.abs(centsBetween(candidate.hz, expectedHz * 2)) <= 30 &&
        candidate.value >= MPM_PICK_RATIO * strongest,
    );
    assert.ok(
      octaveTrap,
      `${expectedHz}Hz fixture no longer reproduces the octave-up trap`,
    );

    assert.ok(
      Math.abs(centsBetween(hz, expectedHz)) <= 20,
      `${expectedHz}Hz resolved to ${hz}Hz at clarity ${clarity}`,
    );
    assert.equal(
      folded,
      true,
      `${expectedHz}Hz must be resolved by folding the half-period pick down`,
    );
    assert.ok(clarity >= 0.9, `fundamental peak must stay strong, got ${clarity}`);
  }
});
