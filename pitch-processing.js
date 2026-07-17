import { Autocorrelator } from "./pitchy.js";

export function centsBetween(hz, targetHz) {
  return 1200 * Math.log2(hz / targetHz);
}

// MPM peak picking: accept the smallest-lag NSDF key maximum whose value is
// at least this fraction of the strongest in-range maximum. Measured on the
// real-guitar fixture, the true-period peak never drops below 0.956 of the
// strongest subharmonic peak, even late in the decay, so 0.9 keeps it
// eligible where a near-maximum ratio (0.98) starts picking 1/2 and 1/3
// subharmonics instead.
export const MPM_PICK_RATIO = 0.9;

// A second-harmonic-heavy attack produces a half-period key maximum, which
// the smallest-lag rule would pick as an octave-up error. That artifact
// measures at least 0.031 below the true-period maximum on synthetic
// even-harmonic frames, while during real decay the double-lag subharmonic
// exceeds the true peak by at most 0.015. A pick is therefore folded down an
// octave only when the double-lag candidate is stronger by more than this
// margin, which separates the two cases with headroom on both sides.
export const HALF_LAG_FOLD_MARGIN = 0.022;

// Lag window (relative) used to match a candidate near double the picked lag.
const HALF_LAG_TOLERANCE = 0.08;

// Folding can only cascade down while a doubled lag stays in range; guard
// the loop anyway so a degenerate maxima list cannot spin.
const MAX_FOLD_STEPS = 3;

// While the app is already tracking a note, a candidate close to that note is
// preferred over the global pick. Deep in the decay the true-period peak can
// fall below MPM_PICK_RATIO of the strongest subharmonic, and only this
// continuity keeps the reading honest until the note actually dies.
export const REFERENCE_RADIUS_CENTS = 150;

// The held candidate must remain a substantial peak relative to the strongest
// in-range maximum. When the player plucks a different string, the old peak
// collapses against the new one and holding stops within a frame or two.
export const REFERENCE_HOLD_RATIO = 0.75;

/**
 * MPM-style pitch detector for guitar with explicit octave disambiguation.
 *
 * Unlike a single relative-threshold pick, this keeps every NSDF key maximum
 * as a candidate, picks the smallest lag within MPM_PICK_RATIO of the
 * strongest in-range maximum, and then folds the pick down an octave when the
 * candidate near double the lag is stronger by more than HALF_LAG_FOLD_MARGIN.
 * That combination tracks a decaying real string (where subharmonic maxima
 * slightly exceed the true peak) without re-introducing octave-up errors on
 * second-harmonic-heavy attacks.
 */
const ANALYZER_OPTION_KEYS = Object.freeze([
  "minHz",
  "maxHz",
  "pickRatio",
  "foldMargin",
  "referenceRadiusCents",
  "referenceHoldRatio",
]);

export class GuitarPitchAnalyzer {
  constructor(inputLength, options = {}) {
    for (const key of Object.keys(options)) {
      if (!ANALYZER_OPTION_KEYS.includes(key)) {
        throw new TypeError(`unknown analyzer option: ${key}`);
      }
    }
    const {
      minHz = 60,
      maxHz = 1200,
      pickRatio = MPM_PICK_RATIO,
      foldMargin = HALF_LAG_FOLD_MARGIN,
      referenceRadiusCents = REFERENCE_RADIUS_CENTS,
      referenceHoldRatio = REFERENCE_HOLD_RATIO,
    } = options;

    if (!Number.isInteger(inputLength) || inputLength < 4) {
      throw new TypeError("inputLength must be an integer of at least 4");
    }
    if (!Number.isFinite(minHz) || !Number.isFinite(maxHz) || minHz <= 0 || maxHz <= minHz) {
      throw new TypeError("minHz and maxHz must satisfy 0 < minHz < maxHz");
    }
    if (!Number.isFinite(pickRatio) || pickRatio <= 0 || pickRatio > 1) {
      throw new TypeError("pickRatio must be in (0, 1]");
    }
    if (!Number.isFinite(foldMargin) || foldMargin < 0) {
      throw new TypeError("foldMargin must be a non-negative finite number");
    }
    if (!Number.isFinite(referenceRadiusCents) || referenceRadiusCents < 0) {
      throw new TypeError("referenceRadiusCents must be a non-negative finite number");
    }
    if (!Number.isFinite(referenceHoldRatio) || referenceHoldRatio <= 0 || referenceHoldRatio > 1) {
      throw new TypeError("referenceHoldRatio must be in (0, 1]");
    }

    this._autocorrelator = Autocorrelator.forFloat32Array(inputLength);
    this._nsdf = new Float32Array(inputLength);
    this._minHz = minHz;
    this._maxHz = maxHz;
    this._pickRatio = pickRatio;
    this._foldMargin = foldMargin;
    this._referenceRadiusCents = referenceRadiusCents;
    this._referenceHoldRatio = referenceHoldRatio;
  }

