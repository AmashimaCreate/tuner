import assert from "node:assert/strict";
import test from "node:test";

import { GuitarPitchAnalyzer } from "../pitch-processing.js";
import {
  addNoise,
  centsBetween,
  FIXTURE_E2_HZ,
  FIXTURE_URL,
  pitchShift,
  readMonoPcm16Wav,
  synthesizeEvenHeavyFrame,
} from "./helpers.mjs";

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const MAX_ERROR_CENTS = 50;

// The app runs the analyzer in two modes and each has its own guarantee:
//  - acquisition (no reference): every audible frame strong enough to pass
//    the acquire gate (clarity >= 0.8) must be on pitch, or the tracker could
//    lock onto a subharmonic;
//  - tracking (referenceHz set): every usable frame (clarity >= 0.6) must
//    stay on pitch through the entire decay, because these frames feed the
//    display directly. This is where near-maximum peak picking used to slide
//    onto 1/2 and 1/3 subharmonics (G3 -> 65 Hz, B3 -> 82 Hz, ...).
const ACQUIRE_CLARITY_MIN = 0.8;
const ACQUIRE_RMS_MIN = 0.01;
const TRACK_CLARITY_MIN = 0.6;

const SHIFT_TARGETS = [110, 146.832, 196, 246.942, 329.628];

for (const targetHz of SHIFT_TARGETS) {
  test(`shifted real pluck at ${targetHz}Hz never acquires a subharmonic`, () => {
    const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
    const shifted = pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    assert.deepEqual(collectWrongAcquisitionFrames(shifted, sampleRate, targetHz), []);
  });

  test(`shifted real pluck at ${targetHz}Hz holds the pitch through the decay`, () => {
    const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
    const shifted = pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    assert.deepEqual(collectWrongTrackingFrames(shifted, sampleRate, targetHz), []);
  });
}

test("the E2 decay tail stays on 82 Hz instead of dropping to 41/27 Hz", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  assert.deepEqual(collectWrongAcquisitionFrames(samples, sampleRate, FIXTURE_E2_HZ), []);
  assert.deepEqual(collectWrongTrackingFrames(samples, sampleRate, FIXTURE_E2_HZ), []);
});

test("room-level noise does not re-introduce subharmonic picks", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  for (const targetHz of [FIXTURE_E2_HZ, 196]) {
    const shifted = targetHz === FIXTURE_E2_HZ
      ? samples
      : pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    const noisy = addNoise(shifted, 20);
    assert.deepEqual(
      collectWrongAcquisitionFrames(noisy, sampleRate, targetHz),
      [],
      `SNR 20 dB acquisition at ${targetHz}Hz`,
    );
    assert.deepEqual(
      collectWrongTrackingFrames(noisy, sampleRate, targetHz),
      [],
      `SNR 20 dB tracking at ${targetHz}Hz`,
    );
  }
});

test("unknown analyzer options are rejected instead of silently ignored", () => {
  assert.throws(
    () => new GuitarPitchAnalyzer(FRAME_SIZE, { peakThreshold: 0.9 }),
    /unknown analyzer option: peakThreshold/,
  );
});

// A fundamental outside [minHz, maxHz] also produces key maxima INSIDE the
// range (at multiples of its period), so range filtering after the pick is
// what prevents a 1.5 kHz tone from being displayed as 750 Hz.
test("fundamentals outside the range are rejected, not shown as subharmonics", () => {
  const analyzer = new GuitarPitchAnalyzer(FRAME_SIZE);
  const sampleRate = 48_000;

  for (const outOfRangeHz of [1500, 1250, 40]) {
    const { hz } = analyzer.analyze(
      synthesizeTwoHarmonicTone(outOfRangeHz, FRAME_SIZE, sampleRate),
      sampleRate,
    );
    assert.ok(Number.isNaN(hz), `${outOfRangeHz}Hz must be rejected, got ${hz}`);
  }

  // In range with a dominant second harmonic ABOVE the range: the half-period
  // artifact at 1.4 kHz must fold back down instead of nuking the reading.
  const inRange = analyzer.analyze(
    synthesizeEvenHeavyFrame(700, FRAME_SIZE, sampleRate),
    sampleRate,
  );
  assert.ok(
    Math.abs(centsBetween(inRange.hz, 700)) <= 20,
    `700Hz resolved to ${inRange.hz}Hz`,
  );
});

// Negative controls: regress one tuned parameter at a time and assert the
// historical failure returns on the same real-guitar decay. This pins the
// values of MPM_PICK_RATIO, HALF_LAG_FOLD_MARGIN, REFERENCE_HOLD_RATIO and
// REFERENCE_RADIUS_CENTS against silent partial reverts.
const MUTATION_RMS_MIN = 0.008;

test("near-maximum peak picking re-introduces subharmonic acquisition (negative control)", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const shifted = pitchShift(samples, 196 / FIXTURE_E2_HZ);
  const collect = (analyzerOptions) => collectWrongFrames(shifted, sampleRate, 196, {
    clarityMin: ACQUIRE_CLARITY_MIN,
    rmsMin: MUTATION_RMS_MIN,
    referenceHz: null,
    minUsableFrames: 60,
    analyzerOptions,
  });

  assert.deepEqual(collect({}), [], "tuned parameters must stay clean at this rms floor");
  const regressed = collect({ pickRatio: 0.98 });
  assert.ok(
    regressed.length >= 5 &&
      regressed.some((frame) => Math.abs(frame.errorCents + 1902) <= 60),
    `pickRatio 0.98 must reproduce the G3 -> 65 Hz slide, got ${JSON.stringify(regressed)}`,
  );
});

