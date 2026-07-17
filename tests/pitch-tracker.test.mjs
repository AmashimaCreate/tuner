import assert from "node:assert/strict";
import test from "node:test";

import {
  centsBetween,
  PitchTracker,
  PITCH_TRACKER_STATES,
} from "../pitch-processing.js";

const E2 = 82.4069;

test("requires three stable high-clarity frames after a noisy guitar attack", () => {
  const tracker = new PitchTracker();

  assertIdle(tracker.update({ hz: 166.3, clarity: 0.749, nowMs: 0 }));
  assertIdle(tracker.update({ hz: 157.4, clarity: 0.697, nowMs: 16 }));

  assert.equal(frame(tracker, E2, 0.94, 32).state, PITCH_TRACKER_STATES.CANDIDATE);
  assert.equal(frame(tracker, centsUp(E2, 12), 0.92, 48).state, PITCH_TRACKER_STATES.CANDIDATE);
  const acquired = frame(tracker, centsUp(E2, -8), 0.96, 64);

  assert.equal(acquired.state, PITCH_TRACKER_STATES.TRACKING);
  assert.equal(acquired.event, "acquired");
  assert.equal(acquired.accepted, true);
  assertWithinCents(acquired.valueHz, E2, 12);
});

test("unstable acquisition restarts instead of averaging unrelated pitches", () => {
  const tracker = new PitchTracker();

  frame(tracker, E2, 0.96, 0);
  frame(tracker, centsUp(E2, 20), 0.96, 16);
  const restarted = frame(tracker, centsUp(E2, 90), 0.96, 32);
  assert.equal(restarted.state, PITCH_TRACKER_STATES.CANDIDATE);
  assert.equal(restarted.event, "candidate-restarted");

  frame(tracker, centsUp(E2, 92), 0.96, 48);
  const acquired = frame(tracker, centsUp(E2, 88), 0.96, 64);
  assert.equal(acquired.event, "acquired");
  assertWithinCents(acquired.valueHz, centsUp(E2, 90), 3);
});

test("lower-clarity frames can continue an already acquired track", () => {
  const tracker = acquiredTracker(E2);
  const tracked = frame(tracker, centsUp(E2, 8), 0.8, 48);

  assert.equal(tracked.state, PITCH_TRACKER_STATES.TRACKING);
  assert.equal(tracked.event, "tracked");
  assert.equal(tracked.accepted, true);
  assertWithinCents(tracked.valueHz, E2, 8);
});

test("median-of-three prevents a single accepted wobble moving the output", () => {
  const tracker = acquiredTracker(E2);
  const tracked = frame(tracker, centsUp(E2, 120), 0.98, 48);

  assert.equal(tracked.accepted, true);
  assertWithinCents(tracked.valueHz, E2, 1);
});

test("brief high-clarity octave errors never replace the fundamental", () => {
  const tracker = acquiredTracker(E2);
  let result;

  // Twelve frames are enough to defeat a frame-count-only filter, but this
  // burst is still shorter than the 220 ms guitar-attack guard.
  for (let index = 0; index < 12; index += 1) {
    result = frame(tracker, E2 * 2, 0.99, 48 + index * 16);
    assert.equal(result.event, "switch-pending");
    assertWithinCents(result.valueHz, E2, 1);
  }

  result = frame(tracker, centsUp(E2, 4), 0.94, 240);
  assert.equal(result.event, "tracked");
  assertWithinCents(result.valueHz, E2, 4);
});

test("a sustained real octave transition is eventually accepted", () => {
  const tracker = acquiredTracker(E2);
  const octave = E2 * 2;
  let result;

  for (const nowMs of [48, 103, 158, 213]) {
    result = frame(tracker, octave, 0.98, nowMs);
    assert.equal(result.event, "switch-pending");
    assertWithinCents(result.valueHz, E2, 1);
  }

  result = frame(tracker, octave, 0.98, 268);
  assert.equal(result.event, "switched");
  assert.equal(result.accepted, true);
  assertWithinCents(result.valueHz, octave, 1);
});

