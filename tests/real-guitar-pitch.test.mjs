import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PitchDetector } from "../pitchy.js";
import { PITCHY_MPM_PEAK_THRESHOLD } from "../pitch-processing.js";

const FIXTURE_URL = new URL("./fixtures/fasttune-e2-82hz.wav", import.meta.url);
const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const RETURNED_CLARITY_MIN = 0.9;
const MIN_PITCH_HZ = 60;
const EXPECTED_E2_HZ = 82.4069;
const MAX_STEADY_ERROR_CENTS = 50;

test("Pitchy tracks a real plucked low E without octave or gross errors", () => {
  const { sampleRate, samples } = readMonoPcm16Wav(FIXTURE_URL);
  const detector = PitchDetector.forFloat32Array(FRAME_SIZE);
  detector.clarityThreshold = PITCHY_MPM_PEAK_THRESHOLD;

  const frame = new Float32Array(FRAME_SIZE);
  const accepted = [];

  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    frame.set(samples.subarray(start, start + FRAME_SIZE));
    const [pitchHz, clarity] = detector.findPitch(frame, sampleRate);

    if (
      Number.isFinite(pitchHz)
      && pitchHz >= MIN_PITCH_HZ
      && clarity >= RETURNED_CLARITY_MIN
    ) {
      accepted.push({
        timeSeconds: start / sampleRate,
        pitchHz,
        clarity,
        errorCents: centsBetween(pitchHz, EXPECTED_E2_HZ),
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

function readMonoPcm16Wav(url) {
  const bytes = readFileSync(url);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF", "fixture must be RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE", "fixture must be WAVE");

  let format;
  let data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    assert.ok(chunkEnd <= bytes.length, `truncated ${chunkId} WAV chunk`);

    if (chunkId === "fmt ") {
      assert.ok(chunkSize >= 16, "PCM format chunk must contain 16 bytes");
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channelCount: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      data = bytes.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize & 1);
  }

  assert.ok(format, "fixture must contain a fmt chunk");
  assert.ok(data, "fixture must contain a data chunk");
  assert.equal(format.audioFormat, 1, "fixture must use integer PCM");
  assert.equal(format.channelCount, 1, "fixture must be mono");
  assert.equal(format.bitsPerSample, 16, "fixture must use 16-bit samples");
  assert.equal(format.blockAlign, 2, "mono PCM16 must use a two-byte block");
  assert.equal(data.length % format.blockAlign, 0, "PCM data must be frame-aligned");

  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32768;
  }

  return { sampleRate: format.sampleRate, samples };
}

function centsBetween(hz, referenceHz) {
  return 1200 * Math.log2(hz / referenceHz);
}

function formatFrame({ timeSeconds, pitchHz, clarity, errorCents }) {
  return {
    timeSeconds: Number(timeSeconds.toFixed(3)),
    pitchHz: Number(pitchHz.toFixed(2)),
    clarity: Number(clarity.toFixed(3)),
    errorCents: Number(errorCents.toFixed(1)),
  };
}
