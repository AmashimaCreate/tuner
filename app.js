import { PitchDetector } from "./pitchy.js";
import {
  centsBetween,
  createHannWindow,
  matchPitchToTargets,
  robustMeanHz,
  spectralMagnitudes,
  TimedKeyStability,
  TimedPitchStability,
} from "./pitch-processing.js";
import { CATEGORIES, TUNINGS } from "./tunings.js";

const CONFIG = {
  detectorClarityThreshold: 0.9,
  clarityAcquireMin: 0.82,
  clarityTrackMin: 0.7,
  rmsAcquireMin: 0.0035,
  rmsReleaseMin: 0.002,
  noiseFloorInitial: 0.001,
  noiseFloorMin: 0.0002,
  noiseFloorMax: 0.0024,
  noiseFloorAcquireMultiplier: 2.5,
  noiseFloorReleaseMultiplier: 1.6,
  noiseCalibrationMs: 300,
  noiseCalibrationTauMs: 80,
  noiseFloorRiseTauMs: 3000,
  noiseFloorFallTauMs: 400,
  captureMs: 70,
  captureStabilityCents: 30,
  candidateMaxGapMs: 100,
  trackingReleaseMs: 260,
  jumpRejectCents: 100,
  jumpConfirmMs: 35,
  jumpStabilityCents: 40,
  holdMs: 1200,
  historyResetMs: 220,
  medianWindow: 5,
  smoothingFastTauMs: 55,
  smoothingFineTauMs: 160,
  smoothingFineRangeCents: 12,
  jitterWindowMs: 1000,
  jitterMinSamples: 8,
  inTuneCents: 5,
  meterRangeCents: 50,
  minPitchHz: 60,
  maxPitchHz: 1200,
  highpassHz: 60,
  lowpassHz: 1500,
  fftSize: 4096,
  concertAHz: 440,
  concertAMin: 415,
  concertAMax: 466,
  concertAStep: 1,
  chimeGain: 0.045,
  chimeStableMs: 240,
  chimeBlankingMs: 480,
  chimeRefractoryMs: 800,
  chimeReleaseCents: 12.5,
  midiA4: 69,
  autoStringMatchMaxCents: 260,
  manualStringMatchMaxCents: 700,
  directPreferenceCents: 35,
  octaveContinuityBonusCents: 15,
  trackedTargetMatchCents: 45,
  harmonicSupportAcquireRatio: 0.06,
  harmonicSupportTrackRatio: 0.025,
  aliasDirectFallbackMaxCents: 60,
  autoStringConfirmMs: 45,
  resumeTimeoutMs: 2000,
};

const HANN_WINDOW = createHannWindow(CONFIG.fftSize);

const autoStringCandidate = new TimedKeyStability({
  durationMs: CONFIG.autoStringConfirmMs,
  maxGapMs: CONFIG.candidateMaxGapMs,
});
const captureCandidate = new TimedPitchStability({
  durationMs: CONFIG.captureMs,
  widthCents: CONFIG.captureStabilityCents,
  maxGapMs: CONFIG.candidateMaxGapMs,
});
const jumpCandidate = new TimedPitchStability({
  durationMs: CONFIG.jumpConfirmMs,
  widthCents: CONFIG.jumpStabilityCents,
  maxGapMs: CONFIG.candidateMaxGapMs,
});
const inTuneCandidate = new TimedKeyStability({
  durationMs: CONFIG.chimeStableMs,
  maxGapMs: CONFIG.candidateMaxGapMs,
});

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const NOTE_SEMITONE = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const DEBUG_ENABLED = new URLSearchParams(window.location.search).get("debug") === "1";
const SETTINGS_STORAGE_KEY = "tuner.settings";
const LEGACY_TUNING_STORAGE_KEY = "tuner.tuningId";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HEADSTOCK_VIEWBOX_WIDTH = 941;
const HEADSTOCK_TYPES = {
  "three-three": {
    label: "3対3",
    image: "./assets/headstock-ebony-no-strings.png",
    pegLayout: [
      { x: 16, y: 54, side: "left" },
      { x: 16, y: 38, side: "left" },
      { x: 16, y: 22, side: "left" },
      { x: 84, y: 22, side: "right" },
      { x: 84, y: 38, side: "right" },
      { x: 84, y: 54, side: "right" },
    ],
    stringLayout: [
      [[351, 1672], [351, 1390], [323, 892]],
      [[396, 1672], [396, 1390], [323, 635]],
      [[441, 1672], [441, 1390], [323, 374]],
      [[486, 1672], [486, 1390], [612, 374]],
      [[531, 1672], [531, 1390], [612, 635]],
      [[576, 1672], [576, 1390], [612, 892]],
    ],
  },
  "six-inline": {
    label: "6連",
    image: "./assets/headstock-six-inline.png",
    pegLayout: [
      { x: 22, y: 83, side: "left" },
      { x: 22, y: 69.5, side: "left" },
      { x: 22, y: 56, side: "left" },
      { x: 22, y: 42.5, side: "left" },
      { x: 22, y: 29, side: "left" },
      { x: 22, y: 15.5, side: "left" },
    ],
    stringLayout: [
      [[351, 1672], [365, 1410], [339, 1055]],
      [[396, 1672], [406, 1410], [367, 916]],
      [[441, 1672], [447, 1410], [395, 775]],
      [[486, 1672], [488, 1410], [423, 635]],
      [[531, 1672], [529, 1410], [452, 495]],
      [[576, 1672], [570, 1410], [480, 355]],
    ],
  },
};
const GAUGE = {
  centerX: 140,
  centerY: 140,
  radius: 100,
  angleRangeDegrees: 70,
  tickStepCents: 2.5,
  tickOuterRadius: 92,
  nearZeroCents: 1.2,
};
const GET_USER_MEDIA_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

const elements = {
  tunerMain: document.querySelector("#tunerMain"),
  tuningButton: document.querySelector("#tuningButton"),
  tuningButtonName: document.querySelector("#tuningButtonName"),
  tuningDialog: document.querySelector("#tuningDialog"),
  tuningDialogClose: document.querySelector("#tuningDialogClose"),
  tuningList: document.querySelector("#tuningList"),
  settingsOpen: document.querySelector("#settings-open"),
  settingsSheet: document.querySelector("#settings-sheet"),
  settingsClose: document.querySelector("#settings-close"),
  headstockThreeThree: document.querySelector("#headstock-three-three"),
  headstockSixInline: document.querySelector("#headstock-six-inline"),
  leftyToggle: document.querySelector("#lefty-toggle"),
  leftyValue: document.querySelector("#lefty-value"),
  soundToggle: document.querySelector("#sound-toggle"),
  soundValue: document.querySelector("#sound-value"),
  hzDown: document.querySelector("#hz-down"),
  hzValue: document.querySelector("#hz-value"),
  hzUp: document.querySelector("#hz-up"),
  headstock: document.querySelector("#headstock"),
  headstockImage: document.querySelector("#headstock-image"),
  gaugeTrack: document.querySelector("#gaugeTrack"),
  gaugeTicks: document.querySelector("#gaugeTicks"),
  gaugeDeviation: document.querySelector("#gaugeDeviation"),
  gaugeMarker: document.querySelector("#gaugeMarker"),
  gaugeNote: document.querySelector("#gaugeNote"),
  gaugeOctave: document.querySelector("#gaugeOctave"),
  gaugeCents: document.querySelector("#gaugeCents"),
  gaugeTunedText: document.querySelector("#gaugeTunedText"),
  tuneStatus: document.querySelector("#tuneStatus"),
  pitchMeter: document.querySelector("#pitchMeter"),
  micButton: document.querySelector("#micButton"),
  errorMessage: document.querySelector("#errorMessage"),
  debugPanel: document.querySelector("#debugPanel"),
  debugRaw: document.querySelector("#debugRaw"),
  debugClarity: document.querySelector("#debugClarity"),
  debugRms: document.querySelector("#debugRms"),
  debugGate: document.querySelector("#debugGate"),
  debugCorrection: document.querySelector("#debugCorrection"),
  debugInput: document.querySelector("#debugInput"),
  debugStable: document.querySelector("#debugStable"),
  debugMidi: document.querySelector("#debugMidi"),
  debugCents: document.querySelector("#debugCents"),
  debugContext: document.querySelector("#debugContext"),
  debugSigmaRaw: document.querySelector("#debugSigmaRaw"),
  debugSigmaStable: document.querySelector("#debugSigmaStable"),
  debugLag: document.querySelector("#debugLag"),
  debugCentsPerSample: document.querySelector("#debugCentsPerSample"),
  debugSampleRate: document.querySelector("#debugSampleRate"),
};

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let highpassNode = null;
let lowpassNode = null;
let analyserNode = null;
let muteGainNode = null;
let pitchDetector = null;
let waveformBuffer = null;
let animationFrameId = null;
let microphoneActive = false;
let microphonePending = false;
let lifecycleGeneration = 0;
let trackEndedHandler = null;

