import {
  centsBetween,
  GuitarPitchAnalyzer,
  nearestStringIndex,
  PitchTracker,
  PITCH_TRACKER_STATES,
} from "./pitch-processing.js";
import { CATEGORIES, TUNINGS } from "./tunings.js";

const CONFIG = {
  // Clarity gates are deliberately permissive: on a phone microphone in a
  // normal room the NSDF peak of a real string often sits between 0.6 and
  // 0.9, and the tracker's stability clustering rejects unstable input.
  clarityAcquireMin: 0.8,
  clarityTrackMin: 0.5,
  rmsAcquireMin: 0.0002,
  rmsTrackMin: 0.0001,
  acquireMinMs: 30,
  acquireMinSamples: 2,
  acquireStabilityCents: 45,
  candidateMaxGapMs: 90,
  trackMedianWindow: 3,
  // Per-frame step limit while tracking. Real vibrato and bends move well
  // under 40 cents per animation frame; a fast string change sweeps the
  // analysis window at 100+ cents per frame and must register as a switch
  // (which re-runs string selection), not as an in-note glide.
  trackMaxStepCents: 70,
  switchMinMs: 30,
  switchMinSamples: 2,
  switchStabilityCents: 55,
  switchCandidateMaxGapMs: 90,
  octaveSwitchMinSamples: 3,
  octaveSwitchMinMs: 220,
  octaveToleranceCents: 120,
  releaseMs: 220,
  // A confirmed switch reports the switch cluster's median, which can lag a
  // fast pitch change by 10-20 cents and land a boundary case on the wrong
  // side of the sticky margin. String selection therefore also re-evaluates
  // on the next few accepted frames, where the tracked value has settled —
  // but no longer, so a subsequent in-note glide stays locked to its string.
  reselectFrames: 3,
  displayHoldMs: 1500,
  // Display smoothing. A plucked string physically starts up to ~15 cents
  // sharp and glides down to its true pitch over a second or more — measured
  // on the player's own low E. That glide is a real, sustained pitch movement,
  // indistinguishable in rate from a peg turn, so a motion-adaptive (One-Euro
  // beta > 0) filter chases it and the reading visibly climbs then falls on
  // every pluck. beta is therefore 0: a plain low-pass that smooths the glide
  // away, showing a steady value that eases gently to the settled pitch. The
  // cost is that a fast peg turn lags by a few hundred ms, which is
  // acceptable while tuning; the previous jump/jitter was not.
  oneEuroMinCutoffHz: 0.1,
  oneEuroBeta: 0,
  oneEuroDerivativeCutoffHz: 0.3,
  // The bubble eases toward its target with a per-frame speed ceiling, so it
  // always travels smoothly and can never lurch across the lane in one frame.
  bubbleEaseTauSec: 0.11,
  bubbleMaxSpeedPerSec: 1.4,
  // Bridge brief fine-measurement dropouts so the display does not fall back
  // to the jittery frame-by-frame value for a few frames.
  refinedHoldMs: 250,
  jitterWindowMs: 1000,
  jitterMinSamples: 8,
  inTuneCents: 5,
  // The green state enters and leaves at different thresholds so measurement
  // jitter at the boundary cannot strobe the display.
  tunedEnterCents: 4,
  tunedExitCents: 7,
  nearTuneCents: 15,
  // A fresh or badly slipped string sits 100-200 cents off; the needle must
  // keep moving through that whole approach or winding feels like nothing is
  // happening.
  meterRangeCents: 200,
  // The inner +-10 cents get half the dial, mapped linearly: linear mapping
  // keeps jitter magnification constant (a square-root scale has unbounded
  // gain at zero and makes even a +-1 cent wobble look violent).
  meterLinearCents: 10,
  // 62 keeps 60 Hz mains hum outside the pitch range while every listed
  // tuning's lowest string (C2 = 65.4 Hz) stays detectable down to -80 cents.
  minPitchHz: 62,
  maxPitchHz: 1200,
  highpassHz: 35,
  lowpassHz: 1500,
  // Mains hum (50 Hz east Japan / 60 Hz west Japan) and its strong partials
  // sit inside the low-string analysis band and can out-correlate a decaying
  // string, silencing the low E entirely. Q=35 notches are narrow enough to
  // leave every open-string fundamental within 2 dB.
  humNotchHz: [50, 60, 100, 120, 150, 180],
  humNotchQ: 35,
  fftSize: 2048,
  // Fine-measurement stage: once the tracker holds a note, the displayed
  // cents come from an NSDF pitch estimate over this long window (341 ms at
  // 48 kHz). Measured on a real low-E phone recording, the long window drops
  // the within-note reading jitter from several cents to well under one,
  // where the short frame-by-frame estimate wandered badly. Using the SAME
  // NSDF method as the coarse tracker also removes the coarse/fine
  // disagreement that used to make the reading jump.
  // Chromatic note-name hysteresis: a note is held until the pitch moves this
  // far past the semitone boundary, so a pitch sitting on the boundary does
  // not flicker between two note names.
  chromaticHysteresisCents: 15,
  refineFftSize: 8192,
  refineMaxOffsetCents: 60,
  concertAHz: 440,
  concertAMin: 415,
  concertAMax: 466,
  concertAStep: 1,
  chimeGain: 0.045,
  chimeHoldMs: 240,
  chimeRefractoryMs: 800,
  chimeReleaseCents: 12.5,
  chimeBlankingMs: 500,
  midiA4: 69,
  stringMatchMaxCents: 600,
  // Hysteresis for auto string selection: another target must be this much
  // closer before the peg moves. It only needs to beat measurement jitter
  // (±10 cents); adjacent strings are 400+ cents apart, and the measured
  // value can sit 15-25 cents shy of its settled pitch right after a fast
  // change, so a large margin would eat real string changes near midpoints.
  stickyMarginCents: 55,
  mutedTrackFallbackMs: 500,
  resumeTimeoutMs: 5000,
};

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
  laneY: 104,
  halfSpanX: 118,
  // Ticks at these cents; positions follow the piecewise scale, so the
  // in-tune band (±5¢) occupies a quarter of each half-lane.
  ticks: [
    { cents: 10, rank: "medium" },
    { cents: 50, rank: "medium" },
    { cents: 200, rank: "major" },
  ],
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
  gaugeTicks: document.querySelector("#gaugeTicks"),
  gaugeLane: document.querySelector("#gaugeLane"),
  gaugeZoneFine: document.querySelector("#gaugeZoneFine"),
  gaugeNotch: document.querySelector("#gaugeNotch"),
  gaugeBubble: document.querySelector("#gaugeBubble"),
  gaugeBubbleCircle: document.querySelector("#gaugeBubbleCircle"),
  gaugeNote: document.querySelector("#gaugeNote"),
  gaugeOctave: document.querySelector("#gaugeOctave"),
  gaugeCents: document.querySelector("#gaugeCents"),
  gaugeHintUp: document.querySelector("#gaugeHintUp"),
  gaugeHintDown: document.querySelector("#gaugeHintDown"),
  gaugeHintCheck: document.querySelector("#gaugeHintCheck"),
  tuneStatus: document.querySelector("#tuneStatus"),
  pitchMeter: document.querySelector("#pitchMeter"),
  micButton: document.querySelector("#micButton"),
  errorMessage: document.querySelector("#errorMessage"),
  debugPanel: document.querySelector("#debugPanel"),
  debugCapture: document.querySelector("#debugCapture"),
  debugRaw: document.querySelector("#debugRaw"),
  debugClarity: document.querySelector("#debugClarity"),
  debugRms: document.querySelector("#debugRms"),
  debugCorrection: document.querySelector("#debugCorrection"),
  debugTracker: document.querySelector("#debugTracker"),
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
let notchNodes = [];
let lowpassNode = null;
let analyserNode = null;
let refineAnalyserNode = null;
let muteGainNode = null;
let waveformBuffer = null;
let refineBuffer = null;
let animationFrameId = null;
let microphoneActive = false;
let microphonePending = false;
let microphoneStartedAt = -Infinity;
let lifecycleGeneration = 0;
let trackEndedHandler = null;

