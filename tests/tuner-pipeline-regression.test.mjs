import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GuitarPitchAnalyzer, PitchTracker, PITCH_TRACKER_STATES } from "../pitch-processing.js";
import {
  addMainsHum,
  addNoise,
  biquadFilter,
  centsBetween,
  FIXTURE_E2_HZ,
  FIXTURE_URL,
  pitchShift,
  readMonoPcm16Wav,
  signalRms,
} from "./helpers.mjs";

// Mirror of the runtime configuration in app.js. A drift between the two
// weakens this regression net, so keep them in sync when tuning the app.
const APP_CONFIG = {
  clarityAcquireMin: 0.8,
  clarityTrackMin: 0.5,
  rmsAcquireMin: 0.0002,
  rmsTrackMin: 0.0001,
  acquireMinMs: 30,
  acquireMinSamples: 2,
  acquireStabilityCents: 45,
  candidateMaxGapMs: 90,
  trackMedianWindow: 3,
  trackMaxStepCents: 70,
  switchMinMs: 30,
  switchMinSamples: 2,
  switchStabilityCents: 55,
  switchCandidateMaxGapMs: 90,
  octaveSwitchMinSamples: 3,
  octaveSwitchMinMs: 220,
  octaveToleranceCents: 120,
  releaseMs: 220,
  minPitchHz: 62,
  maxPitchHz: 1200,
  highpassHz: 35,
  humNotchHz: [50, 60, 100, 120, 150, 180],
  humNotchQ: 35,
  fftSize: 2048,
  refineFftSize: 16384,
  refineMaxOffsetCents: 60,
};

// The analysis chain the app builds in front of the analyser node.
function applyAppInputChain(samples, sampleRate) {
  let filtered = biquadFilter(samples, sampleRate, "highpass", APP_CONFIG.highpassHz);
  for (const notchHz of APP_CONFIG.humNotchHz) {
    filtered = biquadFilter(filtered, sampleRate, "notch", notchHz, APP_CONFIG.humNotchQ);
  }
  return filtered;
}

const STANDARD_STRINGS = [
  ["E2", FIXTURE_E2_HZ],
  ["A2", 110],
  ["D3", 146.832],
  ["G3", 196],
  ["B3", 246.942],
  ["E4", 329.628],
];

const ONSET_RMS = 0.01;
const MAX_ACQUIRE_MS = 150;
const WRONG_DISPLAY_CENTS = 100;

// app.js cannot be imported under node (it touches window/document at module
// scope), so APP_CONFIG above is a mirror. This guard turns silent drift into
// a test failure: the CONFIG literal is plain numbers and comments, so it can
// be evaluated directly out of the source text.
test("APP_CONFIG mirrors app.js CONFIG", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const literal = source.match(/const CONFIG = \{[\s\S]*?\n\};/)?.[0];
  assert.ok(literal, "app.js must contain a CONFIG object literal");
  const appConfig = new Function(literal.replace("const CONFIG =", "return"))();
  for (const key of Object.keys(APP_CONFIG)) {
    assert.deepEqual(
      appConfig[key],
      APP_CONFIG[key],
      `app.js CONFIG.${key} drifted from the APP_CONFIG mirror in this test`,
    );
  }
});

test("every standard string acquires fast and never displays a wrong octave", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);

  for (const [name, targetHz] of STANDARD_STRINGS) {
    const shifted = targetHz === FIXTURE_E2_HZ
      ? samples
      : pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    const report = simulateTunerRun(shifted, sampleRate, targetHz, 60);

    assert.ok(
      report.acquireMs !== null && report.acquireMs <= MAX_ACQUIRE_MS,
      `${name}: expected acquisition within ${MAX_ACQUIRE_MS} ms, got ${report.acquireMs}`,
    );
    assert.deepEqual(report.wrongDisplays, [], `${name}: wrong pitch displayed`);
    assert.ok(
      report.trackedRatio >= 0.9,
      `${name}: tracked only ${(report.trackedRatio * 100).toFixed(0)}% after onset`,
    );
  }
});

test("room-level noise keeps the tuner responsive on low and high strings", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);

  for (const [name, targetHz] of [STANDARD_STRINGS[0], STANDARD_STRINGS[3], STANDARD_STRINGS[5]]) {
    const shifted = targetHz === FIXTURE_E2_HZ
      ? samples
      : pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    const noisy = addNoise(shifted, 20);
    const report = simulateTunerRun(noisy, sampleRate, targetHz, 60);

    assert.ok(
      report.acquireMs !== null && report.acquireMs <= MAX_ACQUIRE_MS,
      `${name}@SNR20: expected acquisition within ${MAX_ACQUIRE_MS} ms, got ${report.acquireMs}`,
    );
    assert.deepEqual(report.wrongDisplays, [], `${name}@SNR20: wrong pitch displayed`);
    assert.ok(
      report.trackedRatio >= 0.7,
      `${name}@SNR20: tracked only ${(report.trackedRatio * 100).toFixed(0)}% after onset`,
    );
  }
});