const pitchRing = [];
const rawHzHistory = [];
const stableHzHistory = [];
let lastDetectedAt = null;
let gapHistoryCleared = false;
let previousMidi = null;
let smoothedCents = null;
let lastDisplayAt = null;
let lastStableHz = null;
let trackedPitchKey = null;
let noiseFloorRms = CONFIG.noiseFloorInitial;
let lastNoiseFloorAt = null;
let noiseCalibrationUntil = -Infinity;
let lastMeasuredRms = Number.NaN;
let lastSignalGateRms = CONFIG.rmsAcquireMin;
let lastPitchCorrection = "—";
let ignoreInputUntil = -Infinity;
let currentTuning = TUNINGS.find((tuning) => tuning.id === "standard");
let targetsMidi = [];
let targetsHz = [];
let autoString = -1;
let manualString = null;
let headstockType = "three-three";
let leftHanded = false;
let soundEnabled = true;
let concertAHz = CONFIG.concertAHz;
let chimeArmed = true;
let lastChimeAt = -Infinity;
const activeChimeVoices = new Set();
let activeChimeMaster = null;

const initialSettings = loadSettings();
initializeGauge();
renderTuningPicker();
applyTuning(initialSettings.tuningId, { persist: false });
syncSettingsUI();
if (initialSettings.migrateLegacy) saveSettings({ removeLegacy: true });
elements.debugPanel.hidden = !DEBUG_ENABLED;
setMeterRangeAttributes();
updateDebugPanel();
showInitialEnvironmentError();

elements.micButton.addEventListener("click", () => {
  if (microphonePending) return;

  if (microphoneActive) {
    stopMicrophone();
    return;
  }

  void startMicrophoneFromGesture();
});

elements.tuningButton.addEventListener("click", openTuningDialog);
elements.tuningDialogClose.addEventListener("click", closeTuningDialog);
elements.tuningDialog.addEventListener("close", () => {
  elements.tuningButton.setAttribute("aria-expanded", "false");
});
elements.tuningDialog.addEventListener("click", (event) => {
  if (event.target === elements.tuningDialog) closeTuningDialog();
});

elements.settingsOpen.addEventListener("click", openSettingsSheet);
elements.settingsClose.addEventListener("click", closeSettingsSheet);
elements.settingsSheet.addEventListener("close", () => {
  elements.settingsOpen.setAttribute("aria-expanded", "false");
  elements.settingsOpen.focus();
});
elements.settingsSheet.addEventListener("click", (event) => {
  if (event.target === elements.settingsSheet) closeSettingsSheet();
});
elements.settingsSheet.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSettingsSheet();
});
elements.settingsSheet.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeSettingsSheet();
});
elements.headstockThreeThree.addEventListener("click", () => {
  setHeadstockType("three-three");
});
elements.headstockSixInline.addEventListener("click", () => {
  setHeadstockType("six-inline");
});
elements.leftyToggle.addEventListener("click", () => {
  leftHanded = !leftHanded;
  renderHeadstock();
  syncSettingsUI();
  saveSettings();
});
elements.soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  resetChime();
  syncSettingsUI();
  saveSettings();
});
elements.hzDown.addEventListener("click", () => {
  setConcertA(concertAHz - CONFIG.concertAStep);
});
elements.hzUp.addEventListener("click", () => {
  setConcertA(concertAHz + CONFIG.concertAStep);
});

elements.tuningList.addEventListener("click", (event) => {
  const option = event.target.closest(".tuning-option");
  if (!option) return;
  applyTuning(option.dataset.tuningId, { persist: true });
  closeTuningDialog();
});

elements.headstock.addEventListener("click", (event) => {
  const peg = event.target.closest(".peg");
  if (!peg) return;
  onPegTap(Number(peg.dataset.i));
});

elements.headstock.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const peg = event.target.closest(".peg");
  if (!peg) return;
  event.preventDefault();
  onPegTap(Number(peg.dataset.i));
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnalysisLoop();
    return;
  }

  if (!microphoneActive) return;

  scheduleAnalysisFrame();
  if (audioContext && audioContext.state !== "running" && audioContext.state !== "closed") {
    void resumeAudioContext(audioContext).catch(() => {
      setError("音声入力を再開できません。マイクを再開してください");
    }).finally(updateDebugPanel);
  }
});

