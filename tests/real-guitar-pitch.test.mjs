import assert from "node:assert/strict";
import test from "node:test";

import { GuitarPitchAnalyzer } from "../pitch-processing.js";
import {
  centsBetween,
  FIXTURE_E2_HZ,
  FIXTURE_URL,
  readMonoPcm16Wav,
} from "./helpers.mjs";

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const RETURNED_CLARITY_MIN = 0.9;
const MIN_PITCH_HZ = 60;
const MAX_STEADY_ERROR_CENTS = 50;

test("the analyzer tracks a real plucked low E without octave or gross errors", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const analyzer = new GuitarPitchAnalyzer(FRAME_SIZE);

  const frame = new Float32Array(FRAME_SIZE);
  const accepted = [];

  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    frame.set(samples.subarray(start, start + FRAME_SIZE));
    const { hz, clarity } = analyzer.analyze(frame, sampleRate);

    if (
      Number.isFinite(hz)
      && hz >= MIN_PITCH_HZ
      && clarity >= RETURNED_CLARITY_MIN
    ) {
      accepted.push({
        timeSeconds: start / sampleRate,
        pitchHz: hz,
        clarity,
        errorCents: centsBetween(hz, FIXTURE_E2_HZ),
      });
    }
  }

  assert.ok(
    accepted.length >= 300,
    `expected at least 300 high-confidence frames, got ${accepted.length}`,
  );

  const grossErrors = accepted.filter(
    ({ errorCents }) => Math.abs(errorCents) > MAX_STEADY_ERROR_CENTS,
  );
  assert.deepEqual(
    grossErrors.map(formatFrame),
    [],
    "accepted high-confidence frames must remain within 50 cents of E2",
  );
});

function formatFrame({ timeSeconds, pitchHz, clarity, errorCents }) {
  return {
    timeSeconds: Number(timeSeconds.toFixed(3)),
    pitchHz: Number(pitchHz.toFixed(2)),
    clarity: Number(clarity.toFixed(3)),
    errorCents: Number(errorCents.toFixed(1)),
  };
}