// Every periodic tone produces NSDF maxima at multiples of its period, so a
// newly played higher note contains the old pitch inside its own subharmonic
// ladder (E4's 4x period IS 82.4 Hz). Continuity holding must not ghost the
// finished note when the player moves to another string — at any frame rate.
test("moving from the low E to another string never ghosts the old pitch", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);

  for (const [name, nextHz, maxSwitchMs, fpsList] of [
    ["E2 -> E4", 329.628, 500, [30, 60, 120]],
    ["E2 -> A2", 110, 500, [60]],
  ]) {
    const first = samples.subarray(0, Math.floor(sampleRate * 3));
    const second = pitchShift(samples, nextHz / FIXTURE_E2_HZ);
    const combined = new Float32Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    const secondOnsetMs = (first.length / sampleRate) * 1000;

    for (const fps of fpsList) {
      const displays = simulateTunerRun(combined, sampleRate, nextHz, fps).displayLog;
      const afterSecondOnset = displays.filter(
        (entry) => entry.timeMs >= secondOnsetMs + maxSwitchMs,
      );
      assert.ok(
        afterSecondOnset.length > 0,
        `${name}@${fps}fps: no display after the second pluck`,
      );
      const ghosts = afterSecondOnset.filter(
        (entry) => Math.abs(centsBetween(entry.hz, nextHz)) > WRONG_DISPLAY_CENTS,
      );
      assert.deepEqual(ghosts, [], `${name}@${fps}fps: stale pitch remained on display`);
    }
  }
});

// The audited worst case: a phone microphone in a loud room. Acquisition may
// be slower and coverage thinner, but the tuner must degrade by showing less,
// never by showing a wrong pitch.
test("heavy noise (SNR 15 dB) degrades gracefully without wrong displays", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);

  for (const [name, targetHz] of [STANDARD_STRINGS[0], STANDARD_STRINGS[3]]) {
    const shifted = targetHz === FIXTURE_E2_HZ
      ? samples
      : pitchShift(samples, targetHz / FIXTURE_E2_HZ);
    const noisy = addNoise(shifted, 15);
    const report = simulateTunerRun(noisy, sampleRate, targetHz, 60);

    assert.ok(
      report.acquireMs !== null && report.acquireMs <= 2_000,
      `${name}@SNR15: expected acquisition within 2000 ms, got ${report.acquireMs}`,
    );
    assert.deepEqual(report.wrongDisplays, [], `${name}@SNR15: wrong pitch displayed`);
    assert.ok(
      report.trackedRatio >= 0.4,
      `${name}@SNR15: tracked only ${(report.trackedRatio * 100).toFixed(0)}% after onset`,
    );
  }
});

test("behaviour does not depend on the animation frame rate", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);

  for (const fps of [30, 60, 120]) {
    const report = simulateTunerRun(samples, sampleRate, FIXTURE_E2_HZ, fps);
    assert.ok(
      report.acquireMs !== null && report.acquireMs <= MAX_ACQUIRE_MS,
      `${fps}fps: expected acquisition within ${MAX_ACQUIRE_MS} ms, got ${report.acquireMs}`,
    );
    assert.deepEqual(report.wrongDisplays, [], `${fps}fps: wrong pitch displayed`);
    assert.ok(
      report.trackedRatio >= 0.9,
      `${fps}fps: tracked only ${(report.trackedRatio * 100).toFixed(0)}%`,
    );
  }
});

// Mains hum (50 Hz in east Japan, 60 Hz in west) and its partials sit inside
// the low-string analysis band and out-correlate a decaying string: this is
// the audited "6th string barely responds" failure. The notch chain must keep
// the low E usable, and the hum itself must never be displayed as a note.
test("mains hum keeps the low E responsive and never displays the hum", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const humRms = signalRms(samples) / 4;

  for (const mainsHz of [50, 60]) {
    const noisy = addMainsHum(samples, sampleRate, mainsHz, humRms);
    const report = simulateTunerRun(noisy, sampleRate, FIXTURE_E2_HZ, 60);

    assert.deepEqual(report.wrongDisplays, [], `hum${mainsHz}: wrong pitch displayed`);
    assert.ok(
      report.trackedRatio >= 0.75,
      `hum${mainsHz}: tracked only ${(report.trackedRatio * 100).toFixed(0)}%`,
    );
    // The onset marker fires on the hum itself ~1.1 s before the pluck, so
    // this bound is loose; it still catches "never acquires" regressions.
    assert.ok(
      report.acquireMs !== null && report.acquireMs <= 1_400,
      `hum${mainsHz}: expected acquisition, got ${report.acquireMs}`,
    );

    // Negative control: the notch chain is load-bearing for this guarantee.
    const unprotected = simulateTunerRun(noisy, sampleRate, FIXTURE_E2_HZ, 60, {
      applyInputChain: false,
    });
    assert.ok(
      unprotected.trackedRatio <= report.trackedRatio - 0.25,
      `hum${mainsHz}: expected the unfiltered pipeline to degrade, got ` +
        `${(unprotected.trackedRatio * 100).toFixed(0)}% vs ${(report.trackedRatio * 100).toFixed(0)}%`,
    );
  }
});

