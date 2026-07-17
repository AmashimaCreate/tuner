import assert from "node:assert/strict";
import test from "node:test";

import { PITCHY_MPM_PEAK_THRESHOLD } from "../pitch-processing.js";
import { PitchDetector } from "../pitchy.js";

const SAMPLE_RATE = 48_000;
const FRAME_SIZE = 2048;
const GUITAR_PITCHES = [73.416, 82.4069, 110, 146.832, 196, 246.942, 329.628];
const EVEN_HEAVY_HARMONICS = [0.08, 1, 0.12, 0.72, 0.08, 0.48, 0.05, 0.3];

test("near-maximum MPM peak selection rejects second-harmonic octave errors", () => {
  const legacyDetector = PitchDetector.forFloat32Array(FRAME_SIZE);
  legacyDetector.clarityThreshold = 0.9;
  const tunedDetector = PitchDetector.forFloat32Array(FRAME_SIZE);
  tunedDetector.clarityThreshold = PITCHY_MPM_PEAK_THRESHOLD;

  for (const expectedHz of GUITAR_PITCHES) {
    const frame = synthesizeGuitarFrame(expectedHz);
    const [legacyHz, legacyClarity] = legacyDetector.findPitch(frame, SAMPLE_RATE);
    const [tunedHz, tunedClarity] = tunedDetector.findPitch(frame, SAMPLE_RATE);

    assert.ok(
      Math.abs(centsBetween(legacyHz, expectedHz) - 1200) <= 20,
      "the fixture must reproduce the former octave-up failure",
    );
    assert.ok(legacyClarity >= 0.9, "clarity gating alone cannot reject this failure");
    assert.ok(
      Math.abs(centsBetween(tunedHz, expectedHz)) <= 20,
      `${expectedHz}Hz resolved to ${tunedHz}Hz at clarity ${tunedClarity}`,
    );
  }
});

function synthesizeGuitarFrame(frequency) {
  const samples = new Float32Array(FRAME_SIZE);
  const random = mulberry32(1009 + Math.round(frequency * 10));
  const phases = EVEN_HEAVY_HARMONICS.map(() => random() * 2 * Math.PI);
  const inharmonicity = frequency < 100 ? 0.00008 : 0.00003;

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const envelope = Math.exp(-time * 2.2);
    let sample = (random() - 0.5) * 0.003 * Math.exp(-time * 24);

    for (let harmonic = 1; harmonic <= EVEN_HEAVY_HARMONICS.length; harmonic += 1) {
      const partialHz = frequency * harmonic * Math.sqrt(
        1 + inharmonicity * harmonic ** 2,
      );
      sample += EVEN_HEAVY_HARMONICS[harmonic - 1] * Math.sin(
        2 * Math.PI * partialHz * time + phases[harmonic - 1],
      );
    }

    samples[index] = sample * envelope * 0.08;
  }

  return samples;
}

function centsBetween(hz, referenceHz) {
  return 1200 * Math.log2(hz / referenceHz);
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