  /**
   * Returns { hz, clarity, folded, held, candidates }. hz/clarity are NaN
   * when no candidate falls inside [minHz, maxHz]. candidates lists every
   * NSDF key maximum as { hz, lag, value } in ascending lag order for
   * diagnostics. Pass the currently tracked pitch as options.referenceHz to
   * prefer continuity over the global pick (held: true in the result).
   */
  analyze(frame, sampleRate, { referenceHz = null } = {}) {
    this._computeNsdf(frame);
    const candidates = collectKeyMaxima(this._nsdf).map(({ lag, value }) => ({
      hz: sampleRate / lag,
      lag,
      value,
    }));
    if (candidates.length === 0) {
      return { hz: Number.NaN, clarity: Number.NaN, folded: false, held: false, candidates };
    }

    // Pick and fold over ALL maxima, then range-check the result. Filtering
    // to [minHz, maxHz] first would report a fundamental outside the range as
    // its own strongest in-range subharmonic (a 1.5 kHz tone as 750 Hz), and
    // a fundamental below the range as its half-period artifact.
    let strongest = 0;
    for (const candidate of candidates) {
      if (candidate.value > strongest) strongest = candidate.value;
    }

    // Candidates are in ascending lag order, so find() takes the smallest lag
    // (highest frequency) that clears the relative threshold.
    let pick = candidates.find(
      (candidate) => candidate.value >= this._pickRatio * strongest,
    );

    let folded = false;
    for (let step = 0; step < MAX_FOLD_STEPS; step += 1) {
      const doubled = strongestNearLag(candidates, pick.lag * 2, HALF_LAG_TOLERANCE);
      if (!doubled || doubled.value <= pick.value + this._foldMargin) break;
      pick = doubled;
      folded = true;
    }

    // Continuity: while tracking, prefer the in-range candidate nearest to
    // the tracked pitch. Late in the decay it may fall below pickRatio of a
    // subharmonic maximum and still be the honest reading. Holding is only
    // allowed when the pick slid DOWN the subharmonic ladder (held frequency
    // above the pick): every periodic tone also produces maxima at multiples
    // of its period, so when a newly played higher note contains the old
    // pitch in its own ladder (E2 tracked, E4 played), the pick lands ABOVE
    // the held candidate and holding would ghost the dead note forever.
    if (Number.isFinite(referenceHz) && referenceHz > 0) {
      const inRange = candidates.filter(
        (candidate) => candidate.hz >= this._minHz && candidate.hz <= this._maxHz,
      );
      const nearest = nearestByCents(inRange, referenceHz);
      if (
        nearest !== null &&
        nearest.lag <= pick.lag &&
        Math.abs(centsBetween(nearest.hz, referenceHz)) <= this._referenceRadiusCents &&
        nearest.value >= this._referenceHoldRatio * strongest
      ) {
        return {
          hz: nearest.hz,
          clarity: Math.min(nearest.value, 1),
          folded: nearest === pick ? folded : false,
          held: nearest !== pick,
          candidates,
        };
      }
    }

    if (pick.hz < this._minHz || pick.hz > this._maxHz) {
      return { hz: Number.NaN, clarity: Number.NaN, folded: false, held: false, candidates };
    }

    return {
      hz: pick.hz,
      clarity: Math.min(pick.value, 1),
      folded,
      held: false,
      candidates,
    };
  }

