import assert from "node:assert/strict";
import test from "node:test";

import {
  centsBetween,
  createHannWindow,
  matchPitchToTargets,
  robustMeanHz,
  spectralMagnitudes,
  TimedKeyStability,
  TimedPitchStability,
} from "../pitch-processing.js";

const standardTargets = ["E2", "A2", "D3", "G3", "B3", "E4"].map(noteToHz);

test("keeps all six correctly detected open strings on their own targets", () => {
  standardTargets.forEach((hz, targetIndex) => {
    const match = matchPitchToTargets(hz, standardTargets);
    assert.equal(match.targetIndex, targetIndex);
    assert.equal(match.correction, "none");
    assert.ok(Math.abs(match.cents) < 1e-9);
  });
});

test("folds a persistent second-harmonic detection before choosing a string", () => {
  standardTargets.forEach((hz, targetIndex) => {
    const match = matchPitchToTargets(hz * 2, standardTargets);
    assert.equal(match.targetIndex, targetIndex);
    assert.equal(match.correction, "harmonic-2");
    assert.ok(Math.abs(match.cents) < 1e-9);
  });
});

test("manual string selection can recover a third or fourth harmonic", () => {
  for (const multiplier of [3, 4]) {
    const match = matchPitchToTargets(standardTargets[0] * multiplier, standardTargets, {
      onlyIndex: 0,
      maxDistanceCents: 700,
    });
    assert.equal(match.targetIndex, 0);
    assert.equal(match.correction, `harmonic-${multiplier}`);
    assert.ok(Math.abs(match.cents) < 1e-9);
  }
});

test("does not reinterpret a direct B3 as the third harmonic of E2", () => {
  const match = matchPitchToTargets(standardTargets[4], standardTargets, {
    preferredIndex: 0,
  });
  assert.equal(match.targetIndex, 4);
  assert.equal(match.correction, "none");
  assert.equal(match.harmonicAlternative.targetIndex, 0);
  assert.equal(match.harmonicAlternative.correction, "harmonic-3");
});

test("keeps a tracked string harmonic briefly while exposing a direct alternative", () => {
  const match = matchPitchToTargets(standardTargets[4], standardTargets, {
    preferredIndex: 0,
    continuityBonusCents: 15,
    preferPreferredTarget: true,
    preferredTargetMaxCents: 45,
  });
  assert.equal(match.targetIndex, 0);
  assert.equal(match.correction, "harmonic-3");
  assert.equal(match.directAlternative.targetIndex, 4);
  assert.equal(match.directAlternative.correction, "none");
});

test("exposes every plausible lower-string fundamental for an ambiguous E4", () => {
  const match = matchPitchToTargets(standardTargets[5], standardTargets);
  const alternatives = new Set(
    match.harmonicAlternatives.map(
      (candidate) => `${candidate.targetIndex}:${candidate.correction}`,
    ),
  );
  assert.ok(alternatives.has("0:harmonic-4"));
  assert.ok(alternatives.has("1:harmonic-3"));
});

test("keeps detuned harmonic aliases across the full automatic match range", () => {
  const equalTemperamentOffset = centsBetween(
    standardTargets[4] / 3,
    standardTargets[0],
  );
  for (const detuneCents of [-120, -80, -50, 50, 80, 120]) {
    const rawHz = standardTargets[4] * centsRatio(detuneCents);
    const match = matchPitchToTargets(rawHz, standardTargets, {
      maxDistanceCents: 260,
      preferredTargetMaxCents: 45,
    });
    const lowerE = [match, ...match.harmonicAlternatives].find(
      (candidate) =>
        candidate.targetIndex === 0 && candidate.correction === "harmonic-3",
    );
    assert.ok(lowerE, `missing E2 alias at ${detuneCents} cents`);
    assert.ok(
      Math.abs(lowerE.cents - (detuneCents + equalTemperamentOffset)) < 1e-6,
    );
  }
});

test("exposes multiple harmonic fundamentals when no direct string is nearby", () => {
  const match = matchPitchToTargets(440, standardTargets, {
    maxDistanceCents: 260,
  });
  const candidates = [match, ...match.harmonicAlternatives];
  assert.ok(candidates.some(
    (candidate) => candidate.targetIndex === 1 && candidate.correction === "harmonic-4",
  ));
  assert.ok(candidates.some(
    (candidate) => candidate.targetIndex === 2 && candidate.correction === "harmonic-3",
  ));
});

