import assert from "node:assert/strict";
import test from "node:test";

import { PitchRefiner } from "../pitch-processing.js";
import {
  addNoise,
  centsBetween,
  FIXTURE_E2_HZ,
  FIXTURE_URL,
  mulberry32,
  readMonoPcm16Wav,
} from "./helpers.mjs";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 8192;

// A plucked string with realistic inharmonicity: partials run progressively
// sharp of exact multiples, which is what biases naive harmonic averaging.
function synthesizeString(f0, frameSize, sampleRate, { snrDb = Infinity, seed = 7 } = {}) {
  const amplitudes = [1, 0.8, 0.5, 0.35, 0.2, 0.1];
  const inharmonicity = 0.0002;
  const random = mulberry32(seed);
  const phases = amplitudes.map(() => random() * 2 * Math.PI);
  const samples = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) {
    const time = index / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= amplitudes.length; harmonic += 1) {
      const partialHz = f0 * harmonic * Math.sqrt(1 + inharmonicity * harmonic ** 2);
      value += amplitudes[harmonic - 1] * Math.sin(2 * Math.PI * partialHz * time + phases[harmonic - 1]);
    }
    samples[index] = value * 0.1;
  }
  if (Number.isFinite(snrDb)) {
    let power = 0;
    for (const v of samples) power += v * v;
    const noiseRms = Math.sqrt(power / frameSize) / 10 ** (snrDb / 20);
    const scale = noiseRms * Math.sqrt(12);
    const noise = mulberry32(seed + 1);
    for (let index = 0; index < frameSize; index += 1) {
      samples[index] += (noise() - 0.5) * scale;
    }
  }
  return samples;
}

test("refines every open string to within 1.2 cents at SNR 20", () => {
  const refiner = new PitchRefiner(FRAME_SIZE);

  for (const f0 of [82.4069, 110, 146.832, 196, 246.942, 329.628]) {
    const frame = synthesizeString(f0, FRAME_SIZE, SAMPLE_RATE, { snrDb: 20 });
    // The tracker's estimate is deliberately off by +8 cents: the refiner
    // must recover the true pitch, not echo the anchor back.
    const approxHz = f0 * 2 ** (8 / 1200);
    const { hz, partialCount } = refiner.refine(frame, SAMPLE_RATE, approxHz);

    assert.ok(partialCount >= 2, `${f0}Hz: expected >=2 partials, got ${partialCount}`);
    const errorCents = centsBetween(hz, f0);
    assert.ok(
      Math.abs(errorCents) <= 1.2,
      `${f0}Hz refined to ${hz}Hz (${errorCents.toFixed(2)}c off)`,
    );
  }
});

test("survives an anchor that is 25 cents off", () => {
  const refiner = new PitchRefiner(FRAME_SIZE);
  const frame = synthesizeString(FIXTURE_E2_HZ, FRAME_SIZE, SAMPLE_RATE, { snrDb: 20 });
  const { hz } = refiner.refine(frame, SAMPLE_RATE, FIXTURE_E2_HZ * 2 ** (25 / 1200));
  assert.ok(
    Math.abs(centsBetween(hz, FIXTURE_E2_HZ)) <= 1.5,
    `refined to ${hz}Hz`,
  );
});

test("returns NaN on noise instead of inventing a pitch", () => {
  const refiner = new PitchRefiner(FRAME_SIZE);
  const random = mulberry32(99);
  const noise = new Float32Array(FRAME_SIZE);
  for (let index = 0; index < FRAME_SIZE; index += 1) noise[index] = (random() - 0.5) * 0.02;
  const results = [82.4069, 196, 329.628].map(
    (hz) => refiner.refine(noise, SAMPLE_RATE, hz),
  );
  assert.ok(
    results.some(({ hz }) => Number.isNaN(hz)) ||
      results.every(({ partialCount }) => partialCount < 3),
    `noise produced confident pitches: ${JSON.stringify(results)}`,
  );
});

test("holds sub-1.5-cent stability on the real low E, even in heavy noise", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  // Same 171 ms duration as the app's refine window, at the fixture's rate.
  const windowSamples = Math.round(FRAME_SIZE * sampleRate / SAMPLE_RATE);
  const refiner = new PitchRefiner(windowSamples);

  for (const [label, input, maxSd] of [
    ["clean", samples, 1.2],
    ["SNR10", addNoise(samples, 10), 1.5],
  ]) {
    const readings = [];
    for (let ms = 1500; ms < 4500; ms += 50) {
      const end = Math.floor((ms / 1000) * sampleRate);
      const slice = input.subarray(end - windowSamples, end);
      const { hz } = refiner.refine(Float32Array.from(slice), sampleRate, FIXTURE_E2_HZ);
      if (Number.isFinite(hz)) readings.push(centsBetween(hz, FIXTURE_E2_HZ));
    }
    assert.ok(readings.length >= 50, `${label}: only ${readings.length} readings`);
    const mean = readings.reduce((sum, value) => sum + value, 0) / readings.length;
    const sd = Math.sqrt(
      readings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / readings.length,
    );
    assert.ok(sd <= maxSd, `${label}: refined jitter sd=${sd.toFixed(2)}c`);
  }
});

test("unknown refiner options are rejected", () => {
  assert.throws(
    () => new PitchRefiner(FRAME_SIZE, { partials: 4 }),
    /unknown refiner option: partials/,
  );
});