  _computeNsdf(frame) {
    this._autocorrelator.autocorrelate(frame, this._nsdf);
    let denominator = 2 * this._nsdf[0];
    let index = 0;
    for (; index < this._nsdf.length && denominator > 0; index += 1) {
      this._nsdf[index] = (2 * this._nsdf[index]) / denominator;
      denominator -= frame[index] ** 2 + frame[frame.length - index - 1] ** 2;
    }
    for (; index < this._nsdf.length; index += 1) {
      this._nsdf[index] = 0;
    }
  }
}

// Key maxima per McLeod: within each positive NSDF segment (between a
// positive-going and the next negative-going zero crossing), keep the largest
// sample. A trailing unclosed segment is dropped, matching the reference
// implementation.
function collectKeyMaxima(nsdf) {
  const maxima = [];
  let bestIndex = -1;
  let bestValue = -Infinity;

  for (let index = 1; index < nsdf.length - 1; index += 1) {
    if (nsdf[index - 1] <= 0 && nsdf[index] > 0) {
      bestIndex = index;
      bestValue = nsdf[index];
    } else if (nsdf[index - 1] > 0 && nsdf[index] <= 0) {
      if (bestIndex !== -1) maxima.push(refineMaximum(bestIndex, nsdf));
      bestIndex = -1;
    } else if (bestIndex !== -1 && nsdf[index] > bestValue) {
      bestValue = nsdf[index];
      bestIndex = index;
    }
  }

  return maxima;
}

// Parabolic interpolation through the maximum and its neighbours gives a
// sub-sample lag and peak value. Falls back to the integer sample when the
// three points are degenerate (near-zero curvature).
function refineMaximum(index, nsdf) {
  const [leftIndex, midIndex, rightIndex] = [index - 1, index, index + 1];
  const [left, mid, right] = [nsdf[leftIndex], nsdf[midIndex], nsdf[rightIndex]];
  const a = left / 2 - mid + right / 2;
  const b = -(left / 2) * (midIndex + rightIndex) + mid * (leftIndex + rightIndex) -
    (right / 2) * (leftIndex + midIndex);
  const c = (left * midIndex * rightIndex) / 2 - mid * leftIndex * rightIndex +
    (right * leftIndex * midIndex) / 2;

  const lag = -b / (2 * a);
  const value = a * lag * lag + b * lag + c;
  if (!Number.isFinite(lag) || lag <= 0 || !Number.isFinite(value)) {
    return { lag: index, value: Math.min(nsdf[index], 1) };
  }
  return { lag, value: Math.min(value, 1) };
}

function strongestNearLag(candidates, targetLag, tolerance) {
  let best = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.lag - targetLag) > tolerance * targetLag) continue;
    if (best === null || candidate.value > best.value) best = candidate;
  }
  return best;
}

function nearestByCents(candidates, referenceHz) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(centsBetween(candidate.hz, referenceHz));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * 検出ピッチに最も近いターゲット弦を返す。倍音の推測は一切しない。
 * どのターゲットからも maxDistanceCents より離れていれば -1。
 */
export function nearestStringIndex(hz, targetsHz, maxDistanceCents) {
  if (!Number.isFinite(hz) || hz <= 0 || !Array.isArray(targetsHz)) return -1;

  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < targetsHz.length; index += 1) {
    const targetHz = targetsHz[index];
    if (!Number.isFinite(targetHz) || targetHz <= 0) continue;

    const distance = Math.abs(centsBetween(hz, targetHz));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestDistance <= maxDistanceCents ? bestIndex : -1;
}