const rawHzHistory = [];
const stableHzHistory = [];
let previousMidi = null;
let chromaticHeldMidi = null;
let smoothedCents = null;
let lastDisplayAt = null;
let filterPrevCents = null;
let filterPrevSpeed = 0;
let filterPrevAt = null;
let displayedCentsInt = null;
let bubbleTargetPosition = null;
let bubblePosition = null;
let bubbleAnimatedAt = null;
let lastRefinedHz = Number.NaN;
let lastRefinedAt = -Infinity;
let displayTuned = false;
let lastStableHz = null;
let lastMeasuredRms = Number.NaN;
let lastPitchCorrection = "—";
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
let inTuneSince = null;
let lastChimeAt = -Infinity;
let analysisBlankedUntil = -Infinity;
let displayHoldUntil = null;
let reselectFramesLeft = 0;
const activeChimeVoices = new Set();
let activeChimeMaster = null;

const pitchAnalyzer = new GuitarPitchAnalyzer(CONFIG.fftSize, {
  minHz: CONFIG.minPitchHz,
  maxHz: CONFIG.maxPitchHz,
});

const fineAnalyzer = new GuitarPitchAnalyzer(CONFIG.refineFftSize, {
  minHz: CONFIG.minPitchHz,
  maxHz: CONFIG.maxPitchHz,
});

const pitchTracker = new PitchTracker({
  acquireClarityMin: CONFIG.clarityAcquireMin,
  trackClarityMin: CONFIG.clarityTrackMin,
  acquireMinMs: CONFIG.acquireMinMs,
  acquireMinSamples: CONFIG.acquireMinSamples,
  acquireStabilityCents: CONFIG.acquireStabilityCents,
  candidateMaxGapMs: CONFIG.candidateMaxGapMs,
  medianWindow: CONFIG.trackMedianWindow,
  maxStepCents: CONFIG.trackMaxStepCents,
  switchMinMs: CONFIG.switchMinMs,
  switchMinSamples: CONFIG.switchMinSamples,
  switchStabilityCents: CONFIG.switchStabilityCents,
  switchCandidateMaxGapMs: CONFIG.switchCandidateMaxGapMs,
  octaveSwitchMinSamples: CONFIG.octaveSwitchMinSamples,
  octaveSwitchMs: CONFIG.octaveSwitchMinMs,
  octaveToleranceCents: CONFIG.octaveToleranceCents,
  releaseMs: CONFIG.releaseMs,
});

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