async function startMicrophoneFromGesture() {
  if (microphoneActive || microphonePending) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!isMicrophoneEnvironmentSupported(AudioContextClass)) return;

  const generation = ++lifecycleGeneration;
  microphonePending = true;
  setError("");
  setButtonPending(true);

  let nextContext = null;
  let nextStream = null;
  let nextSource = null;
  let nextHighpass = null;
  let nextLowpass = null;
  let nextAnalyser = null;
  let nextMuteGain = null;

  try {
    // This construction and first resume call happen directly in the button event turn.
    nextContext = new AudioContextClass();
    nextContext.onstatechange = updateDebugPanel;
    await resumeAudioContext(nextContext);
    nextStream = await navigator.mediaDevices.getUserMedia(GET_USER_MEDIA_CONSTRAINTS);

    if (generation !== lifecycleGeneration) {
      await releaseAudioResources({ context: nextContext, stream: nextStream });
      return;
    }

    nextSource = nextContext.createMediaStreamSource(nextStream);

    nextHighpass = nextContext.createBiquadFilter();
    nextHighpass.type = "highpass";
    nextHighpass.frequency.value = CONFIG.highpassHz;

    nextLowpass = nextContext.createBiquadFilter();
    nextLowpass.type = "lowpass";
    nextLowpass.frequency.value = CONFIG.lowpassHz;

    nextAnalyser = nextContext.createAnalyser();
    nextAnalyser.fftSize = CONFIG.fftSize;
    nextAnalyser.smoothingTimeConstant = 0;

    nextMuteGain = nextContext.createGain();
    nextMuteGain.gain.value = 0;

    nextSource.connect(nextHighpass);
    nextHighpass.connect(nextLowpass);
    nextLowpass.connect(nextAnalyser);
    nextAnalyser.connect(nextMuteGain);
    nextMuteGain.connect(nextContext.destination);

    const nextDetector = PitchDetector.forFloat32Array(CONFIG.fftSize);
    nextDetector.clarityThreshold = CONFIG.detectorClarityThreshold;
    const nextBuffer = new Float32Array(CONFIG.fftSize);

    // The permission sheet can suspend AudioContext on iOS, so resume again here.
    await resumeAudioContext(nextContext);

    if (generation !== lifecycleGeneration) {
      await releaseAudioResources({
        context: nextContext,
        stream: nextStream,
        nodes: [nextSource, nextHighpass, nextLowpass, nextAnalyser, nextMuteGain],
      });
      return;
    }

    audioContext = nextContext;
    mediaStream = nextStream;
    sourceNode = nextSource;
    highpassNode = nextHighpass;
    lowpassNode = nextLowpass;
    analyserNode = nextAnalyser;
    muteGainNode = nextMuteGain;
    pitchDetector = nextDetector;
    waveformBuffer = nextBuffer;
    microphoneActive = true;
    microphonePending = false;

    const inputTrack = mediaStream.getAudioTracks()[0];
    trackEndedHandler = () => {
      if (!microphoneActive || generation !== lifecycleGeneration) return;
      stopMicrophone();
      setError("マイク入力が停止しました。もう一度開始してください");
    };
    inputTrack?.addEventListener("ended", trackEndedHandler, { once: true });

    resetChime({ clearBlanking: true });
    resetDetectionData();
    resetNoiseModel(performance.now());
    resetDisplay();
    setButtonActive(true);
    updateDebugPanel();
    scheduleAnalysisFrame();
  } catch (error) {
    await releaseAudioResources({
      context: nextContext,
      stream: nextStream,
      nodes: [nextSource, nextHighpass, nextLowpass, nextAnalyser, nextMuteGain],
    });

    if (generation !== lifecycleGeneration) return;

    microphoneActive = false;
    microphonePending = false;
    setButtonActive(false);
    setButtonPending(false);
    setError(getMicrophoneErrorMessage(error));
    updateDebugPanel();
  }
}

function stopMicrophone() {
  ++lifecycleGeneration;
  microphoneActive = false;
  microphonePending = false;
  cancelAnalysisLoop();

  const resources = {
    context: audioContext,
    stream: mediaStream,
    nodes: [sourceNode, highpassNode, lowpassNode, analyserNode, muteGainNode],
    endedHandler: trackEndedHandler,
  };

  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  highpassNode = null;
  lowpassNode = null;
  analyserNode = null;
  muteGainNode = null;
  pitchDetector = null;
  waveformBuffer = null;
  trackEndedHandler = null;

  resetChime({ clearBlanking: true });
  resetDetectionData();
  resetNoiseModel();
  resetDisplay();
  setButtonActive(false);
  setButtonPending(false);
  updateDebugPanel();
  void releaseAudioResources(resources);
}

async function releaseAudioResources({ context, stream, nodes = [], endedHandler = null }) {
  const audioTrack = stream?.getAudioTracks()[0];
  if (audioTrack && endedHandler) {
    audioTrack.removeEventListener("ended", endedHandler);
  }

  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }

  for (const node of nodes) {
    if (!node) continue;
    try {
      node.disconnect();
    } catch {
      // A partially built graph can contain a node that was never connected.
    }
  }

  if (!context) return;
  context.onstatechange = null;
  if (context.state !== "closed") {
    try {
      await context.close();
    } catch {
      // Resource references are already released; a closing browser context is safe to ignore.
    }
  }
}

function scheduleAnalysisFrame() {
  if (!microphoneActive || document.hidden || animationFrameId !== null) return;
  animationFrameId = requestAnimationFrame(analyseFrame);
}

function cancelAnalysisLoop() {
  if (animationFrameId === null) return;
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
}

function analyseFrame(now) {
  animationFrameId = null;
  if (!microphoneActive || document.hidden) return;

  try {
    const track = mediaStream?.getAudioTracks()[0];
    const inputReady =
      audioContext?.state === "running" &&
      analyserNode &&
      pitchDetector &&
      waveformBuffer &&
      track?.readyState === "live" &&
      !track.muted;

    if (!inputReady) {
      processInvalidFrame(now, { rawHz: Number.NaN, clarity: Number.NaN });
      return;
    }

    analyserNode.getFloatTimeDomainData(waveformBuffer);
    const rms = calculateRms(waveformBuffer);
    const tracking = isPitchTracking(now);
    lastMeasuredRms = rms;

    if (now < ignoreInputUntil) {
      const signalGateRms = getSignalGateRms(tracking);
      lastSignalGateRms = signalGateRms;
      updateDebugPanel({
        rawHz: Number.NaN,
        clarity: Number.NaN,
        stableHz: lastStableHz,
        rms,
        signalGateRms,
        correction: "効果音待避",
      });
      return;
    }

    const calibratingNoise = now < noiseCalibrationUntil;
    updateNoiseFloor(rms, now, tracking, calibratingNoise);
    let signalGateRms = getSignalGateRms(tracking);
    const [rawHz, clarity] = pitchDetector.findPitch(waveformBuffer, audioContext.sampleRate);
    const clarityMin = tracking ? CONFIG.clarityTrackMin : CONFIG.clarityAcquireMin;
    if (
      !tracking &&
      !calibratingNoise &&
      Number.isFinite(clarity) &&
      clarity < CONFIG.clarityAcquireMin &&
      rms > signalGateRms
    ) {
      updateNoiseFloor(rms, now, false, true);
      signalGateRms = getSignalGateRms(false);
    }
    lastSignalGateRms = signalGateRms;
    const valid =
      !calibratingNoise &&
      Number.isFinite(rawHz) &&
      rawHz >= CONFIG.minPitchHz &&
      rawHz <= CONFIG.maxPitchHz &&
      Number.isFinite(clarity) &&
      clarity >= clarityMin &&
      rms >= signalGateRms;

    if (valid) {
      const resolved = resolveDetectedPitch(rawHz, tracking);
      if (!resolved) {
        processInvalidFrame(now, {
          rawHz,
          clarity,
          rms,
          signalGateRms,
          correction: "対象外",
        });
        return;
      }

      if (currentTuning.notes !== null && manualString === null) {
        const stringReady = confirmAutoString(resolved.targetIndex, now);
        if (!stringReady || autoString !== resolved.targetIndex) {
          // Stability frames must be consecutive for the same string.
          resetCaptureCandidate();
          resetJumpCandidate();
          processUnconfirmedFrame(now, {
            rawHz,
            clarity,
            rms,
            signalGateRms,
            correction: `${resolved.correctionLabel} / 弦確認`,
          });
          return;
        }
      }

      if (!tracking && !confirmPitchCapture(resolved.hz, now)) {
        processUnconfirmedFrame(now, {
          rawHz,
          clarity,
          rms,
          signalGateRms,
          correction: `${resolved.correctionLabel} / 音程確認`,
        });
        return;
      }

      if (tracking && !confirmTrackedPitch(resolved.hz, now)) {
        processUnconfirmedFrame(now, {
          rawHz,
          clarity,
          rms,
          signalGateRms,
          correction: `${resolved.correctionLabel} / 跳び確認`,
        });
        return;
      }

      const pitchKey = getResolvedPitchKey(resolved.hz);
      if (pitchKey !== trackedPitchKey) {
        clearPitchHistory({ clearStableValue: true });
        trackedPitchKey = pitchKey;
        resetTuneStability();
      }

      pitchRing.push(resolved.hz);
      if (pitchRing.length > CONFIG.medianWindow) pitchRing.shift();

      const stableHz = robustMeanHz(pitchRing);
      pushJitterSample(rawHzHistory, now, rawHz);
      pushJitterSample(stableHzHistory, now, stableHz);
      lastDetectedAt = now;
      gapHistoryCleared = false;
      lastStableHz = stableHz;
      lastPitchCorrection = resolved.correctionLabel;
      updateDisplay(stableHz, now);
      updateDebugPanel({
        rawHz,
        clarity,
        stableHz,
        rms,
        signalGateRms,
        correction: resolved.correctionLabel,
      });
    } else {
      processInvalidFrame(now, {
        rawHz,
        clarity,
        rms,
        signalGateRms,
        correction: calibratingNoise ? "ノイズ校正" : undefined,
      });
    }
  } catch {
    processInvalidFrame(now, { rawHz: Number.NaN, clarity: Number.NaN });
  } finally {
    // Invalid or temporarily unavailable input must never kill the active loop.
    scheduleAnalysisFrame();
  }
}