// Only average samples near the median cluster. When one cluster has a
// majority, octave errors roughly 1200 cents away cannot drag its mean.
const NEAR_MEDIAN_CENTS = 50;

export function robustMeanHz(values) {
  const logarithms = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.log2)
    .sort((left, right) => left - right);

  if (logarithms.length === 0) return Number.NaN;
  if (logarithms.length <= 2) return 2 ** medianSorted(logarithms);

  const median = medianSorted(logarithms);
  const near = logarithms.filter(
    (value) => Math.abs(1200 * (value - median)) <= NEAR_MEDIAN_CENTS,
  );

  if (near.length === 0) return 2 ** median;
  const mean = near.reduce((sum, value) => sum + value, 0) / near.length;
  return 2 ** mean;
}

export const PITCH_TRACKER_STATES = Object.freeze({
  IDLE: "idle",
  CANDIDATE: "candidate",
  TRACKING: "tracking",
  RELEASE: "release",
});

// Confirmation thresholds are expressed as elapsed time plus a minimum
// sample count so behaviour does not depend on the caller's frame rate
// (requestAnimationFrame runs at 30, 60 or 120 fps depending on the device).
const DEFAULT_TRACKER_OPTIONS = Object.freeze({
  acquireClarityMin: 0.8,
  trackClarityMin: 0.6,
  acquireMinSamples: 2,
  acquireMinMs: 30,
  acquireStabilityCents: 45,
  candidateMaxGapMs: 90,
  medianWindow: 3,
  maxStepCents: 150,
  switchMinSamples: 2,
  switchMinMs: 30,
  switchStabilityCents: 45,
  switchCandidateMaxGapMs: 90,
  octaveToleranceCents: 120,
  octaveSwitchMinSamples: 3,
  octaveSwitchMs: 220,
  releaseMs: 220,
});

/**
 * Stateful, single-candidate pitch tracker for live tuner input.
 *
 * The analyzer's clarity is deliberately used with hysteresis: acquisition
 * requires a high-confidence stable cluster, while an already-acquired note
 * may continue at a lower confidence. Large pitch changes are confirmed as a
 * separate cluster before replacing the tracked pitch. Octave-like changes
 * need extra time because guitar attacks commonly contain a strong harmonic.
 *
 * update({ hz, clarity, nowMs }) returns a snapshot containing state, valueHz
 * and event. `value` is an alias of `valueHz` on both the tracker and snapshot.
 */
export class PitchTracker {
  constructor(options = {}) {
    this.options = Object.freeze({ ...DEFAULT_TRACKER_OPTIONS, ...options });
    validateTrackerOptions(this.options);
    this.reset();
  }

  get valueHz() {
    return this.value;
  }

  reset() {
    this.state = PITCH_TRACKER_STATES.IDLE;
    this.value = null;
    this.event = "reset";
    this._candidate = [];
    this._candidateStartedMs = null;
    this._candidateLastValidMs = null;
    this._recent = [];
    this._switchCandidate = [];
    this._switchStartedMs = null;
    this._switchLastMs = null;
    this._releaseStartedMs = null;
    return this._snapshot(false);
  }

  update({ hz, clarity, nowMs }) {
    const timeMs = Number.isFinite(nowMs) ? nowMs : defaultNowMs();
    this.event = null;

    if (this.state === PITCH_TRACKER_STATES.IDLE) {
      return this._updateIdle(hz, clarity, timeMs);
    }
    if (this.state === PITCH_TRACKER_STATES.CANDIDATE) {
      return this._updateCandidate(hz, clarity, timeMs);
    }
    return this._updateTracked(hz, clarity, timeMs);
  }

  _updateIdle(hz, clarity, timeMs) {
    if (!isUsablePitch(hz, clarity, this.options.acquireClarityMin)) {
      return this._snapshot(false);
    }

    this.state = PITCH_TRACKER_STATES.CANDIDATE;
    this.event = "candidate";
    this._candidate = [Math.log2(hz)];
    this._candidateStartedMs = timeMs;
    this._candidateLastValidMs = timeMs;
    return this._snapshot(false);
  }