test("a long analysis gap expires a pending octave switch", () => {
  const tracker = acquiredTracker(E2);
  const octave = E2 * 2;

  frame(tracker, octave, 0.98, 48);
  frame(tracker, octave, 0.98, 64);
  const afterGap = frame(tracker, octave, 0.98, 300);

  assert.equal(afterGap.event, "switch-pending");
  assert.equal(afterGap.accepted, false);
  assertWithinCents(afterGap.valueHz, E2, 1);
});

test("a stable non-octave pitch change switches after three confirmations", () => {
  const tracker = acquiredTracker(E2);
  const A2 = 110;

  for (const nowMs of [48, 64]) {
    const pending = frame(tracker, A2, 0.96, nowMs);
    assert.equal(pending.event, "switch-pending");
    assertWithinCents(pending.valueHz, E2, 1);
  }

  const switched = frame(tracker, A2, 0.96, 80);
  assert.equal(switched.event, "switched");
  assertWithinCents(switched.valueHz, A2, 1);
});

test("invalid input enters release, can resume, and releases after 220 ms", () => {
  const tracker = acquiredTracker(E2);

  let result = frame(tracker, Number.NaN, 0, 50);
  assert.equal(result.state, PITCH_TRACKER_STATES.RELEASE);
  assert.equal(result.event, "release-pending");
  assertWithinCents(result.valueHz, E2, 1);

  result = frame(tracker, E2, 0.8, 200);
  assert.equal(result.state, PITCH_TRACKER_STATES.TRACKING);
  assert.equal(result.event, "resumed");
  assertWithinCents(result.valueHz, E2, 1);

  frame(tracker, 0, 0, 300);
  result = frame(tracker, 0, 0, 519);
  assert.equal(result.state, PITCH_TRACKER_STATES.RELEASE);
  assertWithinCents(result.valueHz, E2, 1);

  result = frame(tracker, 0, 0, 520);
  assertIdle(result);
  assert.equal(result.event, "released");
  assert.equal(tracker.value, null);
});

test("candidate gaps expire without publishing a pitch", () => {
  const tracker = new PitchTracker();
  frame(tracker, E2, 0.95, 0);

  let result = frame(tracker, E2, 0.4, 89);
  assert.equal(result.state, PITCH_TRACKER_STATES.CANDIDATE);
  assert.equal(result.valueHz, null);

  result = frame(tracker, E2, 0.4, 90);
  assertIdle(result);
  assert.equal(result.event, "candidate-lost");
});

test("reset clears all held pitch and state", () => {
  const tracker = acquiredTracker(E2);
  const reset = tracker.reset();

  assertIdle(reset);
  assert.equal(reset.event, "reset");
  assert.equal(tracker.valueHz, null);
  assert.equal(tracker.event, "reset");
});

function acquiredTracker(hz) {
  const tracker = new PitchTracker();
  frame(tracker, hz, 0.96, 0);
  frame(tracker, hz, 0.96, 16);
  const acquired = frame(tracker, hz, 0.96, 32);
  assert.equal(acquired.event, "acquired");
  return tracker;
}

function frame(tracker, hz, clarity, nowMs) {
  return tracker.update({ hz, clarity, nowMs });
}

function centsUp(hz, cents) {
  return hz * 2 ** (cents / 1200);
}

function assertWithinCents(actualHz, expectedHz, toleranceCents) {
  const errorCents = centsBetween(actualHz, expectedHz);
  assert.ok(
    Math.abs(errorCents) <= toleranceCents,
    `expected ${actualHz}Hz within ${toleranceCents} cents of ${expectedHz}Hz; got ${errorCents}`,
  );
}

function assertIdle(result) {
  assert.equal(result.state, PITCH_TRACKER_STATES.IDLE);
  assert.equal(result.valueHz, null);
  assert.equal(result.accepted, false);
}