elements.debugCapture.addEventListener("click", startDiagnosticCapture);

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
    // A partially confirmed jump must not survive an arbitrary background gap.
    resetDetectionData();
    resetDisplay();
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
  let nextNotches = [];
  let nextLowpass = null;
  let nextAnalyser = null;
  let nextRefineAnalyser = null;
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

    nextNotches = CONFIG.humNotchHz.map((notchHz) => {
      const notch = nextContext.createBiquadFilter();
      notch.type = "notch";
      notch.frequency.value = notchHz;
      notch.Q.value = CONFIG.humNotchQ;
      return notch;
    });

    nextLowpass = nextContext.createBiquadFilter();
    nextLowpass.type = "lowpass";
    nextLowpass.frequency.value = CONFIG.lowpassHz;

    nextAnalyser = nextContext.createAnalyser();
    nextAnalyser.fftSize = CONFIG.fftSize;
    nextAnalyser.smoothingTimeConstant = 0;

    nextRefineAnalyser = nextContext.createAnalyser();
    nextRefineAnalyser.fftSize = CONFIG.refineFftSize;
    nextRefineAnalyser.smoothingTimeConstant = 0;

    nextMuteGain = nextContext.createGain();
    nextMuteGain.gain.value = 0;

    nextSource.connect(nextHighpass);
    let previousNode = nextHighpass;
    for (const notch of nextNotches) {
      previousNode.connect(notch);
      previousNode = notch;
    }
    previousNode.connect(nextLowpass);
    nextLowpass.connect(nextAnalyser);
    nextLowpass.connect(nextRefineAnalyser);
    nextAnalyser.connect(nextMuteGain);
    nextMuteGain.connect(nextContext.destination);

    const nextBuffer = new Float32Array(CONFIG.fftSize);
    const nextRefineBuffer = new Float32Array(CONFIG.refineFftSize);

    // The permission sheet can suspend AudioContext on iOS, so resume again here.
    await resumeAudioContext(nextContext);

    if (generation !== lifecycleGeneration) {
      await releaseAudioResources({
        context: nextContext,
        stream: nextStream,
        nodes: [nextSource, nextHighpass, ...nextNotches, nextLowpass, nextAnalyser, nextRefineAnalyser, nextMuteGain],
      });
      return;
    }

    audioContext = nextContext;
    mediaStream = nextStream;
    sourceNode = nextSource;
    highpassNode = nextHighpass;
    notchNodes = nextNotches;
    lowpassNode = nextLowpass;
    analyserNode = nextAnalyser;
    refineAnalyserNode = nextRefineAnalyser;
    muteGainNode = nextMuteGain;
    waveformBuffer = nextBuffer;
    refineBuffer = nextRefineBuffer;
    microphoneActive = true;
    microphonePending = false;
    microphoneStartedAt = performance.now();

    const inputTrack = mediaStream.getAudioTracks()[0];
    trackEndedHandler = () => {
      if (!microphoneActive || generation !== lifecycleGeneration) return;
      stopMicrophone();
      setError("マイク入力が停止しました。もう一度開始してください");
    };
    inputTrack?.addEventListener("ended", trackEndedHandler, { once: true });

    resetChime();
    resetDetectionData();
    resetDisplay();
    setButtonActive(true);
    updateDebugPanel();
    scheduleAnalysisFrame();
  } catch (error) {
    await releaseAudioResources({
      context: nextContext,
      stream: nextStream,
      nodes: [nextSource, nextHighpass, ...nextNotches, nextLowpass, nextAnalyser, nextRefineAnalyser, nextMuteGain],
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
  microphoneStartedAt = -Infinity;
  cancelAnalysisLoop();

  const resources = {
    context: audioContext,
    stream: mediaStream,
    nodes: [sourceNode, highpassNode, ...notchNodes, lowpassNode, analyserNode, refineAnalyserNode, muteGainNode],
    endedHandler: trackEndedHandler,
  };

  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  highpassNode = null;
  notchNodes = [];
  lowpassNode = null;
  analyserNode = null;
  refineAnalyserNode = null;
  muteGainNode = null;
  waveformBuffer = null;
  refineBuffer = null;
  trackEndedHandler = null;

  resetChime();
  resetDetectionData();
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
    const inputBlanked = now < analysisBlankedUntil;
    elements.tunerMain.dataset.inputBlanked = String(inputBlanked);

    // The completion sound is intentionally audible through the phone speaker.
    // Freeze analysis while it and its short acoustic tail can feed the mic.
    if (inputBlanked) {
      updateDebugPanel({
        rawHz: Number.NaN,
        clarity: Number.NaN,
        stableHz: lastStableHz,
        correction: "待避",
        trackerEvent: "chime-blank",
      });
      return;
    }

    // Some Android devices keep the muted flag set after permission; never let
    // that advisory flag block an otherwise live stream indefinitely.
    const inputReady =
      audioContext?.state === "running" &&
      analyserNode &&
      waveformBuffer &&
      track?.readyState === "live" &&
      (!track.muted || now - microphoneStartedAt >= CONFIG.mutedTrackFallbackMs);

    if (!inputReady) {
      processTrackerFrame(now, {
        rawHz: Number.NaN,
        clarity: Number.NaN,
        rms: Number.NaN,
        folded: false,
      });
      return;
    }

    analyserNode.getFloatTimeDomainData(waveformBuffer);
    const rms = calculateRms(waveformBuffer);
    lastMeasuredRms = rms;

    // While a note is tracked, tell the analyzer so decaying input holds the
    // tracked pitch instead of sliding onto a stronger subharmonic maximum.
    const referenceHz =
      pitchTracker.state === PITCH_TRACKER_STATES.TRACKING ||
      pitchTracker.state === PITCH_TRACKER_STATES.RELEASE
        ? pitchTracker.valueHz
        : null;
    const { hz: rawHz, clarity, folded } = pitchAnalyzer.analyze(
      waveformBuffer,
      audioContext.sampleRate,
      { referenceHz },
    );

    // Fine measurement over the long window, anchored on the tracked pitch.
    let refinedHz = Number.NaN;
    if (referenceHz !== null && refineAnalyserNode && refineBuffer) {
      refineAnalyserNode.getFloatTimeDomainData(refineBuffer);
      refinedHz = fineAnalyzer.analyze(
        refineBuffer,
        audioContext.sampleRate,
        { referenceHz },
      ).hz;
      if (Number.isFinite(refinedHz)) {
        lastRefinedHz = refinedHz;
        lastRefinedAt = now;
      } else if (now - lastRefinedAt <= CONFIG.refinedHoldMs) {
        refinedHz = lastRefinedHz;
      }
    }

    processTrackerFrame(now, { rawHz, clarity, rms, folded, refinedHz });
  } catch {
    processTrackerFrame(now, {
      rawHz: Number.NaN,
      clarity: Number.NaN,
      rms: Number.NaN,
      folded: false,
    });
  } finally {
    animateBubble(now);
    // Invalid or temporarily unavailable input must never kill the active loop.
    scheduleAnalysisFrame();
  }
}

function processTrackerFrame(now, { rawHz, clarity, rms, folded = false, refinedHz = Number.NaN }) {
  const rawInRange =
    Number.isFinite(rawHz) &&
    rawHz >= CONFIG.minPitchHz &&
    rawHz <= CONFIG.maxPitchHz;
  const trackingExistingPitch =
    pitchTracker.state === PITCH_TRACKER_STATES.TRACKING ||
    pitchTracker.state === PITCH_TRACKER_STATES.RELEASE;
  const rmsMin = trackingExistingPitch ? CONFIG.rmsTrackMin : CONFIG.rmsAcquireMin;
  const signalUsable = rawInRange && Number.isFinite(rms) && rms >= rmsMin;

  if (rawInRange) pushJitterSample(rawHzHistory, now, rawHz);

  const result = pitchTracker.update({
    hz: signalUsable ? rawHz : Number.NaN,
    clarity: signalUsable ? clarity : Number.NaN,
    nowMs: now,
  });
  syncTrackerState(result);

  if (result.accepted && Number.isFinite(result.valueHz)) {
    const stableHz = result.valueHz;
    const reselectString = result.event === "acquired" || result.event === "switched";
    // A fresh acquisition after silence is a new note: the sticky bias that
    // protects a bent note mid-tracking must not carry over from before the
    // release, or a detuned string could keep the previous peg lit.
    if (result.event === "acquired") autoString = -1;
    displayHoldUntil = null;
    pushJitterSample(stableHzHistory, now, stableHz);
    lastStableHz = stableHz;
    lastPitchCorrection = folded ? "½↓" : "×1";
    // Select only when the tracker confirms a new cluster. A bend or drift in
    // one sustained note must not silently move the UI to another string.
    updateDisplay(stableHz, now, { reselectString, refinedHz });
  } else if (result.event === "released") {
    // Keep the last reading visible but dimmed for a short while: a plucked
    // string fading out should not blank the tuner the player is reading.
    chimeArmed = true;
    inTuneSince = null;
    displayHoldUntil = now + CONFIG.displayHoldMs;
    dimDisplay();
  } else if (result.state === PITCH_TRACKER_STATES.RELEASE) {
    // Transient release episodes (clarity dipping for a few frames) keep the
    // display fully lit; dimming only starts once the note actually ends.
    // Flashing the whole gauge at the clarity boundary read as flutter.
    inTuneSince = null;
  } else if (result.event === "switch-pending") {
    // Hold the last trustworthy value while a new, distant cluster is checked.
    inTuneSince = null;
  }

  // CANDIDATE counts as expired too: noisy input can bounce between IDLE and
  // CANDIDATE indefinitely without ever acquiring, and the held reading must
  // still clear. Anything acquired resets displayHoldUntil above.
  if (
    displayHoldUntil !== null &&
    (result.state === PITCH_TRACKER_STATES.IDLE ||
      result.state === PITCH_TRACKER_STATES.CANDIDATE) &&
    now >= displayHoldUntil
  ) {
    displayHoldUntil = null;
    autoString = -1;
    resetDisplay();
  }

  if (diagnosticCapture) {
    diagnosticCapture.frames.push({
      t: Math.round(now),
      raw: Number.isFinite(rawHz) ? Number(rawHz.toFixed(2)) : null,
      cl: Number.isFinite(clarity) ? Number(clarity.toFixed(3)) : null,
      rms: Number.isFinite(rms) ? Number(rms.toFixed(5)) : null,
      fine: Number.isFinite(refinedHz) ? Number(refinedHz.toFixed(3)) : null,
      stable: Number.isFinite(result.valueHz) ? Number(result.valueHz.toFixed(2)) : null,
      st: result.state,
      ev: result.event,
    });
  }

  updateDebugPanel({
    rawHz,
    clarity,
    stableHz: lastStableHz,
    rms,
    correction: lastPitchCorrection,
    trackerEvent: result.event,
  });
}

// The display path is deliberately a single straight line: pick the note the
// tracker is on, measure its cents ONCE (fine value when it agrees with the
// tracker, else the tracker's own), run it through ONE adaptive filter, and
// draw it with a hard speed ceiling. No coarse/fine switching, no motion
// classifier, no per-frame discard — those interacting layers were the source
// of the sudden jumps. The filter is reset only on a real note change; a hard
// attack is handled by the filter's own inertia plus the speed clamp, not by
// blanking.
function updateDisplay(stableHz, now, { reselectString = false, refinedHz = Number.NaN } = {}) {
  const fineValid =
    Number.isFinite(refinedHz) &&
    Math.abs(centsBetween(refinedHz, stableHz)) <= CONFIG.refineMaxOffsetCents;
  let midi;
  let targetHz;

  if (currentTuning.notes === null) {
    // Chromatic note selection with hysteresis: a string tuned exactly between
    // two semitones (e.g. 80 Hz, halfway between D#2 and E2) would otherwise
    // flip its note name every frame, teleporting the reading a whole
    // semitone. Keep the note the display is already on until the pitch moves
    // clearly past the boundary into the neighbour.
    const nearestMidi = analyzePitch(stableHz).midi;
    if (
      chromaticHeldMidi === null ||
      Math.abs(centsBetween(stableHz, concertAHz * 2 ** ((chromaticHeldMidi - CONFIG.midiA4) / 12))) >
        50 + CONFIG.chromaticHysteresisCents
    ) {
      chromaticHeldMidi = nearestMidi;
    }
    midi = chromaticHeldMidi;
    targetHz = concertAHz * 2 ** ((midi - CONFIG.midiA4) / 12);
  } else {
    if (reselectString) reselectFramesLeft = CONFIG.reselectFrames;
    if (manualString === null && reselectFramesLeft > 0) {
      reselectFramesLeft -= 1;
      if (updateAutoString(stableHz)) renderHeadstock();
    }

    const stringIndex = activeString();
    if (stringIndex < 0) {
      renderNoTargetDisplay();
      updateDebugPanel({ stableHz, midi: Number.NaN, cents: Number.NaN });
      return;
    }

    midi = targetsMidi[stringIndex];
    targetHz = targetsHz[stringIndex];
  }

  // The fine (long-window) value is preferred whenever it agrees with the
  // tracker; it is steadier at rest. During a fast peg turn the long window
  // lags and disagrees, so the check naturally falls back to the tracker.
  const measuredHz = fineValid ? refinedHz : stableHz;
  const measuredCents = centsBetween(measuredHz, targetHz);

  if (midi !== previousMidi) resetCentsFilter();
  smoothedCents = filterCents(measuredCents, now);
  lastDisplayAt = now;
  previousMidi = midi;

  const noteIndex = ((midi % NOTE_NAMES.length) + NOTE_NAMES.length) % NOTE_NAMES.length;
  const octave = Math.floor(midi / NOTE_NAMES.length) - 1;
  const gaugeCents = clamp(
    smoothedCents,
    -CONFIG.meterRangeCents,
    CONFIG.meterRangeCents,
  );
  const noteName = NOTE_NAMES[noteIndex];
  // The printed number flips only when the value clearly leaves the shown
  // integer; +-1 c wobble across a rounding boundary must not strobe the text.
  if (
    displayedCentsInt === null ||
    Math.abs(smoothedCents - displayedCentsInt) > 0.7
  ) {
    displayedCentsInt = Math.round(smoothedCents);
  }
  const centsText = formatCents(displayedCentsInt);

  // Separate enter/leave thresholds so jitter at the boundary cannot strobe
  // the green state on and off.
  const absCents = Math.abs(smoothedCents);
  if (displayTuned) {
    if (absCents > CONFIG.tunedExitCents) displayTuned = false;
  } else if (absCents <= CONFIG.tunedEnterCents) {
    displayTuned = true;
  }

  updateChime(smoothedCents, now);

  elements.gaugeNote.textContent = noteName;
  elements.gaugeOctave.textContent = String(octave);
  elements.gaugeCents.textContent = displayTuned
    ? "\u2713"
    : formatBubbleCents(displayedCentsInt);
  renderGaugeValue(gaugeCents);
  elements.pitchMeter.setAttribute("aria-valuenow", gaugeCents.toFixed(1));
  elements.pitchMeter.setAttribute(
    "aria-valuetext",
    `${noteName}${octave}、${centsText}`,
  );
  elements.tunerMain.dataset.signal = "active";
  elements.tunerMain.dataset.tuned = String(displayTuned);

  // Wordless guidance: ∧ = raise, ∨ = lower, ✓ = in tune. The dial, colors
  // and needle carry the state; the symbol answers "what do I do".
  const direction = displayTuned ? "tuned" : smoothedCents < 0 ? "flat" : "sharp";
  elements.tunerMain.dataset.direction = direction;
  setHiddenState(elements.gaugeHintUp, direction !== "flat");
  setHiddenState(elements.gaugeHintDown, direction !== "sharp");
  // The bubble itself turns into the green check; a second check on top
  // would be redundant.
  setHiddenState(elements.gaugeHintCheck, true);
  const statusText = displayTuned ? "ぴったり" : direction === "flat" ? "低い（上げる）" : "高い（下げる）";
  if (elements.tuneStatus.textContent !== statusText) {
    elements.tuneStatus.textContent = statusText;
  }

  updateDebugPanel({ stableHz, midi, cents: smoothedCents });
}

function setHiddenState(element, hidden) {
  if (hidden) element.setAttribute("hidden", "");
  else element.removeAttribute("hidden");
}

// One-Euro filter: a low-pass whose cutoff rises with the smoothed speed of
// the signal. At rest the cutoff is oneEuroMinCutoffHz (heavy smoothing, so a
// held note is steady); a sustained pitch change raises the cutoff and passes
// through with little lag. The speed itself is low-passed at
// oneEuroDerivativeCutoffHz so momentary measurement jitter — fast but not
// sustained — does not open the filter and leak through.
function filterCents(cents, nowMs) {
  const nowSec = nowMs / 1000;
  if (filterPrevCents === null || filterPrevAt === null) {
    filterPrevCents = cents;
    filterPrevSpeed = 0;
    filterPrevAt = nowSec;
    return cents;
  }
  const deltaSec = Math.max(1e-3, nowSec - filterPrevAt);
  filterPrevAt = nowSec;

  const rawSpeed = (cents - filterPrevCents) / deltaSec;
  const speedAlpha = lowpassAlpha(CONFIG.oneEuroDerivativeCutoffHz, deltaSec);
  filterPrevSpeed = speedAlpha * rawSpeed + (1 - speedAlpha) * filterPrevSpeed;

  const cutoffHz = CONFIG.oneEuroMinCutoffHz + CONFIG.oneEuroBeta * Math.abs(filterPrevSpeed);
  const alpha = lowpassAlpha(cutoffHz, deltaSec);
  filterPrevCents = alpha * cents + (1 - alpha) * filterPrevCents;
  return filterPrevCents;
}

function lowpassAlpha(cutoffHz, deltaSec) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / deltaSec);
}