test("a hair-trigger fold margin folds real decay frames down an octave (negative control)", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const shifted = pitchShift(samples, 196 / FIXTURE_E2_HZ);
  const regressed = collectWrongFrames(shifted, sampleRate, 196, {
    clarityMin: ACQUIRE_CLARITY_MIN,
    rmsMin: MUTATION_RMS_MIN,
    referenceHz: null,
    minUsableFrames: 60,
    analyzerOptions: { foldMargin: 0.005 },
  });
  assert.ok(
    regressed.length >= 5 &&
      regressed.some((frame) => Math.abs(frame.errorCents + 1200) <= 60),
    `foldMargin 0.005 must fold G3 decay frames to 98 Hz, got ${JSON.stringify(regressed)}`,
  );
});

test("the reference hold is load-bearing through a real decay (negative controls)", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const shifted = pitchShift(samples, 196 / FIXTURE_E2_HZ);

  const heldTight = collectWrongTrackingFrames(shifted, sampleRate, 196, {
    referenceHoldRatio: 0.999,
  });
  assert.ok(
    heldTight.length >= 2,
    `an unreachable hold ratio must expose deep-decay subharmonics, got ${JSON.stringify(heldTight)}`,
  );

  const radiusTooSmall = collectWrongTrackingFrames(shifted, sampleRate, 196, {
    referenceRadiusCents: 5,
  });
  assert.ok(
    radiusTooSmall.length >= 1,
    `a 5-cent hold radius must fail to cover normal decay wobble, got ${JSON.stringify(radiusTooSmall)}`,
  );
});

function synthesizeTwoHarmonicTone(frequency, frameSize, sampleRate) {
  const samples = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) {
    const time = index / sampleRate;
    samples[index] = 0.3 * Math.sin(2 * Math.PI * frequency * time) +
      0.15 * Math.sin(2 * Math.PI * 2 * frequency * time + 1);
  }
  return samples;
}

function collectWrongAcquisitionFrames(samples, sampleRate, targetHz, analyzerOptions) {
  return collectWrongFrames(samples, sampleRate, targetHz, {
    clarityMin: ACQUIRE_CLARITY_MIN,
    rmsMin: ACQUIRE_RMS_MIN,
    referenceHz: null,
    minUsableFrames: 60,
    analyzerOptions,
  });
}

// The app only supplies a reference after the tracker has acquired the note
// (acquire gate: clarity >= 0.8 on an audible frame). Mirror that: find the
// acquisition frame first, then hold the reference through everything that
// follows, including the near-silent decay tail.
function collectWrongTrackingFrames(samples, sampleRate, targetHz, analyzerOptions = {}) {
  const analyzer = new GuitarPitchAnalyzer(FRAME_SIZE, analyzerOptions);
  const frame = new Float32Array(FRAME_SIZE);
  const wrongFrames = [];
  let usableFrames = 0;
  let acquired = false;

  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    frame.set(samples.subarray(start, start + FRAME_SIZE));

    if (!acquired) {
      let power = 0;
      for (const value of frame) power += value * value;
      if (Math.sqrt(power / frame.length) < ACQUIRE_RMS_MIN) continue;
      const { hz, clarity } = analyzer.analyze(frame, sampleRate);
      acquired =
        Number.isFinite(hz) &&
        clarity >= ACQUIRE_CLARITY_MIN &&
        Math.abs(centsBetween(hz, targetHz)) <= MAX_ERROR_CENTS;
      if (!acquired) continue;
    }

    const { hz, clarity } = analyzer.analyze(frame, sampleRate, { referenceHz: targetHz });
    if (!Number.isFinite(hz) || !(clarity >= TRACK_CLARITY_MIN)) continue;

    usableFrames += 1;
    const errorCents = centsBetween(hz, targetHz);
    if (Math.abs(errorCents) > MAX_ERROR_CENTS) {
      wrongFrames.push(formatWrongFrame(start, sampleRate, hz, clarity, errorCents));
    }
  }

  assert.ok(acquired, "the pluck never produced an acquirable frame");
  assert.ok(
    usableFrames >= 60,
    `expected at least 60 usable frames, got ${usableFrames}`,
  );
  return wrongFrames;
}

function collectWrongFrames(samples, sampleRate, targetHz, options) {
  const { clarityMin, rmsMin, referenceHz, minUsableFrames, analyzerOptions = {} } = options;
  const analyzer = new GuitarPitchAnalyzer(FRAME_SIZE, analyzerOptions);
  const frame = new Float32Array(FRAME_SIZE);
  const wrongFrames = [];
  let usableFrames = 0;

  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    frame.set(samples.subarray(start, start + FRAME_SIZE));

    if (rmsMin > 0) {
      let power = 0;
      for (const value of frame) power += value * value;
      if (Math.sqrt(power / frame.length) < rmsMin) continue;
    }

    const { hz, clarity } = analyzer.analyze(frame, sampleRate, { referenceHz });
    if (!Number.isFinite(hz) || !(clarity >= clarityMin)) continue;

    usableFrames += 1;
    const errorCents = centsBetween(hz, targetHz);
    if (Math.abs(errorCents) > MAX_ERROR_CENTS) {
      wrongFrames.push(formatWrongFrame(start, sampleRate, hz, clarity, errorCents));
    }
  }

  assert.ok(
    usableFrames >= minUsableFrames,
    `expected at least ${minUsableFrames} usable frames, got ${usableFrames}`,
  );
  return wrongFrames;
}

function formatWrongFrame(start, sampleRate, hz, clarity, errorCents) {
  return {
    timeSeconds: Number((start / sampleRate).toFixed(3)),
    hz: Number(hz.toFixed(2)),
    clarity: Number(clarity.toFixed(3)),
    errorCents: Number(errorCents.toFixed(1)),
  };
}
