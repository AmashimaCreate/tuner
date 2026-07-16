const HARMONIC_CANDIDATES = Object.freeze([
  { multiplier: 1, correction: "none", label: "×1", penaltyCents: 0 },
  { multiplier: 1 / 2, correction: "harmonic-2", label: "÷2", penaltyCents: 8 },
  { multiplier: 1 / 3, correction: "harmonic-3", label: "÷3", penaltyCents: 16 },
  { multiplier: 1 / 4, correction: "harmonic-4", label: "÷4", penaltyCents: 22 },
  { multiplier: 2, correction: "subharmonic-2", label: "×2", penaltyCents: 18 },
]);

export function centsBetween(hz, targetHz) {
  return 1200 * Math.log2(hz / targetHz);
}

export function matchPitchToTargets(rawHz, targetsHz, options = {}) {
  if (!Number.isFinite(rawHz) || rawHz <= 0 || !Array.isArray(targetsHz)) return null;

  const {
    onlyIndex = null,
    preferredIndex = -1,
    maxDistanceCents = 260,
    directPreferenceCents = 35,
    continuityBonusCents = 10,
    preferPreferredTarget = false,
    preferredTargetMaxCents = 45,
    harmonicAlternativeMaxCents = maxDistanceCents,
  } = options;
  const targetIndexes = Number.isInteger(onlyIndex)
    ? [onlyIndex]
    : targetsHz.map((_, index) => index);
  const matches = [];

  for (const targetIndex of targetIndexes) {
    const targetHz = targetsHz[targetIndex];
    if (!Number.isFinite(targetHz) || targetHz <= 0) continue;

    for (const candidate of HARMONIC_CANDIDATES) {
      const hz = rawHz * candidate.multiplier;
      const cents = centsBetween(hz, targetHz);
      const distanceCents = Math.abs(cents);
      if (distanceCents > maxDistanceCents) continue;

      matches.push({
        rawHz,
        hz,
        targetIndex,
        cents,
        distanceCents,
        correction: candidate.correction,
        correctionLabel: candidate.label,
        multiplier: candidate.multiplier,
        score:
          distanceCents +
          candidate.penaltyCents -
          (targetIndex === preferredIndex ? continuityBonusCents : 0),
      });
    }
  }

  if (matches.length === 0) return null;

  // A real fundamental already close to an open-string target must beat a
  // mathematically plausible subharmonic of another target.
  const allDirectMatches = matches.filter(
    (match) => match.correction === "none",
  );
  const closeDirectMatches = allDirectMatches.filter(
    (match) => match.correction === "none" && match.distanceCents <= directPreferenceCents,
  );
  const preferredMatches = preferPreferredTarget
    ? matches.filter(
      (match) =>
        match.targetIndex === preferredIndex &&
        match.distanceCents <= preferredTargetMaxCents,
    )
    : [];
  const preferredHarmonicMatches = preferredMatches.filter(
    (match) => match.correction.startsWith("harmonic-"),
  );
  const pool =
    preferredHarmonicMatches.length > 0
      ? preferredHarmonicMatches
      : closeDirectMatches.length > 0
        ? closeDirectMatches
        : preferredMatches.length > 0
          ? preferredMatches
          : matches;
  const compareMatches = (left, right) =>
    left.score - right.score ||
    left.distanceCents - right.distanceCents ||
    Math.abs(Math.log2(left.multiplier)) - Math.abs(Math.log2(right.multiplier)) ||
    left.targetIndex - right.targetIndex;

  pool.sort(compareMatches);
  allDirectMatches.sort(compareMatches);
  const match = pool[0];
  const directAlternative = allDirectMatches.find(
    (candidate) => candidate.targetIndex !== match.targetIndex,
  ) ?? null;
  const harmonicAlternatives = matches
    .filter(
      (candidate) =>
        candidate.correction.startsWith("harmonic-") &&
        candidate.targetIndex !== match.targetIndex &&
        candidate.distanceCents <= harmonicAlternativeMaxCents,
    )
    .sort(compareMatches);
  const harmonicAlternative = harmonicAlternatives[0] ?? null;

  return {
    ...match,
    directAlternative,
    harmonicAlternative,
    harmonicAlternatives,
  };
}