// Emulates the runtime loop: the app's input filter chain, then an
// AnalyserNode-style sliding window over the last fftSize samples, analysed
// once per animation frame and fed through the same gating as app.js
// processTrackerFrame(). Pass applyInputChain: false only to demonstrate what
// the filters are protecting against.
function simulateTunerRun(samples, sampleRate, targetHz, fps, { applyInputChain = true } = {}) {
  if (applyInputChain) samples = applyAppInputChain(samples, sampleRate);
  const analyzer = new GuitarPitchAnalyzer(APP_CONFIG.fftSize, {
    minHz: APP_CONFIG.minPitchHz,
    maxHz: APP_CONFIG.maxPitchHz,
  });
  const tracker = new PitchTracker({
    acquireClarityMin: APP_CONFIG.clarityAcquireMin,
    trackClarityMin: APP_CONFIG.clarityTrackMin,
    acquireMinMs: APP_CONFIG.acquireMinMs,
    acquireMinSamples: APP_CONFIG.acquireMinSamples,
    acquireStabilityCents: APP_CONFIG.acquireStabilityCents,
    candidateMaxGapMs: APP_CONFIG.candidateMaxGapMs,
    medianWindow: APP_CONFIG.trackMedianWindow,
    maxStepCents: APP_CONFIG.trackMaxStepCents,
    switchMinMs: APP_CONFIG.switchMinMs,
    switchMinSamples: APP_CONFIG.switchMinSamples,
    switchStabilityCents: APP_CONFIG.switchStabilityCents,
    switchCandidateMaxGapMs: APP_CONFIG.switchCandidateMaxGapMs,
    octaveSwitchMinSamples: APP_CONFIG.octaveSwitchMinSamples,
    octaveSwitchMs: APP_CONFIG.octaveSwitchMinMs,
    octaveToleranceCents: APP_CONFIG.octaveToleranceCents,
    releaseMs: APP_CONFIG.releaseMs,
  });

  const frame = new Float32Array(APP_CONFIG.fftSize);
  const tickMs = 1000 / fps;
  const durationMs = (samples.length / sampleRate) * 1000;

  let onsetMs = null;
  let acquireMs = null;
  let ticksAfterOnset = 0;
  let trackedTicks = 0;
  const wrongDisplays = [];
  const displayLog = [];

  for (let nowMs = 0; nowMs < durationMs; nowMs += tickMs) {
    const end = Math.floor((nowMs / 1000) * sampleRate);
    if (end < APP_CONFIG.fftSize) continue;
    frame.set(samples.subarray(end - APP_CONFIG.fftSize, end));

    let rms = 0;
    for (const value of frame) rms += value * value;
    rms = Math.sqrt(rms / frame.length);

    if (onsetMs === null && rms > ONSET_RMS) onsetMs = nowMs;
    if (onsetMs !== null) ticksAfterOnset += 1;

    const trackingExistingPitch =
      tracker.state === PITCH_TRACKER_STATES.TRACKING ||
      tracker.state === PITCH_TRACKER_STATES.RELEASE;
    const referenceHz = trackingExistingPitch ? tracker.valueHz : null;
    const { hz, clarity } = analyzer.analyze(frame, sampleRate, { referenceHz });
    const rmsMin = trackingExistingPitch ? APP_CONFIG.rmsTrackMin : APP_CONFIG.rmsAcquireMin;
    const rawInRange =
      Number.isFinite(hz) && hz >= APP_CONFIG.minPitchHz && hz <= APP_CONFIG.maxPitchHz;
    const signalUsable = rawInRange && rms >= rmsMin;

    const result = tracker.update({
      hz: signalUsable ? hz : Number.NaN,
      clarity: signalUsable ? clarity : Number.NaN,
      nowMs,
    });

    if (result.event === "acquired" && acquireMs === null && onsetMs !== null) {
      acquireMs = Math.round(nowMs - onsetMs);
    }
    if (result.accepted && Number.isFinite(result.valueHz)) {
      trackedTicks += 1;
      displayLog.push({
        timeMs: Math.round(nowMs),
        hz: Number(result.valueHz.toFixed(2)),
      });
      const errorCents = centsBetween(result.valueHz, targetHz);
      if (Math.abs(errorCents) > WRONG_DISPLAY_CENTS) {
        wrongDisplays.push({
          timeMs: Math.round(nowMs),
          hz: Number(result.valueHz.toFixed(2)),
          errorCents: Number(errorCents.toFixed(1)),
        });
      }
    }
  }

  return {
    acquireMs,
    trackedRatio: ticksAfterOnset > 0 ? trackedTicks / ticksAfterOnset : 0,
    wrongDisplays,
    displayLog,
  };
}