  _updateCandidate(hz, clarity, timeMs) {
    if (!isUsablePitch(hz, clarity, this.options.acquireClarityMin)) {
      if (
        this._candidateLastValidMs === null ||
        timeMs - this._candidateLastValidMs >= this.options.candidateMaxGapMs
      ) {
        this._returnToIdle("candidate-lost");
      } else {
        this.event = "candidate-gap";
      }
      return this._snapshot(false);
    }

    const logHz = Math.log2(hz);
    const center = medianSorted([...this._candidate].sort(numberAscending));
    if (logDistanceCents(logHz, center) > this.options.acquireStabilityCents) {
      this._candidate = [logHz];
      this._candidateStartedMs = timeMs;
      this.event = "candidate-restarted";
    } else {
      this._candidate.push(logHz);
      this.event = "candidate";
    }
    this._candidateLastValidMs = timeMs;

    if (
      this._candidate.length < this.options.acquireMinSamples ||
      timeMs - this._candidateStartedMs < this.options.acquireMinMs
    ) {
      return this._snapshot(false);
    }

    this.state = PITCH_TRACKER_STATES.TRACKING;
    this._recent = this._candidate.slice(-this.options.medianWindow);
    this.value = 2 ** medianSorted([...this._recent].sort(numberAscending));
    this.event = "acquired";
    this._candidate = [];
    this._candidateStartedMs = null;
    this._candidateLastValidMs = null;
    return this._snapshot(true);
  }

  _updateTracked(hz, clarity, timeMs) {
    if (!isUsablePitch(hz, clarity, this.options.trackClarityMin)) {
      this._clearSwitchCandidate();
      if (this.state !== PITCH_TRACKER_STATES.RELEASE) {
        this.state = PITCH_TRACKER_STATES.RELEASE;
        this._releaseStartedMs = timeMs;
        this.event = "release-pending";
      } else if (timeMs - this._releaseStartedMs >= this.options.releaseMs) {
        this._returnToIdle("released");
      }
      return this._snapshot(false);
    }

    const logHz = Math.log2(hz);
    const valueLogHz = Math.log2(this.value);
    const stepCents = logDistanceCents(logHz, valueLogHz);
    if (stepCents <= this.options.maxStepCents) {
      if (this.state === PITCH_TRACKER_STATES.RELEASE) {
        this.state = PITCH_TRACKER_STATES.TRACKING;
        this._releaseStartedMs = null;
        this.event = "resumed";
      }
      this._clearSwitchCandidate();
      this._accept(logHz);
      if (this.event === null) this.event = "tracked";
      return this._snapshot(true);
    }

    // A usable frame far from the tracked pitch is evidence of a different
    // tone, not of the tracked note. During RELEASE it must not reset the
    // countdown: periodic tonal blips would otherwise keep a dead note's
    // value on display indefinitely. A stable new cluster may still confirm
    // as a switch before the release expires.
    const snapshot = this._updateSwitchCandidate(logHz, timeMs, stepCents);
    if (this.state !== PITCH_TRACKER_STATES.RELEASE) return snapshot;
    if (this.event === "switched") {
      this.state = PITCH_TRACKER_STATES.TRACKING;
      this._releaseStartedMs = null;
      return this._snapshot(true);
    }
    if (timeMs - this._releaseStartedMs >= this.options.releaseMs) {
      this._returnToIdle("released");
    }
    return this._snapshot(false);
  }

