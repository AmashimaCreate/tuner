export function centsBetween(hz, targetHz) {
  return 1200 * Math.log2(hz / targetHz);
}

// Pitchy's MPM peak-picking coefficient. A value close to the maximum peak
// rejects the half-period candidate produced by second-harmonic-heavy guitar
// tones without using the target tuning to fold octaves.
export const PITCHY_MPM_PEAK_THRESHOLD = 0.98;

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

const DEFAULT_TRACKER_OPTIONS = Object.freeze({
  acquireClarityMin: 0.9,
  trackClarityMin: 0.78,
  acquireFrames: 3,
  acquireStabilityCents: 45,
  candidateMaxGapMs: 90,
  medianWindow: 3,
  maxStepCents: 150,
  switchFrames: 3,
  switchStabilityCents: 45,
  switchCandidateMaxGapMs: 90,
  octaveToleranceCents: 120,
  octaveSwitchFrames: 5,
  octaveSwitchMs: 220,
  releaseMs: 220,
});

/**
 * Stateful, single-candidate pitch tracker for live tuner input.
 *
 * PitchDetector's clarity is deliberately used with hysteresis: acquisition
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
      this.event = "candidate-restarted";
    } else {
      this._candidate.push(logHz);
      this.event = "candidate";
    }
    this._candidateLastValidMs = timeMs;

    if (this._candidate.length < this.options.acquireFrames) {
      return this._snapshot(false);
    }

    this.state = PITCH_TRACKER_STATES.TRACKING;
    this._recent = this._candidate.slice(-this.options.medianWindow);
    this.value = 2 ** medianSorted([...this._recent].sort(numberAscending));
    this.event = "acquired";
    this._candidate = [];
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

    if (this.state === PITCH_TRACKER_STATES.RELEASE) {
      this.state = PITCH_TRACKER_STATES.TRACKING;
      this._releaseStartedMs = null;
      this.event = "resumed";
    }

    const logHz = Math.log2(hz);
    const valueLogHz = Math.log2(this.value);
    const stepCents = logDistanceCents(logHz, valueLogHz);
    if (stepCents <= this.options.maxStepCents) {
      this._clearSwitchCandidate();
      this._accept(logHz);
      if (this.event === null) this.event = "tracked";
      return this._snapshot(true);
    }

    return this._updateSwitchCandidate(logHz, timeMs, stepCents);
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

    const octaveLike = isOctaveLike(stepCents, this.options.octaveToleranceCents);
    const enoughFrames = this._switchCandidate.length >= (
      octaveLike ? this.options.octaveSwitchFrames : this.options.switchFrames
    );
    const enoughTime = !octaveLike ||
      timeMs - this._switchStartedMs >= this.options.octaveSwitchMs;

    if (!enoughFrames || !enoughTime) {
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
  for (const key of [
    "acquireFrames",
    "medianWindow",
    "switchFrames",
    "octaveSwitchFrames",
  ]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) {
      throw new TypeError(`${key} must be a positive integer`);
    }
  }
  for (const key of [
    "acquireClarityMin",
    "trackClarityMin",
    "acquireStabilityCents",
    "candidateMaxGapMs",
    "maxStepCents",
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