test("uses the tracked string to resolve an otherwise ambiguous octave", () => {
  const ambiguousE3 = standardTargets[0] * 2;
  const match = matchPitchToTargets(ambiguousE3, standardTargets, {
    preferredIndex: 5,
    continuityBonusCents: 15,
  });
  assert.equal(match.targetIndex, 5);
  assert.equal(match.correction, "subharmonic-2");
});

test("a direct lower string beats a tracked subharmonic interpretation", () => {
  const octaveTargets = [standardTargets[0], standardTargets[0] * 2];
  const match = matchPitchToTargets(octaveTargets[0], octaveTargets, {
    preferredIndex: 1,
    continuityBonusCents: 15,
    preferPreferredTarget: true,
    preferredTargetMaxCents: 45,
  });
  assert.equal(match.targetIndex, 0);
  assert.equal(match.correction, "none");
});

test("rejects frequencies too far from every candidate", () => {
  const match = matchPitchToTargets(70, standardTargets, {
    maxDistanceCents: 80,
  });
  assert.equal(match, null);
});

test("log-domain trimmed mean removes one octave outlier without bias", () => {
  const target = standardTargets[0];
  const stable = robustMeanHz([target, target * centsRatio(1), target * centsRatio(-1), target, target * 2]);
  assert.ok(Math.abs(centsBetween(stable, target)) < 0.5);
});

test("spectral support separates a direct upper string from a lower-string harmonic", () => {
  const sampleRate = 48_000;
  const size = 4096;
  const fundamentalHz = standardTargets[0];
  const harmonicHz = fundamentalHz * 3;
  const window = createHannWindow(size);
  const directUpper = synthesize(size, sampleRate, [[harmonicHz, 0.5]]);
  const lowerString = synthesize(size, sampleRate, [
    [fundamentalHz, 0.05],
    [harmonicHz, 0.5],
  ]);

  const [directFundamental, directHarmonic] = spectralMagnitudes(
    directUpper,
    sampleRate,
    [fundamentalHz, harmonicHz],
    window,
  );
  const [lowerFundamental, lowerHarmonic] = spectralMagnitudes(
    lowerString,
    sampleRate,
    [fundamentalHz, harmonicHz],
    window,
  );
  const directRatio = directFundamental / directHarmonic;
  const lowerStringRatio = lowerFundamental / lowerHarmonic;

  assert.ok(directRatio < 0.01, `direct ratio was ${directRatio}`);
  assert.ok(lowerStringRatio > 0.08, `lower-string ratio was ${lowerStringRatio}`);
});

test("pitch acquisition uses elapsed time consistently at 30, 60, and 120Hz", () => {
  for (const frameRate of [30, 60, 120]) {
    const tracker = new TimedPitchStability({
      durationMs: 70,
      widthCents: 30,
      maxGapMs: 100,
    });
    const frameMs = 1000 / frameRate;
    let confirmedAt = null;
    for (let now = 0; now <= 200; now += frameMs) {
      if (tracker.push(110, now)) {
        confirmedAt = now;
        break;
      }
    }
    assert.ok(confirmedAt >= 70);
    assert.ok(confirmedAt < 70 + frameMs + 1e-6);
  }
});

test("pitch acquisition rejects a non-stable span and an interrupted sequence", () => {
  const tracker = new TimedPitchStability({
    durationMs: 70,
    widthCents: 30,
    maxGapMs: 100,
  });
  assert.equal(tracker.push(110, 0), false);
  assert.equal(tracker.push(110 * centsRatio(25), 35), false);
  assert.equal(tracker.push(110 * centsRatio(-25), 70), false);
  tracker.reset();
  assert.equal(tracker.push(110, 0), false);
  assert.equal(tracker.push(110, 120), false);
});

test("string confirmation requires one uninterrupted candidate for the configured time", () => {
  const tracker = new TimedKeyStability({ durationMs: 45, maxGapMs: 100 });
  for (const [key, now] of [[0, 0], [1, 20], [0, 40], [1, 60], [0, 80]]) {
    assert.equal(tracker.push(key, now), false);
  }
  tracker.reset();
  assert.equal(tracker.push(1, 0), false);
  assert.equal(tracker.push(1, 30), false);
  assert.equal(tracker.push(1, 50), true);
});

function centsRatio(cents) {
  return 2 ** (cents / 1200);
}

function synthesize(size, sampleRate, partials) {
  const samples = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const time = index / sampleRate;
    for (const [frequency, amplitude] of partials) {
      samples[index] += amplitude * Math.sin(2 * Math.PI * frequency * time);
    }
  }
  return samples;
}

function noteToHz(note) {
  const names = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
  const match = /^([A-G]#?)(-?\d+)$/.exec(note);
  const midi = names[match[1]] + (Number(match[2]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}