function resetCentsFilter() {
  filterPrevCents = null;
  filterPrevSpeed = 0;
  filterPrevAt = null;
}

function numberAscending(left, right) {
  return left - right;
}

function updateChime(cents, now) {
  if (!soundEnabled) {
    chimeArmed = true;
    inTuneSince = null;
    return;
  }

  const absoluteCents = Math.abs(cents);
  // Follow the same hysteresis as the green display state: the chime confirms
  // exactly what the player sees.
  const inTune = displayTuned;
  const refractoryElapsed = now - lastChimeAt >= CONFIG.chimeRefractoryMs;

  if (!inTune) {
    inTuneSince = null;
    // Ignore pitch disturbance caused by the chime itself during the refractory period.
    if (absoluteCents > CONFIG.chimeReleaseCents && refractoryElapsed) {
      chimeArmed = true;
    }
    return;
  }

  if (inTuneSince === null || now < inTuneSince) inTuneSince = now;
  const heldLongEnough = now - inTuneSince >= CONFIG.chimeHoldMs;

  if (chimeArmed && refractoryElapsed && heldLongEnough && playInTuneChime(now)) {
    lastChimeAt = now;
    chimeArmed = false;
  }
}

function playInTuneChime(now) {
  if (!soundEnabled || !audioContext || audioContext.state !== "running") return false;

  stopActiveChime();
  analysisBlankedUntil = Math.max(analysisBlankedUntil, now + CONFIG.chimeBlankingMs);
  elements.tunerMain.dataset.inputBlanked = "true";

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

function resetChime() {
  stopActiveChime();
  chimeArmed = true;
  inTuneSince = null;
  lastChimeAt = -Infinity;
  analysisBlankedUntil = -Infinity;
  elements.tunerMain.dataset.inputBlanked = "false";
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

function dimDisplay() {
  if (elements.tunerMain.dataset.signal !== "empty") {
    elements.tunerMain.dataset.signal = "dim";
  }
}

function resetDisplay() {
  clearPitchHistory({ clearStableValue: true });
  lastPitchCorrection = "—";

  elements.gaugeNote.textContent = "—";
  elements.gaugeOctave.textContent = "";
  elements.gaugeCents.textContent = "—";
  bubbleTargetPosition = null;
  bubblePosition = null;
  elements.gaugeBubble.setAttribute("hidden", "");
  elements.pitchMeter.setAttribute("aria-valuenow", "0");
  elements.pitchMeter.setAttribute("aria-valuetext", "音程未検出");
  elements.tunerMain.dataset.signal = "empty";
  elements.tunerMain.dataset.tuned = "false";
  elements.tunerMain.dataset.direction = "none";
  hideTuneHints();
  if (elements.tuneStatus.textContent) elements.tuneStatus.textContent = "";
  renderHeadstock();
}

function resetDetectionData() {
  const trackerResult = pitchTracker.reset();
  syncTrackerState(trackerResult);
  clearPitchHistory({ clearStableValue: true });
  autoString = -1;
  inTuneSince = null;
  displayHoldUntil = null;
  reselectFramesLeft = 0;
  lastRefinedHz = Number.NaN;
  lastRefinedAt = -Infinity;
  lastPitchCorrection = "—";
  lastMeasuredRms = Number.NaN;
}

function syncTrackerState(result = { state: pitchTracker.state, event: pitchTracker.event }) {
  elements.tunerMain.dataset.trackerState = result.state;
  if (!DEBUG_ENABLED) return;
  elements.debugTracker.textContent = result.event
    ? `${result.state}/${result.event}`
    : result.state;
}

function clearPitchHistory({ clearStableValue }) {
  rawHzHistory.length = 0;
  stableHzHistory.length = 0;
  resetCentsFilter();
  displayedCentsInt = null;
  previousMidi = null;
  chromaticHeldMidi = null;
  smoothedCents = null;
  lastDisplayAt = null;
  displayTuned = false;
  if (clearStableValue) lastStableHz = null;
}

function initializeGauge() {
  const laneLeft = GAUGE.centerX - GAUGE.halfSpanX;
  const laneRight = GAUGE.centerX + GAUGE.halfSpanX;
  elements.gaugeLane.setAttribute("x1", String(laneLeft));
  elements.gaugeLane.setAttribute("x2", String(laneRight));
  elements.gaugeLane.setAttribute("y1", String(GAUGE.laneY));
  elements.gaugeLane.setAttribute("y2", String(GAUGE.laneY));

  // The green zone shows the goal before the bubble reaches it.
  elements.gaugeZoneFine.setAttribute("x1", laneX(-CONFIG.inTuneCents).toFixed(1));
  elements.gaugeZoneFine.setAttribute("x2", laneX(CONFIG.inTuneCents).toFixed(1));
  elements.gaugeZoneFine.setAttribute("y1", String(GAUGE.laneY));
  elements.gaugeZoneFine.setAttribute("y2", String(GAUGE.laneY));

  elements.gaugeNotch.setAttribute("x1", String(GAUGE.centerX));
  elements.gaugeNotch.setAttribute("x2", String(GAUGE.centerX));
  elements.gaugeNotch.setAttribute("y1", String(GAUGE.laneY - 14));
  elements.gaugeNotch.setAttribute("y2", String(GAUGE.laneY + 14));

  const fragment = document.createDocumentFragment();
  for (const { cents, rank } of GAUGE.ticks) {
    for (const sign of [-1, 1]) {
      const x = laneX(sign * cents).toFixed(1);
      const length = rank === "major" ? 7 : 5;
      const tick = document.createElementNS(SVG_NAMESPACE, "line");
      tick.setAttribute("x1", x);
      tick.setAttribute("x2", x);
      tick.setAttribute("y1", String(GAUGE.laneY - length));
      tick.setAttribute("y2", String(GAUGE.laneY + length));
      tick.setAttribute("stroke", "#ffffff");
      tick.setAttribute("stroke-width", "1");
      tick.setAttribute("opacity", rank === "major" ? "0.35" : "0.18");
      fragment.append(tick);
    }
  }

  // ♭/♯ anchors tell which side is which without a single word.
  for (const [sign, symbol] of [[-1, "♭"], [1, "♯"]]) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("x", String(GAUGE.centerX + sign * GAUGE.halfSpanX));
    label.setAttribute("y", String(GAUGE.laneY + 28));
    label.setAttribute("class", "gauge-end-label");
    label.textContent = symbol;
    fragment.append(label);
  }

  elements.gaugeTicks.replaceChildren(fragment);
}

// Piecewise-linear mapping to [-1, 1]: the inner ±meterLinearCents take half
// the lane, the rest is compressed into the outer half. Fine tuning stays
// readable and, unlike a square-root scale, the gain near zero is finite, so
// measurement wobble is not visually magnified where precision matters.
function lanePosition(cents) {
  const absCents = Math.min(Math.abs(cents), CONFIG.meterRangeCents);
  const linear = CONFIG.meterLinearCents;
  return Math.sign(cents) * (
    absCents <= linear
      ? (absCents / linear) * 0.5
      : 0.5 + ((absCents - linear) / (CONFIG.meterRangeCents - linear)) * 0.5
  );
}

function laneX(cents) {
  return GAUGE.centerX + lanePosition(cents) * GAUGE.halfSpanX;
}


function animateBubble(now) {
  if (bubbleTargetPosition === null) {
    if (bubblePosition !== null) {
      bubblePosition = null;
      elements.gaugeBubble.setAttribute("hidden", "");
    }
    bubbleAnimatedAt = now;
    return;
  }
  const deltaSeconds = Math.min(
    0.05,
    Math.max(0, now - (bubbleAnimatedAt ?? now)) / 1000,
  );
  bubbleAnimatedAt = now;
  if (bubblePosition === null) {
    bubblePosition = bubbleTargetPosition;
  } else {
    // Ease toward the target, then hard-clamp the per-frame move to a maximum
    // speed. The clamp is the guarantee the bubble can never lurch across the
    // lane in one frame — a stiff spring let it jump a third of the lane at
    // once, which read as the whole meter "snapping". A bounded speed makes it
    // travel there smoothly instead, matching a commercial tuner's needle.
    const eased =
      (bubbleTargetPosition - bubblePosition) *
      Math.min(1, deltaSeconds / CONFIG.bubbleEaseTauSec);
    const maxStep = CONFIG.bubbleMaxSpeedPerSec * deltaSeconds;
    bubblePosition += clamp(eased, -maxStep, maxStep);
  }
  const x = (GAUGE.centerX + bubblePosition * GAUGE.halfSpanX).toFixed(1);
  elements.gaugeBubble.setAttribute("transform", `translate(${x} ${GAUGE.laneY})`);
  elements.gaugeBubble.removeAttribute("hidden");
}

function renderGaugeValue(cents) {
  bubbleTargetPosition = lanePosition(cents);
}

function renderNoTargetDisplay() {
  previousMidi = null;
  smoothedCents = null;
  lastDisplayAt = null;
  elements.gaugeNote.textContent = "—";
  elements.gaugeOctave.textContent = "";
  elements.gaugeCents.textContent = "—";
  displayedCentsInt = null;
  bubbleTargetPosition = null;
  bubblePosition = null;
  elements.gaugeBubble.setAttribute("hidden", "");
  hideTuneHints();
  elements.pitchMeter.setAttribute("aria-valuenow", "0");
  elements.pitchMeter.setAttribute("aria-valuetext", "該当する弦なし");
  elements.tunerMain.dataset.signal = "empty";
  elements.tunerMain.dataset.tuned = "false";
  elements.tunerMain.dataset.direction = "none";
  if (elements.tuneStatus.textContent) elements.tuneStatus.textContent = "";
}

function hideTuneHints() {
  displayTuned = false;
  setHiddenState(elements.gaugeHintUp, true);
  setHiddenState(elements.gaugeHintDown, true);
  setHiddenState(elements.gaugeHintCheck, true);
}

function noteToMidi(note) {
  const match = /^([A-G]#?)(-?\d+)$/.exec(note);
  if (!match) throw new Error(`bad note: ${note}`);
  return NOTE_SEMITONE[match[1]] + (Number(match[2]) + 1) * 12;
}

function midiToHz(midi) {
  return concertAHz * 2 ** ((midi - CONFIG.midiA4) / 12);
}

function updateAutoString(hz) {
  const best = nearestStringIndex(hz, targetsHz, CONFIG.stringMatchMaxCents);
  const previous = autoString;

  if (best < 0) {
    autoString = -1;
    return autoString !== previous;
  }
  if (autoString < 0 || autoString >= targetsHz.length) {
    autoString = best;
    return autoString !== previous;
  }

  const currentDistance = Math.abs(centsBetween(hz, targetsHz[autoString]));
  const bestDistance = Math.abs(centsBetween(hz, targetsHz[best]));

  if (currentDistance - bestDistance > CONFIG.stickyMarginCents) {
    autoString = best;
  }
  return autoString !== previous;
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

function formatBubbleCents(cents) {
  const normalized = Object.is(cents, -0) ? 0 : cents;
  if (normalized < 0) return `\u2212${Math.abs(normalized)}`;
  return normalized > 0 ? `+${normalized}` : "0";
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

// --- diagnostic capture: 10 s of raw microphone audio plus per-frame
// pipeline values, downloaded as WAV + JSON so a real environment can be
// replayed through the offline analysis harness exactly as heard. ---
let diagnosticCapture = null;

function startDiagnosticCapture() {
  if (!DEBUG_ENABLED || diagnosticCapture || !microphoneActive || !audioContext || !sourceNode) {
    return;
  }
  const context = audioContext;
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentSink = context.createGain();
  silentSink.gain.value = 0;
  const chunks = [];
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  sourceNode.connect(processor);
  processor.connect(silentSink);
  silentSink.connect(context.destination);
  diagnosticCapture = {
    context,
    processor,
    silentSink,
    chunks,
    frames: [],
    startedAt: performance.now(),
  };

  const durationMs = 10_000;
  const tick = () => {
    if (!diagnosticCapture) return;
    const elapsedMs = performance.now() - diagnosticCapture.startedAt;
    if (elapsedMs >= durationMs) {
      finishDiagnosticCapture();
      return;
    }
    elements.debugCapture.textContent =
      `計測中… 残り${Math.ceil((durationMs - elapsedMs) / 1000)}秒（普通に弾いてください）`;
    window.setTimeout(tick, 250);
  };
  tick();
}

function finishDiagnosticCapture() {
  const capture = diagnosticCapture;
  diagnosticCapture = null;
  if (!capture) return;
  for (const disconnect of [
    () => capture.processor.disconnect(),
    () => capture.silentSink.disconnect(),
    () => sourceNode?.disconnect(capture.processor),
  ]) {
    try { disconnect(); } catch { /* the graph may already be released */ }
  }

  const sampleRate = capture.context.sampleRate;
  const totalSamples = capture.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of capture.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const inputTrack = mediaStream?.getAudioTracks()[0];
  downloadBlob(encodeWavPcm16(samples, sampleRate), `tuner-capture-${stamp}.wav`);
  downloadBlob(
    new Blob(
      [JSON.stringify({
        userAgent: navigator.userAgent,
        sampleRate,
        trackLabel: inputTrack?.label ?? null,
        trackSettings: inputTrack?.getSettings?.() ?? null,
        concertAHz,
        tuningId: currentTuning.id,
        capturedSeconds: totalSamples / sampleRate,
        frames: capture.frames,
      })],
      { type: "application/json" },
    ),
    `tuner-capture-${stamp}.json`,
  );
  elements.debugCapture.textContent = "保存しました（ダウンロードフォルダ）— もう一度計測できます";
}

function encodeWavPcm16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (position, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(position + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function updateDebugPanel(values = {}) {
  if (!DEBUG_ENABLED) return;

  const rawHz = values.rawHz;
  const clarity = values.clarity;
  const rms = values.rms ?? lastMeasuredRms;
  const correction = values.correction ?? lastPitchCorrection;
  const trackerEvent = values.trackerEvent ?? pitchTracker.event;
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
  const inputTrack = mediaStream?.getAudioTracks()[0];
  const inputSettings = inputTrack?.getSettings?.() ?? {};

  if (Object.hasOwn(values, "rawHz")) {
    elements.debugRaw.textContent = Number.isFinite(rawHz) ? rawHz.toFixed(2) : "—";
  }
  if (Object.hasOwn(values, "clarity")) {
    elements.debugClarity.textContent = Number.isFinite(clarity) ? clarity.toFixed(3) : "—";
  }
  elements.debugRms.textContent = Number.isFinite(rms) ? rms.toFixed(4) : "—";
  elements.debugCorrection.textContent = correction;
  elements.debugTracker.textContent = trackerEvent
    ? `${pitchTracker.state}/${trackerEvent}`
    : pitchTracker.state;
  elements.debugInput.textContent = [
    inputTrack ? `track:${inputTrack.readyState}/${inputTrack.muted ? "muted" : "on"}` : "track:none",
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