function processInvalidFrame(now, values = {}) {
  resetCaptureCandidate();
  resetJumpCandidate();
  resetAutoStringCandidate();
  resetTuneStability();

  if (
    lastDetectedAt !== null &&
    now - lastDetectedAt > CONFIG.historyResetMs &&
    !gapHistoryCleared
  ) {
    clearPitchHistory({ clearStableValue: false });
    resetAutoStringCandidate();
    gapHistoryCleared = true;
  }

  if (lastDetectedAt === null || now - lastDetectedAt > CONFIG.holdMs) {
    resetDisplay();
  } else {
    dimDisplay();
  }

  updateDebugPanel({ ...values, stableHz: lastStableHz });
}

function processUnconfirmedFrame(now, values = {}) {
  resetTuneStability();
  if (lastDetectedAt !== null && now - lastDetectedAt > CONFIG.holdMs) {
    resetDisplay();
  } else if (lastDetectedAt !== null) {
    dimDisplay();
  }
  updateDebugPanel({ ...values, stableHz: lastStableHz });
}

function updateDisplay(stableHz, now) {
  let measurement;

  if (currentTuning.notes === null) {
    measurement = analyzePitch(stableHz);
  } else {
    const stringIndex = activeString();
    if (stringIndex < 0) {
      renderNoTargetDisplay();
      updateDebugPanel({ stableHz, midi: Number.NaN, cents: Number.NaN });
      return;
    }

    measurement = {
      midi: targetsMidi[stringIndex],
      cents: centsBetween(stableHz, targetsHz[stringIndex]),
    };
  }

  const { midi, cents } = measurement;

  if (midi !== previousMidi || smoothedCents === null || lastDisplayAt === null) {
    smoothedCents = cents;
  } else {
    const deltaMs = Math.max(0, now - lastDisplayAt);
    const smoothingTauMs =
      Math.abs(cents - smoothedCents) > CONFIG.smoothingFineRangeCents
        ? CONFIG.smoothingFastTauMs
        : CONFIG.smoothingFineTauMs;
    const alpha = 1 - Math.exp(-deltaMs / smoothingTauMs);
    smoothedCents = alpha * cents + (1 - alpha) * smoothedCents;
  }
  lastDisplayAt = now;
  previousMidi = midi;

  const noteIndex = ((midi % NOTE_NAMES.length) + NOTE_NAMES.length) % NOTE_NAMES.length;
  const octave = Math.floor(midi / NOTE_NAMES.length) - 1;
  const gaugeCents = clamp(
    smoothedCents,
    -CONFIG.meterRangeCents,
    CONFIG.meterRangeCents,
  );
  const inTune = Math.abs(smoothedCents) <= CONFIG.inTuneCents;
  const noteName = NOTE_NAMES[noteIndex];
  const centsText = formatCents(smoothedCents);

  updateChime(smoothedCents, now);

  elements.gaugeNote.textContent = noteName;
  elements.gaugeOctave.textContent = String(octave);
  elements.gaugeCents.textContent = centsText;
  renderGaugeValue(gaugeCents);
  elements.pitchMeter.setAttribute("aria-valuenow", gaugeCents.toFixed(1));
  elements.pitchMeter.setAttribute(
    "aria-valuetext",
    `${noteName}${octave}、${centsText}`,
  );
  elements.tunerMain.dataset.signal = "active";
  elements.tunerMain.dataset.tuned = String(inTune);
  const tuneStatusText = inTune ? "✓ 合っている" : "";
  elements.gaugeTunedText.textContent = tuneStatusText;
  if (elements.tuneStatus.textContent !== tuneStatusText) {
    elements.tuneStatus.textContent = tuneStatusText;
  }

  updateDebugPanel({ stableHz, midi, cents: smoothedCents });
}

function updateChime(cents, now) {
  if (!soundEnabled) {
    chimeArmed = true;
    resetTuneStability();
    return;
  }

  const absoluteCents = Math.abs(cents);
  const inTune = absoluteCents <= CONFIG.inTuneCents;
  const refractoryElapsed = now - lastChimeAt >= CONFIG.chimeRefractoryMs;

  if (!inTune) {
    resetTuneStability();
    // Ignore pitch disturbance caused by the chime itself during the refractory period.
    if (absoluteCents > CONFIG.chimeReleaseCents && refractoryElapsed) {
      chimeArmed = true;
    }
    return;
  }

  const stableLongEnough = inTuneCandidate.push("in-tune", now);

  if (chimeArmed && refractoryElapsed && stableLongEnough && playInTuneChime(now)) {
    lastChimeAt = now;
    chimeArmed = false;
    resetTuneStability();
  }
}

function playInTuneChime(now) {
  if (!soundEnabled || !audioContext || audioContext.state !== "running") return false;

  stopActiveChime();
  ignoreInputUntil = Math.max(ignoreInputUntil, now + CONFIG.chimeBlankingMs);
  clearPitchHistory({ clearStableValue: false });
  resetCaptureCandidate();
  resetJumpCandidate();

  const context = audioContext;
  const startTime = context.currentTime;
  const masterGain = context.createGain();
  activeChimeMaster = masterGain;
  masterGain.gain.setValueAtTime(1, startTime);
  masterGain.connect(context.destination);

  for (const { hz, at } of [
    { hz: 880, at: 0 },
    { hz: 1318.5, at: 0.09 },
  ]) {
    const oscillator = context.createOscillator();
    const noteGain = context.createGain();
    const noteStart = startTime + at;
    const voice = { oscillator, noteGain };
    activeChimeVoices.add(voice);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(hz, noteStart);
    noteGain.gain.setValueAtTime(0.0001, noteStart);
    noteGain.gain.exponentialRampToValueAtTime(CONFIG.chimeGain, noteStart + 0.012);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.18);
    oscillator.connect(noteGain);
    noteGain.connect(masterGain);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.2);
    oscillator.onended = () => {
      activeChimeVoices.delete(voice);
      try {
        oscillator.disconnect();
        noteGain.disconnect();
      } catch {
        // The audio context may already have been closed by the stop button.
      }
    };
  }

  setTimeout(() => {
    try {
      masterGain.disconnect();
    } catch {
      // The audio context may already have been closed by the stop button.
    }
    if (activeChimeMaster === masterGain) activeChimeMaster = null;
  }, 500);

  return true;
}

