import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const FIXTURE_URL = new URL("./fixtures/fasttune-e2-82hz.wav", import.meta.url);
export const FIXTURE_E2_HZ = 82.4069;

export function centsBetween(hz, referenceHz) {
  return 1200 * Math.log2(hz / referenceHz);
}

export function readMonoPcm16Wav(url) {
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

// Speed-change resampling: reading the input at `ratio` speed scales every
// frequency by `ratio`, turning the E2 fixture into any other open string
// while keeping real pluck dynamics, inharmonicity and decay.
export function pitchShift(samples, ratio) {
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const position = index * ratio;
    const base = Math.floor(position);
    const fraction = position - base;
    const next = Math.min(base + 1, samples.length - 1);
    out[index] = samples[base] * (1 - fraction) + samples[next] * fraction;
  }
  return out;
}

// Deterministic uniform noise scaled to a target SNR over the whole clip,
// approximating a phone microphone in a non-silent room.
export function addNoise(samples, snrDb, seed = 12345) {
  let signalPower = 0;
  for (const value of samples) signalPower += value * value;
  const signalRms = Math.sqrt(signalPower / samples.length);
  const noiseRms = signalRms / 10 ** (snrDb / 20);

  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296) - 0.5;
  };

  // Uniform in [-0.5, 0.5) has RMS 1/sqrt(12); scale to the target RMS.
  const scale = noiseRms * Math.sqrt(12);
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    out[index] = samples[index] + random() * scale;
  }
  return out;
}

export function mulberry32(seed) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const EVEN_HEAVY_HARMONICS = [0.08, 1, 0.12, 0.72, 0.08, 0.48, 0.05, 0.3];

// A guitar attack whose second harmonic dominates the fundamental: the
// classic source of octave-up errors in autocorrelation pitch detectors.
export function synthesizeEvenHeavyFrame(frequency, frameSize, sampleRate) {
  const samples = new Float32Array(frameSize);
  const random = mulberry32(1009 + Math.round(frequency * 10));
  const phases = EVEN_HEAVY_HARMONICS.map(() => random() * 2 * Math.PI);
  const inharmonicity = frequency < 100 ? 0.00008 : 0.00003;

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
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