  _updateSwitchCandidate(logHz, timeMs, stepCents) {
    const switchCandidateExpired =
      this._switchLastMs !== null &&
      timeMs - this._switchLastMs > this.options.switchCandidateMaxGapMs;
    if (this._switchCandidate.length === 0 || switchCandidateExpired) {
      this._switchCandidate = [logHz];
      this._switchStartedMs = timeMs;
    } else {
      const center = medianSorted([...this._switchCandidate].sort(numberAscending));
      if (logDistanceCents(logHz, center) > this.options.switchStabilityCents) {
        this._switchCandidate = [logHz];
        this._switchStartedMs = timeMs;
      } else {
        this._switchCandidate.push(logHz);
      }
    }
    this._switchLastMs = timeMs;

    // Octave-like jumps commonly come from a strong attack harmonic, so they
    // must persist longer than an ordinary note change before being believed.
    const octaveLike = isOctaveLike(stepCents, this.options.octaveToleranceCents);
    const minSamples = octaveLike
      ? this.options.octaveSwitchMinSamples
      : this.options.switchMinSamples;
    const minMs = octaveLike ? this.options.octaveSwitchMs : this.options.switchMinMs;
    const enoughSamples = this._switchCandidate.length >= minSamples;
    const enoughTime = timeMs - this._switchStartedMs >= minMs;

    if (!enoughSamples || !enoughTime) {
      this.event = "switch-pending";
      return this._snapshot(false);
    }

    const center = medianSorted([...this._switchCandidate].sort(numberAscending));
    this._recent = [center];
    this.value = 2 ** center;
    this._clearSwitchCandidate();
    this.event = "switched";
    return this._snapshot(true);
  }

  _accept(logHz) {
    this._recent.push(logHz);
    if (this._recent.length > this.options.medianWindow) this._recent.shift();
    this.value = 2 ** medianSorted([...this._recent].sort(numberAscending));
  }

  _clearSwitchCandidate() {
    this._switchCandidate = [];
    this._switchStartedMs = null;
    this._switchLastMs = null;
  }

  _returnToIdle(event) {
    this.state = PITCH_TRACKER_STATES.IDLE;
    this.value = null;
    this.event = event;
    this._candidate = [];
    this._candidateStartedMs = null;
    this._candidateLastValidMs = null;
    this._recent = [];
    this._clearSwitchCandidate();
    this._releaseStartedMs = null;
  }

  _snapshot(accepted) {
    return {
      state: this.state,
      value: this.value,
      valueHz: this.value,
      event: this.event,
      accepted,
    };
  }
}

function validateTrackerOptions(options) {
  // Options were renamed from frame counts to time-plus-sample-count pairs;
  // an unrecognised key (for example the old acquireFrames) must fail loudly
  // instead of silently running on defaults.
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_TRACKER_OPTIONS, key)) {
      throw new TypeError(`unknown tracker option: ${key}`);
    }
  }
  for (const key of [
    "acquireMinSamples",
    "medianWindow",
    "switchMinSamples",
    "octaveSwitchMinSamples",
  ]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new TypeError(`${key} must be a positive integer`);
    }
  }
  for (const key of [
    "acquireClarityMin",
    "trackClarityMin",
    "acquireMinMs",
    "acquireStabilityCents",
    "candidateMaxGapMs",
    "maxStepCents",
    "switchMinMs",
    "switchStabilityCents",
    "switchCandidateMaxGapMs",
    "octaveToleranceCents",
    "octaveSwitchMs",
    "releaseMs",
  ]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new TypeError(`${key} must be a non-negative finite number`);
    }
  }
}

function isUsablePitch(hz, clarity, clarityMin) {
  return Number.isFinite(hz) && hz > 0 &&
    Number.isFinite(clarity) && clarity >= clarityMin;
}

function logDistanceCents(left, right) {
  return Math.abs(1200 * (left - right));
}

function isOctaveLike(distanceCents, toleranceCents) {
  const octaveCount = Math.round(distanceCents / 1200);
  return octaveCount >= 1 &&
    Math.abs(distanceCents - octaveCount * 1200) <= toleranceCents;
}

function numberAscending(left, right) {
  return left - right;
}

function defaultNowMs() {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function medianSorted(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