function resetChime({ clearBlanking = false } = {}) {
  stopActiveChime();
  chimeArmed = true;
  lastChimeAt = -Infinity;
  resetTuneStability();
  if (clearBlanking) ignoreInputUntil = -Infinity;
}

function stopActiveChime() {
  for (const voice of activeChimeVoices) {
    voice.oscillator.onended = null;
    try {
      voice.oscillator.stop();
    } catch {
      // A voice that already ended only needs disconnecting.
    }
    try {
      voice.oscillator.disconnect();
      voice.noteGain.disconnect();
    } catch {
      // The audio context may already be closed.
    }
  }
  activeChimeVoices.clear();
  if (!activeChimeMaster) return;
  try {
    activeChimeMaster.disconnect();
  } catch {
    // The audio context may already be closed.
  }
  activeChimeMaster = null;
}

function resetTuneStability() {
  inTuneCandidate.reset();
}

function dimDisplay() {
  if (elements.tunerMain.dataset.signal !== "empty") {
    elements.tunerMain.dataset.signal = "dim";
  }
}

function resetDisplay() {
  clearPitchHistory({ clearStableValue: true });
  lastDetectedAt = null;
  gapHistoryCleared = false;
  resetCaptureCandidate();
  resetJumpCandidate();
  resetAutoStringCandidate();
  autoString = -1;
  trackedPitchKey = null;
  lastPitchCorrection = "—";
  resetTuneStability();

  elements.gaugeNote.textContent = "—";
  elements.gaugeOctave.textContent = "";
  elements.gaugeCents.textContent = "—";
  elements.gaugeDeviation.setAttribute("hidden", "");
  elements.gaugeMarker.setAttribute("hidden", "");
  elements.pitchMeter.setAttribute("aria-valuenow", "0");
  elements.pitchMeter.setAttribute("aria-valuetext", "音程未検出");
  elements.tunerMain.dataset.signal = "empty";
  elements.tunerMain.dataset.tuned = "false";
  elements.gaugeTunedText.textContent = "";
  if (elements.tuneStatus.textContent) elements.tuneStatus.textContent = "";
  renderHeadstock();
}

function resetDetectionData() {
  clearPitchHistory({ clearStableValue: true });
  lastDetectedAt = null;
  gapHistoryCleared = false;
  resetCaptureCandidate();
  resetJumpCandidate();
  resetAutoStringCandidate();
  trackedPitchKey = null;
  lastPitchCorrection = "—";
  lastMeasuredRms = Number.NaN;
  lastSignalGateRms = CONFIG.rmsAcquireMin;
}

function resetNoiseModel(startedAt = null) {
  noiseFloorRms = CONFIG.noiseFloorInitial;
  lastNoiseFloorAt = null;
  noiseCalibrationUntil = Number.isFinite(startedAt)
    ? startedAt + CONFIG.noiseCalibrationMs
    : -Infinity;
}

function clearPitchHistory({ clearStableValue }) {
  pitchRing.length = 0;
  rawHzHistory.length = 0;
  stableHzHistory.length = 0;
  previousMidi = null;
  smoothedCents = null;
  lastDisplayAt = null;
  if (clearStableValue) lastStableHz = null;
}

function initializeGauge() {
  elements.gaugeTrack.setAttribute(
    "d",
    arcPath(-CONFIG.meterRangeCents, CONFIG.meterRangeCents, GAUGE.radius),
  );

  const fragment = document.createDocumentFragment();
  for (
    let cents = -CONFIG.meterRangeCents;
    cents <= CONFIG.meterRangeCents;
    cents += GAUGE.tickStepCents
  ) {
    const major = isMultipleOf(cents, 25);
    const medium = !major && isMultipleOf(cents, 5);
    const length = major ? 11 : medium ? 6 : 3.5;
    const width = major ? 1.8 : 1;
    const opacity = major ? 0.4 : medium ? 0.19 : 0.1;
    const outer = pt(cents, GAUGE.tickOuterRadius);
    const inner = pt(cents, GAUGE.tickOuterRadius - length);
    const tick = document.createElementNS(SVG_NAMESPACE, "line");

    tick.setAttribute("x1", outer[0].toFixed(1));
    tick.setAttribute("y1", outer[1].toFixed(1));
    tick.setAttribute("x2", inner[0].toFixed(1));
    tick.setAttribute("y2", inner[1].toFixed(1));
    tick.setAttribute("stroke", "#ffffff");
    tick.setAttribute("stroke-width", String(width));
    tick.setAttribute("opacity", String(opacity));
    fragment.append(tick);
  }

  elements.gaugeTicks.replaceChildren(fragment);
}

function pt(cents, radius) {
  const angle =
    (cents / CONFIG.meterRangeCents) *
    GAUGE.angleRangeDegrees *
    Math.PI / 180;
  return [
    GAUGE.centerX + radius * Math.sin(angle),
    GAUGE.centerY - radius * Math.cos(angle),
  ];
}

function arcPath(startCents, endCents, radius) {
  const start = pt(startCents, radius);
  const end = pt(endCents, radius);
  const sweep = endCents > startCents ? 1 : 0;
  return `M${start[0].toFixed(1)} ${start[1].toFixed(1)}A${radius} ${radius} 0 0 ${sweep} ${end[0].toFixed(1)} ${end[1].toFixed(1)}`;
}

function isMultipleOf(value, divisor) {
  return Math.abs(value / divisor - Math.round(value / divisor)) < Number.EPSILON * 10;
}

function renderGaugeValue(cents) {
  const point = pt(cents, GAUGE.radius);
  elements.gaugeMarker.setAttribute("cx", point[0].toFixed(1));
  elements.gaugeMarker.setAttribute("cy", point[1].toFixed(1));
  elements.gaugeMarker.removeAttribute("hidden");

  if (Math.abs(cents) < GAUGE.nearZeroCents) {
    elements.gaugeDeviation.setAttribute("hidden", "");
    return;
  }

  elements.gaugeDeviation.setAttribute("d", arcPath(0, cents, GAUGE.radius));
  elements.gaugeDeviation.removeAttribute("hidden");
}

function renderNoTargetDisplay() {
  previousMidi = null;
  smoothedCents = null;
  lastDisplayAt = null;
  elements.gaugeNote.textContent = "—";
  elements.gaugeOctave.textContent = "";
  elements.gaugeCents.textContent = "—";
  elements.gaugeDeviation.setAttribute("hidden", "");
  elements.gaugeMarker.setAttribute("hidden", "");
  elements.gaugeTunedText.textContent = "";
  elements.pitchMeter.setAttribute("aria-valuenow", "0");
  elements.pitchMeter.setAttribute("aria-valuetext", "該当する弦なし");
  elements.tunerMain.dataset.signal = "empty";
  elements.tunerMain.dataset.tuned = "false";
  if (elements.tuneStatus.textContent) elements.tuneStatus.textContent = "";
}