export function robustMeanHz(values) {
  const logarithms = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.log2)
    .sort((left, right) => left - right);

  if (logarithms.length === 0) return Number.NaN;
  if (logarithms.length <= 2) return 2 ** medianSorted(logarithms);

  const trimmed = logarithms.slice(1, -1);
  const mean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  return 2 ** mean;
}

export function createHannWindow(size) {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
  }
  return window;
}

export function spectralMagnitude(samples, sampleRate, frequency, window = null) {
  return spectralMagnitudes(samples, sampleRate, [frequency], window)[0];
}

export function spectralMagnitudes(samples, sampleRate, frequencies, window = null) {
  if (
    !samples ||
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Array.isArray(frequencies) ||
    frequencies.length === 0 ||
    frequencies.some((frequency) => !Number.isFinite(frequency) || frequency <= 0) ||
    (window && window.length !== samples.length)
  ) {
    return frequencies?.map?.(() => Number.NaN) ?? [Number.NaN];
  }

  // One Goertzel pass evaluates every ambiguous fundamental while touching
  // the 4096-sample buffer only once. This keeps the mobile hot path bounded.
  const states = frequencies.map((frequency) => ({
    coefficient: 2 * Math.cos((2 * Math.PI * frequency) / sampleRate),
    previous: 0,
    previous2: 0,
  }));

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] * (window ? window[index] : 1);
    for (const state of states) {
      const current = sample + state.coefficient * state.previous - state.previous2;
      state.previous2 = state.previous;
      state.previous = current;
    }
  }

  return states.map((state) => Math.sqrt(Math.max(
    0,
    state.previous * state.previous +
      state.previous2 * state.previous2 -
      state.coefficient * state.previous * state.previous2,
  )));
}

export class TimedKeyStability {
  constructor({ durationMs, maxGapMs }) {
    this.durationMs = durationMs;
    this.maxGapMs = maxGapMs;
    this.reset();
  }

  push(key, now) {
    if (!Number.isFinite(now) || key === null || key === undefined) {
      this.reset();
      return false;
    }

    const interrupted =
      this.key !== key ||
      this.lastAt === null ||
      now < this.lastAt ||
      now - this.lastAt > this.maxGapMs;
    if (interrupted) {
      this.key = key;
      this.startedAt = now;
    }
    this.lastAt = now;
    return now - this.startedAt >= this.durationMs;
  }

  reset() {
    this.key = null;
    this.startedAt = null;
    this.lastAt = null;
  }
}

export class TimedPitchStability {
  constructor({ durationMs, widthCents, maxGapMs }) {
    this.durationMs = durationMs;
    this.widthCents = widthCents;
    this.maxGapMs = maxGapMs;
    this.reset();
  }

  push(hz, now, key = "pitch") {
    if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(now)) {
      this.reset();
      return false;
    }

    const logHz = Math.log2(hz);
    const interrupted =
      this.key !== key ||
      this.lastAt === null ||
      now < this.lastAt ||
      now - this.lastAt > this.maxGapMs;
    const nextMinLogHz = interrupted ? logHz : Math.min(this.minLogHz, logHz);
    const nextMaxLogHz = interrupted ? logHz : Math.max(this.maxLogHz, logHz);
    const widthCents = 1200 * (nextMaxLogHz - nextMinLogHz);

    if (interrupted || widthCents > this.widthCents) {
      this.key = key;
      this.startedAt = now;
      this.minLogHz = logHz;
      this.maxLogHz = logHz;
    } else {
      this.minLogHz = nextMinLogHz;
      this.maxLogHz = nextMaxLogHz;
    }
    this.lastAt = now;
    return now - this.startedAt >= this.durationMs;
  }

  reset() {
    this.key = null;
    this.startedAt = null;
    this.lastAt = null;
    this.minLogHz = Infinity;
    this.maxLogHz = -Infinity;
  }
}

function medianSorted(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