function noteToMidi(note) {
  const match = /^([A-G]#?)(-?\d+)$/.exec(note);
  if (!match) throw new Error(`bad note: ${note}`);
  return NOTE_SEMITONE[match[1]] + (Number(match[2]) + 1) * 12;
}

function midiToHz(midi) {
  return concertAHz * 2 ** ((midi - CONFIG.midiA4) / 12);
}

function resolveDetectedPitch(rawHz, tracking) {
  if (currentTuning.notes === null) {
    return {
      rawHz,
      hz: rawHz,
      targetIndex: -1,
      correction: "none",
      correctionLabel: "×1",
    };
  }

  const match = matchPitchToTargets(rawHz, targetsHz, {
    onlyIndex: manualString,
    preferredIndex: tracking && manualString === null ? autoString : -1,
    maxDistanceCents:
      manualString === null
        ? CONFIG.autoStringMatchMaxCents
        : CONFIG.manualStringMatchMaxCents,
    directPreferenceCents: CONFIG.directPreferenceCents,
    continuityBonusCents: CONFIG.octaveContinuityBonusCents,
    preferPreferredTarget: tracking && manualString === null,
    preferredTargetMaxCents: CONFIG.trackedTargetMatchCents,
  });
  if (manualString !== null || !match) return match;
  return resolveHarmonicAlias(match, tracking);
}

function resolveHarmonicAlias(match, tracking) {
  const directMatch = match.correction === "none"
    ? match
    : match.directAlternative;
  const harmonicMatches = [
    ...(match.correction.startsWith("harmonic-") ? [match] : []),
    ...(match.harmonicAlternatives ?? []),
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (other) =>
          other.targetIndex === candidate.targetIndex &&
          other.correction === candidate.correction,
      ) === index,
  );
  if (harmonicMatches.length === 0 || !waveformBuffer || !audioContext) {
    return match;
  }

  const magnitudes = spectralMagnitudes(
    waveformBuffer,
    audioContext.sampleRate,
    [match.rawHz, ...harmonicMatches.map((candidate) => candidate.hz)],
    HANN_WINDOW,
  );
  const [detectedMagnitude, ...fundamentalMagnitudes] = magnitudes;
  if (!Number.isFinite(detectedMagnitude) || detectedMagnitude <= 0) return match;

  let supported = null;
  for (const [index, harmonicMatch] of harmonicMatches.entries()) {
    const fundamentalMagnitude = fundamentalMagnitudes[index];
    const supportRatio = Number.isFinite(fundamentalMagnitude)
      ? fundamentalMagnitude / detectedMagnitude
      : 0;
    const threshold =
      tracking && autoString === harmonicMatch.targetIndex
        ? CONFIG.harmonicSupportTrackRatio
        : CONFIG.harmonicSupportAcquireRatio;
    const confidence = supportRatio / threshold;
    if (confidence >= 1 && (!supported || confidence > supported.confidence)) {
      supported = { match: harmonicMatch, supportRatio, confidence };
    }
  }

  const fallback =
    tracking &&
    match.correction.startsWith("harmonic-") &&
    directMatch &&
    directMatch !== match &&
    directMatch.distanceCents <= CONFIG.aliasDirectFallbackMaxCents
      ? directMatch
      : match;
  return supported
    ? { ...supported.match, harmonicSupportRatio: supported.supportRatio }
    : { ...fallback, harmonicSupportRatio: 0 };
}

function confirmAutoString(targetIndex, now) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return false;

  if (targetIndex === autoString) {
    resetAutoStringCandidate();
    return true;
  }

  if (!autoStringCandidate.push(targetIndex, now)) return false;

  autoString = targetIndex;
  resetAutoStringCandidate();
  clearPitchHistory({ clearStableValue: true });
  trackedPitchKey = null;
  resetJumpCandidate();
  resetTuneStability();
  renderHeadstock();
  return true;
}

function resetAutoStringCandidate() {
  autoStringCandidate.reset();
}

function activeString() {
  return manualString ?? (autoString >= 0 ? autoString : -1);
}

function onPegTap(index) {
  if (currentTuning.notes === null || !Number.isInteger(index) || index < 0 || index > 5) {
    return;
  }

  manualString = manualString === index ? null : index;
  autoString = -1;
  resetChime();
  resetDetectionData();
  resetDisplay();
}

function applyTuning(id, { persist }) {
  const nextTuning =
    TUNINGS.find((tuning) => tuning.id === id) ??
    TUNINGS.find((tuning) => tuning.id === "standard");

  currentTuning = nextTuning;
  targetsMidi = currentTuning.notes?.map(noteToMidi) ?? [];
  rebuildTargets();
  autoString = -1;
  manualString = null;
  resetChime();

  elements.tuningButtonName.textContent = currentTuning.name;
  elements.tuningButton.setAttribute(
    "aria-label",
    `チューニングを選択、現在は${currentTuning.name}`,
  );
  updateTuningPickerSelection();
  resetDetectionData();
  resetDisplay();

  if (persist) saveSettings();
}

function loadSettings() {
  let tuningId = "standard";
  let hasStoredTuning = false;
  let migrateLegacy = false;

  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && typeof stored === "object") {
        if (
          typeof stored.headstockType === "string" &&
          Object.hasOwn(HEADSTOCK_TYPES, stored.headstockType)
        ) {
          headstockType = stored.headstockType;
        }
        if (typeof stored.leftHanded === "boolean") leftHanded = stored.leftHanded;
        if (typeof stored.soundEnabled === "boolean") soundEnabled = stored.soundEnabled;
        if (Number.isFinite(stored.concertAHz)) {
          concertAHz = clamp(
            Math.round(stored.concertAHz),
            CONFIG.concertAMin,
            CONFIG.concertAMax,
          );
        }
        if (
          typeof stored.tuningId === "string" &&
          TUNINGS.some((tuning) => tuning.id === stored.tuningId)
        ) {
          tuningId = stored.tuningId;
          hasStoredTuning = true;
        }
      }
    }
  } catch {
    // Invalid or unavailable storage must not block tuner startup.
  }

  if (!hasStoredTuning) {
    try {
      const legacyId = localStorage.getItem(LEGACY_TUNING_STORAGE_KEY);
      if (TUNINGS.some((tuning) => tuning.id === legacyId)) {
        tuningId = legacyId;
        migrateLegacy = true;
      }
    } catch {
      // The in-memory defaults remain usable when storage is unavailable.
    }
  }

  return { tuningId, migrateLegacy };
}

function saveSettings({ removeLegacy = false } = {}) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      tuningId: currentTuning.id,
      headstockType,
      leftHanded,
      soundEnabled,
      concertAHz,
    }));
    if (removeLegacy) localStorage.removeItem(LEGACY_TUNING_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing; settings still work for this session.
  }
}

function renderTuningPicker() {
  const fragment = document.createDocumentFragment();

  for (const category of CATEGORIES) {
    const tunings = TUNINGS.filter((tuning) => tuning.cat === category.id);
    if (tunings.length === 0) continue;

    const section = document.createElement("section");
    const heading = document.createElement("h3");
    const headingId = `tuning-category-${category.id}`;
    heading.id = headingId;
    heading.className = "tuning-category";
    heading.textContent = category.label;
    section.setAttribute("role", "group");
    section.setAttribute("aria-labelledby", headingId);
    section.append(heading);

    for (const tuning of tunings) {
      const option = document.createElement("button");
      const label = document.createElement("span");
      const check = document.createElement("span");
      option.type = "button";
      option.className = "tuning-option";
      option.dataset.tuningId = tuning.id;
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", "false");
      label.textContent = tuning.name;
      check.className = "tuning-check";
      check.setAttribute("aria-hidden", "true");
      option.append(label, check);
      section.append(option);
    }

    fragment.append(section);
  }

  elements.tuningList.replaceChildren(fragment);
}

function updateTuningPickerSelection() {
  for (const option of elements.tuningList.querySelectorAll(".tuning-option")) {
    const selected = option.dataset.tuningId === currentTuning.id;
    option.setAttribute("aria-checked", String(selected));
    option.querySelector(".tuning-check").textContent = selected ? "✓" : "";
  }
}

function openTuningDialog() {
  closeSettingsSheet();
  updateTuningPickerSelection();
  elements.tuningButton.setAttribute("aria-expanded", "true");
  if (typeof elements.tuningDialog.showModal === "function") {
    elements.tuningDialog.showModal();
  } else {
    elements.tuningDialog.setAttribute("open", "");
  }
}

function closeTuningDialog() {
  elements.tuningButton.setAttribute("aria-expanded", "false");
  if (!elements.tuningDialog.open) return;
  if (typeof elements.tuningDialog.close === "function") {
    elements.tuningDialog.close();
  } else {
    elements.tuningDialog.removeAttribute("open");
  }
}

function openSettingsSheet() {
  closeTuningDialog();
  syncSettingsUI();
  elements.settingsOpen.setAttribute("aria-expanded", "true");
  if (typeof elements.settingsSheet.showModal === "function") {
    elements.settingsSheet.showModal();
  } else {
    elements.settingsSheet.setAttribute("open", "");
  }
  elements.settingsClose.focus();
}

function closeSettingsSheet() {
  elements.settingsOpen.setAttribute("aria-expanded", "false");
  if (!elements.settingsSheet.open) return;
  if (typeof elements.settingsSheet.close === "function") {
    elements.settingsSheet.close();
  } else {
    elements.settingsSheet.removeAttribute("open");
    elements.settingsOpen.focus();
  }
}

function syncSettingsUI() {
  elements.headstockThreeThree.setAttribute(
    "aria-pressed",
    String(headstockType === "three-three"),
  );
  elements.headstockSixInline.setAttribute(
    "aria-pressed",
    String(headstockType === "six-inline"),
  );
  elements.leftyToggle.setAttribute("aria-checked", String(leftHanded));
  elements.leftyValue.textContent = leftHanded ? "オン" : "オフ";
  elements.soundToggle.setAttribute("aria-checked", String(soundEnabled));
  elements.soundValue.textContent = soundEnabled ? "オン" : "オフ";
  elements.hzValue.textContent = `${concertAHz} Hz`;
  elements.hzDown.disabled = concertAHz <= CONFIG.concertAMin;
  elements.hzUp.disabled = concertAHz >= CONFIG.concertAMax;
}

function setHeadstockType(type) {
  if (!Object.hasOwn(HEADSTOCK_TYPES, type) || type === headstockType) return;
  headstockType = type;
  renderHeadstock();
  syncSettingsUI();
  saveSettings();
}

function setConcertA(hz) {
  if (!Number.isFinite(hz)) return;
  const stepped = Math.round(hz / CONFIG.concertAStep) * CONFIG.concertAStep;
  const nextHz = clamp(stepped, CONFIG.concertAMin, CONFIG.concertAMax);
  if (nextHz === concertAHz) {
    syncSettingsUI();
    return;
  }

  concertAHz = nextHz;
  rebuildTargets();
  previousMidi = null;
  smoothedCents = null;
  lastDisplayAt = null;
  resetChime();
  syncSettingsUI();
  saveSettings();
}

function rebuildTargets() {
  targetsHz = targetsMidi.map(midiToHz);
}

function mirrorX(x, width = 220) {
  return leftHanded ? width - x : x;
}

function renderHeadstockLayout() {
  const type = HEADSTOCK_TYPES[headstockType];
  elements.headstock.dataset.type = headstockType;
  elements.headstock.dataset.leftHanded = String(leftHanded);
  if (elements.headstockImage.getAttribute("src") !== type.image) {
    elements.headstockImage.setAttribute("src", type.image);
  }

  for (const peg of elements.headstock.querySelectorAll(".peg")) {
    const index = Number(peg.dataset.i);
    const layout = type.pegLayout[index];
    if (!layout) continue;
    peg.style.left = `${mirrorX(layout.x, 100)}%`;
    peg.style.top = `${layout.y}%`;
    peg.dataset.side = leftHanded
      ? layout.side === "left" ? "right" : "left"
      : layout.side;
  }

  for (const stringLine of elements.headstock.querySelectorAll(".string-line")) {
    const index = Number(stringLine.dataset.i);
    const points = type.stringLayout[index];
    if (!points) continue;
    const path = points.map(([x, y], pointIndex) => {
      const command = pointIndex === 0 ? "M" : "L";
      return `${command}${mirrorX(x, HEADSTOCK_VIEWBOX_WIDTH)} ${y}`;
    }).join(" ");
    stringLine.setAttribute("d", path);
  }

  elements.headstock.setAttribute(
    "aria-label",
    `${leftHanded ? "左手用・" : ""}${type.label}・6弦ヘッドストック`,
  );
}

function renderHeadstock() {
  renderHeadstockLayout();
  const chromatic = currentTuning.notes === null;
  const active = chromatic ? -1 : activeString();

  for (const peg of elements.headstock.querySelectorAll(".peg")) {
    const index = Number(peg.dataset.i);
    const stringNumber = 6 - index;
    const note = currentTuning.notes?.[index] ?? "—";
    const isActive = index === active;
    const isManual = index === manualString;
    const label = peg.querySelector(".peg-label");

    label.textContent = note;
    peg.classList.toggle("is-active", isActive);
    peg.classList.toggle("is-manual", isManual);
    peg.setAttribute("aria-disabled", String(chromatic));
    peg.setAttribute("aria-pressed", String(isManual));
    peg.setAttribute("tabindex", chromatic ? "-1" : "0");
    peg.setAttribute(
      "aria-label",
      chromatic
        ? `${stringNumber}弦、クロマチックでは手動選択できません`
        : isManual
          ? `${stringNumber}弦 ${note} の手動選択を解除`
          : `${stringNumber}弦 ${note} を手動選択`,
    );
  }

  for (const stringLine of elements.headstock.querySelectorAll(".string-line")) {
    stringLine.classList.toggle("is-active", Number(stringLine.dataset.i) === active);
  }
}

function analyzePitch(hz) {
  const semitonesFromA4 = 12 * Math.log2(hz / concertAHz);
  const midi = Math.round(CONFIG.midiA4 + semitonesFromA4);
  const targetHz = concertAHz * 2 ** ((midi - CONFIG.midiA4) / 12);
  const cents = 1200 * Math.log2(hz / targetHz);
  return { midi, cents };
}

function calculateRms(buffer) {
  let sumSquares = 0;
  for (const sample of buffer) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / buffer.length);
}

function isPitchTracking(now) {
  return lastDetectedAt !== null && now - lastDetectedAt <= CONFIG.trackingReleaseMs;
}

function getSignalGateRms(tracking) {
  const minimum = tracking ? CONFIG.rmsReleaseMin : CONFIG.rmsAcquireMin;
  const multiplier = tracking
    ? CONFIG.noiseFloorReleaseMultiplier
    : CONFIG.noiseFloorAcquireMultiplier;
  return Math.max(minimum, noiseFloorRms * multiplier);
}

function updateNoiseFloor(rms, now, tracking, force = false) {
  if (!Number.isFinite(rms) || tracking) return;

  const acquireGate = Math.max(
    CONFIG.rmsAcquireMin,
    noiseFloorRms * CONFIG.noiseFloorAcquireMultiplier,
  );
  if (!force && rms > acquireGate) return;

  const previousAt = lastNoiseFloorAt;
  lastNoiseFloorAt = now;
  const deltaMs = previousAt === null ? 16 : Math.max(0, now - previousAt);
  const tauMs =
    force
      ? CONFIG.noiseCalibrationTauMs
      : rms < noiseFloorRms
        ? CONFIG.noiseFloorFallTauMs
        : CONFIG.noiseFloorRiseTauMs;
  const alpha = 1 - Math.exp(-deltaMs / tauMs);
  noiseFloorRms = clamp(
    alpha * rms + (1 - alpha) * noiseFloorRms,
    CONFIG.noiseFloorMin,
    CONFIG.noiseFloorMax,
  );
}

function confirmPitchCapture(hz, now) {
  if (!captureCandidate.push(hz, now)) return false;
  resetCaptureCandidate();
  return true;
}

function resetCaptureCandidate() {
  captureCandidate.reset();
}

function confirmTrackedPitch(hz, now) {
  if (
    lastStableHz === null ||
    Math.abs(centsBetween(hz, lastStableHz)) <= CONFIG.jumpRejectCents
  ) {
    resetJumpCandidate();
    return true;
  }

  if (!jumpCandidate.push(hz, now)) return false;
  clearPitchHistory({ clearStableValue: true });
  resetJumpCandidate();
  resetTuneStability();
  return true;
}

function resetJumpCandidate() {
  jumpCandidate.reset();
}

function getResolvedPitchKey(hz) {
  if (currentTuning.notes === null) return `midi:${analyzePitch(hz).midi}`;
  return `string:${activeString()}`;
}

function pushJitterSample(history, now, hz) {
  history.push({ t: now, hz });
  const cutoff = now - CONFIG.jitterWindowMs;
  while (history.length > 0 && history[0].t < cutoff) history.shift();
}

function jitterCents(history) {
  if (history.length < CONFIG.jitterMinSamples) return null;
  const values = history.map((sample) => sample.hz);
  const meanHz = values.reduce((sum, hz) => sum + hz, 0) / values.length;
  const cents = values.map((hz) => 1200 * Math.log2(hz / meanHz));
  const meanCents = cents.reduce((sum, value) => sum + value, 0) / cents.length;
  const variance =
    cents.reduce((sum, value) => sum + (value - meanCents) ** 2, 0) / cents.length;
  return Math.sqrt(variance);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatCents(cents) {
  const rounded = Math.round(cents);
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  if (normalized < 0) return `−${Math.abs(normalized)}¢`;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized}¢`;
}

function setMeterRangeAttributes() {
  elements.pitchMeter.setAttribute("aria-valuemin", String(-CONFIG.meterRangeCents));
  elements.pitchMeter.setAttribute("aria-valuemax", String(CONFIG.meterRangeCents));
}

function setButtonPending(pending) {
  elements.micButton.disabled = pending;
  elements.micButton.setAttribute("aria-busy", String(pending));
  if (pending) elements.micButton.textContent = "待機中…";
}

function setButtonActive(active) {
  elements.micButton.disabled = false;
  elements.micButton.removeAttribute("aria-busy");
  elements.micButton.setAttribute("aria-pressed", String(active));
  elements.micButton.textContent = active ? "チューニング停止" : "チューニング開始";
}

function setError(message) {
  elements.errorMessage.textContent = message;
}

function isMicrophoneEnvironmentSupported(AudioContextClass) {
  if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    setError("HTTPSまたはlocalhostで開いてください");
    return false;
  }

  if (!AudioContextClass || !navigator.mediaDevices?.getUserMedia) {
    setError("このブラウザはマイク入力に対応していません");
    return false;
  }

  return true;
}

function showInitialEnvironmentError() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    setError("HTTPSまたはlocalhostで開いてください");
  } else if (!AudioContextClass || !navigator.mediaDevices?.getUserMedia) {
    setError("このブラウザはマイク入力に対応していません");
  }
}

function getMicrophoneErrorMessage(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "マイクの使用を許可してください";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "マイクが見つかりません";
  }
  return "マイクを使用できません。もう一度お試しください";
}

async function resumeAudioContext(context) {
  if (context.state === "running") return;

  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error("AudioContext resume timed out"));
    }, CONFIG.resumeTimeoutMs);
  });

  try {
    await Promise.race([context.resume(), timeout]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }

  if (context.state !== "running") {
    throw new Error(`AudioContext did not resume: ${context.state}`);
  }
}

function updateDebugPanel(values = {}) {
  if (!DEBUG_ENABLED) return;

  const rawHz = values.rawHz;
  const clarity = values.clarity;
  const rms = values.rms ?? lastMeasuredRms;
  const signalGateRms = values.signalGateRms ?? lastSignalGateRms;
  const correction = values.correction ?? lastPitchCorrection;
  const stableHz = values.stableHz ?? lastStableHz;
  const midi = values.midi ?? previousMidi;
  const cents = values.cents ?? smoothedCents;
  const sampleRate = audioContext?.sampleRate;
  const lag =
    Number.isFinite(sampleRate) && Number.isFinite(stableHz) && stableHz > 0
      ? sampleRate / stableHz
      : null;
  const centsPerSample = Number.isFinite(lag) && lag > 0 ? 1731 / lag : null;
  const sigmaRaw = jitterCents(rawHzHistory);
  const sigmaStable = jitterCents(stableHzHistory);
  const inputSettings = mediaStream?.getAudioTracks()[0]?.getSettings?.() ?? {};

  if (Object.hasOwn(values, "rawHz")) {
    elements.debugRaw.textContent = Number.isFinite(rawHz) ? rawHz.toFixed(2) : "—";
  }
  if (Object.hasOwn(values, "clarity")) {
    elements.debugClarity.textContent = Number.isFinite(clarity) ? clarity.toFixed(3) : "—";
  }
  elements.debugRms.textContent = Number.isFinite(rms) ? rms.toFixed(4) : "—";
  elements.debugGate.textContent = Number.isFinite(signalGateRms)
    ? signalGateRms.toFixed(4)
    : "—";
  elements.debugCorrection.textContent = correction;
  elements.debugInput.textContent = [
    `EC:${formatDebugSwitch(inputSettings.echoCancellation)}`,
    `NS:${formatDebugSwitch(inputSettings.noiseSuppression)}`,
    `AGC:${formatDebugSwitch(inputSettings.autoGainControl)}`,
  ].join(" ");
  if (Object.hasOwn(values, "stableHz")) {
    elements.debugStable.textContent = Number.isFinite(stableHz) ? stableHz.toFixed(2) : "—";
  }
  elements.debugMidi.textContent = Number.isFinite(midi) ? String(midi) : "—";
  elements.debugCents.textContent = Number.isFinite(cents) ? cents.toFixed(1) : "—";
  elements.debugContext.textContent = audioContext?.state ?? "none";
  elements.debugSigmaRaw.textContent = Number.isFinite(sigmaRaw)
    ? `${sigmaRaw.toFixed(2)}¢`
    : "—";
  elements.debugSigmaStable.textContent = Number.isFinite(sigmaStable)
    ? `${sigmaStable.toFixed(2)}¢`
    : "—";
  elements.debugLag.textContent = Number.isFinite(lag) ? `${lag.toFixed(1)} smp` : "—";
  elements.debugCentsPerSample.textContent = Number.isFinite(centsPerSample)
    ? centsPerSample.toFixed(2)
    : "—";
  elements.debugSampleRate.textContent = Number.isFinite(sampleRate)
    ? String(sampleRate)
    : "—";
}

function formatDebugSwitch(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return "?";
}
