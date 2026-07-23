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
  // 0.9, and the tracker's stability clustering rejects unstable input. The
  // acquire gate was 0.8, which left a weak low-string pluck waiting up to a
  // second before the reading appeared ("barely responds"); 0.6 cuts that to
  // ~130 ms, and the player's own captures show no false locks at 0.6.
  clarityAcquireMin: 0.6,
  clarityTrackMin: 0.5,
  // Kept low because a device noise gate can squeeze a still-ringing string to
  // near-digital silence (measured floor 0.00002 on the user's G capture); the
  // clarity gates are what reject actual noise, these floors only bound it.
  rmsAcquireMin: 0.0001,
  rmsTrackMin: 0.00004,
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
  // Display continuity. Aggressive device noise processing (Bluetooth mics,
  // Android noise suppression) chops one ringing string into short episodes
  // with silence between; the reading must survive those gaps looking alive,
  // the way commercial tuners do. Stay fully lit for displayDimDelayMs after a
  // release, then dim, then clear at displayHoldMs.
  displayDimDelayMs: 3000,
  displayHoldMs: 8000,
  // A re-pluck of the note already on screen relocks instantly when the new
  // reading lands within this of the held value (a pluck attack starts up to
  // ~15c sharp; garbage transients are hundreds of cents off).
  reAcquireSnapCents: 35,
  // An unmatched pitch only clears the held reading once it persists this many
  // near-consecutive frames: a genuine unmatchable note is continuous, while a
  // noise-gate wisp is one or two isolated frames that must be discarded.
  unmatchedClearFrames: 4,
  // Onset-settle gate: at a fresh pluck the attack transient can be detected
  // wildly off (a hard B3 momentarily reads ~280 Hz => +221c). Show the note
  // letter but hold the needle blank until the pitch has stayed within
  // displaySettleSpreadCents for displaySettleMs, so a transient is never
  // committed or latched (the same idea as GuitarTuna discarding bad samples).
  displaySettleMs: 90,
  displaySettleSpreadCents: 30,
  // Safety valve: if a note never settles (sustained vibrato, or turning the
  // peg fast right at the attack), commit anyway after this long so the needle
  // can never stay blank — a transient is always gone well before this.
  displaySettleMaxMs: 350,
  // Decay-glide damping. A plucked string genuinely falls as it fades — measured
  // -15..-17c on this user's low E, tracking the RMS decay exactly — so a string
  // tuned to 0 slowly reads flat while it rings, which looks like drift. While
  // the note is decaying, absorb that slow downward drift. A real peg turn moves
  // faster than sustainHoldMaxRateCents/s, and anything past sustainHoldMaxCents
  // is a genuine detune, so both still follow exactly (no offset left behind).
  // The glide is proportional to how far the note has decayed: measured on this
  // user's low E, -11.5 dB of level cost -15.2c, and -10.5 dB cost -20c, i.e.
  // ~1.3-1.9 c/dB. So compensate that amplitude-linked component rather than
  // blocking downward movement — blocking direction stops a sharp string from
  // ever converging down to 0. A real peg turn changes pitch without a matching
  // level drop, so it passes through untouched.
  glideCentsPerDb: 1.5,
  glideMaxCompensationCents: 25,
  glideRmsSmoothing: 0.08,
  // Display smoothing (One-Euro): the cutoff rises with the sustained rate of
  // change, so a held note is smoothed hard (steady) while a peg turn passes
  // through almost instantly. beta sets how far motion opens the cutoff.
  // Measured on the player's captures, a low beta lags the reading behind the
  // pitch by 6-23 cents — the "tracking is nowhere near Tuna" complaint — so
  // beta stays high for responsiveness. A plucked string's real attack glide
  // (~15 cents sharp settling over a second) does show through, but it is the
  // string's true pitch; the large jumps that used to read as "bouncing" were
  // octave misdetections, now corrected separately.
  oneEuroMinCutoffHz: 0.15,
  oneEuroBeta: 0.7,
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
  inTuneCents: 9,
  // The green state enters and leaves at different thresholds so measurement
  // jitter at the boundary cannot strobe the display.
  tunedEnterCents: 4,
  tunedExitCents: 7,
  nearTuneCents: 15,
  // A fresh or badly slipped string sits 100-200 cents off; the needle must
  // keep moving through that whole approach or winding feels like nothing is
  // happening.
  meterRangeCents: 100,
  // Exponent > 1 compresses the centre of the lane (see lanePosition): the
  // in-tune region reads as a stable well instead of amplifying jitter.
  meterCompressExponent: 1.2,
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
  // Reference tone played when a string's note letter is tapped, so the player
  // can tune by ear. Louder and longer than the completion chime, with a
  // plucked-string decay.
  referenceToneGain: 0.2,
  referenceToneMs: 1400,
  midiA4: 69,
  stringMatchMaxCents: 600,
  // Octave correction. At a hard attack the detector can lock an octave below
  // the played note (a subharmonic key maximum transiently wins), so a plucked
  // B3 briefly reads as ~124 Hz and the display jumps a whole octave. A real
  // fundamental has strong odd harmonics (f, 3f, 5f); a subharmonic artifact
  // has almost none — its energy sits on the even multiples (2f, 4f) that
  // belong to the true note an octave up. When the odd/even harmonic-energy
  // ratio is below octaveHarmonicRatioMax AND twice the reading lands on a
  // target string, the octave is corrected up. Both conditions are required so
  // a real low note (whose double is not a string) is never pushed up.
  octaveHarmonicRatioMax: 0.4,
  octaveTargetSnapCents: 60,
  // Continuity octave fold. Some strings (a worn or buzzing G especially)
  // genuinely radiate at half their pitch, so the spectral test above cannot
  // reject it — measured odd/even ratio 0.44-0.75, i.e. it looks like a real
  // low note. But while a note is already being tracked, a reading landing on
  // almost exactly half (or double) the tracked pitch is an octave
  // misdetection, not the player jumping an octave mid-sustain: a real octave
  // change is re-plucked, which releases the note first. Fold it back.
  octaveFoldToleranceCents: 40,
  // ...but only for an isolated blip. A sustained octave reading is a real
  // octave change and must still reach the tracker so it can switch, so stop
  // folding once this many in a row have been folded.
  octaveFoldMaxRun: 2,
  // The fold also applies for a short while AFTER tracking ends. The player
  // tunes one string continuously, and a device noise gate can chop the note
  // into separate episodes; on re-acquisition a subharmonic reading (a worn G
  // at ~96 Hz) would otherwise acquire directly as E2/A2 — the spectral test
  // cannot reject it (measured 0.44-0.75 on this user's G). The maxRun guard
  // still lets a genuinely sustained octave-different note through.
  octaveFoldRecentMs: 5000,
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
    { cents: 25, rank: "minor" },
    { cents: 50, rank: "medium" },
    { cents: 100, rank: "major" },
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
  gaugeFill: document.querySelector("#gaugeFill"),
  gaugeZoneFine: document.querySelector("#gaugeZoneFine"),
  gaugeCenterLine: document.querySelector("#gaugeCenterLine"),
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
let displayConfirmed = false;
let onsetSamples = [];
let onsetStart = null;
let sustainRmsPeak = 0;
let sustainRmsSmoothed = null;
let sustainAnchorCents = null;
let filterPrevCents = null;
let filterPrevSpeed = 0;
let filterPrevAt = null;
let displayedCentsInt = null;
let bubbleTargetPosition = null;
let bubblePosition = null;
let bubbleAnimatedAt = null;
let gaugeBand = "is-green";
let octaveFoldRun = 0;
let rmsFastEma = null;
let lastOnsetAt = -Infinity;
let lastRefinedHz = Number.NaN;
let lastRefinedAt = -Infinity;
let displayTuned = false;
let lastStableHz = null;
let lastStableAt = -Infinity;
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
let displayDimAt = null;
let unmatchedRun = 0;
let lastUnmatchedAt = -Infinity;
let reselectFramesLeft = 0;
const activeChimeVoices = new Set();
let activeChimeMaster = null;
let activeReferenceSource = null;
let activeReferenceFilter = null;
let activeReferenceMaster = null;
let referenceAudioContext = null;
// Recorded acoustic-guitar reference samples (University of Iowa MIS, free of
// use restrictions). Decoded once and reused; declared here so the init-time
// loadGuitarSamples() call is not in these bindings' temporal dead zone.
const GUITAR_SAMPLE_NOTES = ["E2", "A2", "D3", "G3", "B3", "E4"];
const guitarSampleCache = new Map();
let guitarSamplesPromise = null;

const pitchAnalyzer = new GuitarPitchAnalyzer(CONFIG.fftSize, {
  minHz: CONFIG.minPitchHz,
  maxHz: CONFIG.maxPitchHz,
});

const fineAnalyzer = new GuitarPitchAnalyzer(CONFIG.refineFftSize, {
  minHz: CONFIG.minPitchHz,
  maxHz: CONFIG.maxPitchHz,
});

// Hann window over the long buffer, precomputed once for the octave corrector's
// harmonic-energy probes.
const octaveWindow = (() => {
  const window = new Float32Array(CONFIG.refineFftSize);
  for (let index = 0; index < window.length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (window.length - 1));
  }
  return window;
})();

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

// Preload the recorded guitar reference samples in the background so a peg tap
// sounds instantly; a tap before they arrive falls back to the modelled pluck.
void loadGuitarSamples();

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
    // Reference tones now ride the live mic context, so retire the dedicated
    // playback context created for any pre-mic taps instead of leaving both open.
    if (referenceAudioContext) {
      stopActiveReference();
      const retired = referenceAudioContext;
      referenceAudioContext = null;
      if (retired.state !== "closed") void retired.close().catch(() => {});
    }
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

    // Some browsers/OSes silently keep noise suppression on despite the
    // getUserMedia constraints, and its gate chops a decaying string's tail to
    // digital silence (measured: the G capture floor was 0.00002 ≈ digital
    // zero). Ask again on the live track; the debug panel's EC/NS/AGC row
    // shows what actually applied.
    if (inputTrack?.applyConstraints) {
      void inputTrack
        .applyConstraints({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        })
        .catch(() => {});
    }

    // A Bluetooth headset microphone runs in hands-free mode: telephone-band
    // sample rate and the headset's own noise gate, which chops a decaying
    // string to silence (confirmed on a user capture: "EarFun Tune Pro
    // (Bluetooth)", 16 kHz, floor at digital zero). Nothing the app requests
    // can disable that hardware DSP, so say it plainly instead.
    const inputSettings = inputTrack?.getSettings?.() ?? {};
    const bluetoothMic =
      /bluetooth/i.test(inputTrack?.label ?? "") ||
      (Number.isFinite(inputSettings.sampleRate) && inputSettings.sampleRate <= 24000);
    if (bluetoothMic) {
      setInputWarning("Bluetoothマイクは通話品質になります。内蔵マイク推奨");
    }

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

    // Keep the long buffer current every frame, tracking or not: the octave
    // corrector needs it at the acquiring frame, before a tracked pitch exists.
    const refineBufferReady = Boolean(refineAnalyserNode && refineBuffer);
    if (refineBufferReady) refineAnalyserNode.getFloatTimeDomainData(refineBuffer);

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
    if (referenceHz !== null && refineBufferReady) {
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

  // Pluck-onset detector: a real new note arrives with an RMS jump, a decay
  // artifact does not. The ×3 fold below uses this to tell a genuine E2 pluck
  // (switch after the usual short run) from a decaying B3 read at its third
  // subharmonic (fold for as long as the decay lasts).
  if (Number.isFinite(rms)) {
    if (
      rmsFastEma !== null &&
      rms > Math.max(rmsFastEma * 2.5, CONFIG.rmsAcquireMin * 4)
    ) {
      lastOnsetAt = now;
    }
    rmsFastEma = rmsFastEma === null ? rms : rmsFastEma + (rms - rmsFastEma) * 0.3;
  }

  // Fix an octave-down (subharmonic) misdetection BEFORE the tracker sees it.
  // A plucked G string intermittently reads at exactly half its pitch (~97.7 Hz
  // for G3); feeding that to the tracker threw it into switch-pending and drove
  // release episodes and dropouts, which is why G was the least stable string.
  // The odd/even harmonic check already separates a real low note from a
  // subharmonic, so run it on the raw value instead of only on the output.
  let trackedHz = Number.NaN;
  if (signalUsable) {
    trackedHz = foldOctaveToTracked(octaveCorrectHz(rawHz), now);
  } else {
    octaveFoldRun = 0;
  }
  const octaveCorrected = signalUsable && trackedHz !== rawHz;

  const result = pitchTracker.update({
    hz: trackedHz,
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
    displayDimAt = null;
    pushJitterSample(stableHzHistory, now, stableHz);
    lastStableHz = stableHz;
    lastStableAt = now;
    lastPitchCorrection = octaveCorrected ? "×2↑" : folded ? "½↓" : "×1";
    // Select only when the tracker confirms a new cluster. A bend or drift in
    // one sustained note must not silently move the UI to another string.
    updateDisplay(stableHz, now, { reselectString, refinedHz });
  } else if (result.event === "released") {
    // Keep the last reading visible: a plucked string fading out (or being
    // chopped off by device noise processing) should not blank the tuner the
    // player is reading. Stay fully lit for a while first — dimming right away
    // read as the tuner dying between plucks — then dim, then clear.
    chimeArmed = true;
    inTuneSince = null;
    displayHoldUntil = now + CONFIG.displayHoldMs;
    displayDimAt = now + CONFIG.displayDimDelayMs;
  } else if (result.state === PITCH_TRACKER_STATES.RELEASE) {
    // Transient release episodes (clarity dipping for a few frames) keep the
    // display fully lit; dimming only starts once the note actually ends.
    // Flashing the whole gauge at the clarity boundary read as flutter.
    inTuneSince = null;
  } else if (result.event === "switch-pending") {
    // Hold the last trustworthy value while a new, distant cluster is checked.
    inTuneSince = null;
  }

  // The deferred dim from a released note.
  if (displayDimAt !== null && now >= displayDimAt) {
    displayDimAt = null;
    dimDisplay();
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

    // Invalid-sample guard: a pitch that matches NO string (a gate wisp at
    // e.g. 509 Hz) is not a note the player can be tuning. Blanking the held
    // reading for it made the tuner look dead between plucks — discard the
    // sample and keep what is on screen instead, like commercial tuners do.
    // A genuinely unmatchable NOTE is continuous, so once the unmatched pitch
    // persists a few near-consecutive frames it falls through and clears.
    if (
      manualString === null &&
      smoothedCents !== null &&
      nearestStringIndex(stableHz, targetsHz, CONFIG.stringMatchMaxCents) < 0
    ) {
      unmatchedRun = now - lastUnmatchedAt <= 300 ? unmatchedRun + 1 : 1;
      lastUnmatchedAt = now;
      if (unmatchedRun < CONFIG.unmatchedClearFrames) {
        updateDebugPanel({ stableHz, midi: Number.NaN, cents: Number.NaN });
        return;
      }
    } else {
      unmatchedRun = 0;
    }

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

  const noteIndex = ((midi % NOTE_NAMES.length) + NOTE_NAMES.length) % NOTE_NAMES.length;
  const octave = Math.floor(midi / NOTE_NAMES.length) - 1;
  const noteName = NOTE_NAMES[noteIndex];

  // Onset-settle gate. A fresh note episode (new note, or the tracker just
  // (re)acquired/switched) starts unconfirmed: gather its cents and only commit
  // once they hold within displaySettleSpreadCents for displaySettleMs. A brief
  // attack transient never gathers a settled window, so it is neither shown nor
  // latched — the needle simply appears already on the right value.
  if (reselectString || midi !== previousMidi) {
    // Instant relock: a re-pluck of the note already on screen, reading close
    // to the held value, needs no settle window — a device noise gate chops a
    // ringing string into episodes every second or two, and blanking the
    // needle on each one made the tuner look dead half the time. Garbage
    // transients sit hundreds of cents off, so proximity is a safe test.
    const instantRelock =
      midi === previousMidi &&
      smoothedCents !== null &&
      Math.abs(measuredCents - smoothedCents) <= CONFIG.reAcquireSnapCents;
    resetCentsFilter();
    displayConfirmed = instantRelock;
    onsetSamples = [];
    onsetStart = now;
    sustainRmsPeak = 0;
    sustainRmsSmoothed = null;
    sustainAnchorCents = null;
    // Seed the filter at the held value so the needle continues from where it
    // was instead of jumping to the raw attack reading.
    if (instantRelock) filterCents(smoothedCents, now);
  }
  // Smooth the level before using it for glide compensation: raw frame-to-frame
  // RMS is noisy, and feeding that straight in injects that noise into the
  // displayed cents (measured: it added ~1.2c of jitter on G3).
  if (Number.isFinite(lastMeasuredRms)) {
    sustainRmsSmoothed =
      sustainRmsSmoothed === null
        ? lastMeasuredRms
        : sustainRmsSmoothed + (lastMeasuredRms - sustainRmsSmoothed) * CONFIG.glideRmsSmoothing;
    if (sustainRmsSmoothed > sustainRmsPeak) sustainRmsPeak = sustainRmsSmoothed;
  }
  previousMidi = midi;
  lastDisplayAt = now;

  if (!displayConfirmed) {
    onsetSamples.push(measuredCents);
    if (onsetSamples.length > 12) onsetSamples.shift();
    const spread = Math.max(...onsetSamples) - Math.min(...onsetSamples);
    const waited = now - onsetStart;
    const settled =
      waited >= CONFIG.displaySettleMs &&
      onsetSamples.length >= 3 &&
      spread <= CONFIG.displaySettleSpreadCents;
    const timedOut = waited >= CONFIG.displaySettleMaxMs && onsetSamples.length >= 3;
    if (settled || timedOut) {
      // Seed the filter at the settled median so the needle appears in place.
      const sorted = [...onsetSamples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      resetCentsFilter();
      smoothedCents = filterCents(median, now);
      displayConfirmed = true;
    } else {
      renderConfirmingDisplay(noteName, octave);
      updateDebugPanel({ stableHz, midi, cents: Number.NaN });
      return;
    }
  } else {
    const filtered = filterCents(measuredCents, now);
    smoothedCents = holdThroughDecay(filtered);
  }

  const gaugeCents = clamp(
    smoothedCents,
    -CONFIG.meterRangeCents,
    CONFIG.meterRangeCents,
  );
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

  // Colour band shared by the bubble and the centre-to-bubble fill: green in
  // tune, amber within nearTuneCents, orange beyond. The fill geometry is drawn
  // per frame in animateBubble, so it just reads gaugeBand.
  gaugeBand = displayTuned || absCents <= CONFIG.inTuneCents
    ? "is-green"
    : absCents <= CONFIG.nearTuneCents
      ? "is-amber"
      : "is-orange";
  elements.gaugeBubble.setAttribute("class", `gauge-bubble signal-dependent ${gaugeBand}`);

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

// Absorb the downward pitch drift a string makes as it decays, so a string
// tuned to 0 does not slowly read flat while it rings. Only slow, downward
// movement on a fading note is held: a peg turn is faster than
// sustainHoldMaxRateCents/s and a genuine detune exceeds sustainHoldMaxCents,
// and both re-anchor so no offset is left behind.
function holdThroughDecay(cents) {
  // Ceiling of the uncompensated reading this sustain — the pitch the note
  // started at, tracked upward so a peg turn up re-anchors.
  sustainAnchorCents = sustainAnchorCents === null
    ? cents
    : Math.max(sustainAnchorCents, cents);
  if (!Number.isFinite(sustainRmsSmoothed) || sustainRmsSmoothed <= 0) return cents;
  if (sustainRmsPeak <= 0) return cents;
  // How far the note has faded from its loudest point, in dB (<= 0).
  const decayDb = 20 * Math.log10(sustainRmsSmoothed / sustainRmsPeak);
  if (decayDb >= 0) return cents;
  const model = clamp(
    -CONFIG.glideCentsPerDb * decayDb,
    0,
    CONFIG.glideMaxCompensationCents,
  );
  // Never compensate more than the pitch has actually fallen this sustain. A
  // device noise gate collapses the level with NO real glide (measured: level
  // -40 dB in 0.8 s while the raw pitch sat at 192.0-192.2 Hz); the dB model
  // alone then pushed the reading +21c sharp and it dived back on the next
  // pluck. Bounded by the observed drop, a gated-but-steady note gets ~0
  // compensation while a genuinely gliding low E still gets the full hold.
  const observedDrop = Math.max(0, sustainAnchorCents - cents);
  return cents + Math.min(model, observedDrop);
}

// Shown while a fresh note is still settling: the note letter is known, but the
// needle is held blank so an attack transient never appears on the meter.
function renderConfirmingDisplay(noteName, octave) {
  elements.gaugeNote.textContent = noteName;
  elements.gaugeOctave.textContent = String(octave);
  elements.gaugeCents.textContent = "·";
  displayedCentsInt = null;
  displayTuned = false;
  elements.pitchMeter.setAttribute("aria-valuetext", `${noteName}${octave}、測定中`);
  // Leave the bubble where it was: on a first acquisition it is already hidden,
  // and on a re-pluck of a sustained note this avoids blinking the needle out.
  elements.tunerMain.dataset.signal = "active";
  elements.tunerMain.dataset.tuned = "false";
  elements.tunerMain.dataset.direction = "none";
  setHiddenState(elements.gaugeHintUp, true);
  setHiddenState(elements.gaugeHintDown, true);
  setHiddenState(elements.gaugeHintCheck, true);
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
  stopActiveReference();
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

// The reference tone works before the mic is enabled, so it prefers the live
// analysis context but falls back to a dedicated one it creates on demand
// (the tap is a user gesture, so the browser lets us resume it).
function ensurePlaybackContext() {
  if (audioContext && audioContext.state === "running") return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!referenceAudioContext || referenceAudioContext.state === "closed") {
    try {
      referenceAudioContext = new AudioContextClass();
    } catch {
      return null;
    }
  }
  if (referenceAudioContext.state === "suspended") {
    void referenceAudioContext.resume().catch(() => {});
  }
  return referenceAudioContext;
}

function stopActiveReference() {
  if (activeReferenceSource) {
    activeReferenceSource.onended = null;
    try {
      activeReferenceSource.stop();
    } catch {
      // A source that already ended only needs disconnecting.
    }
    try {
      activeReferenceSource.disconnect();
    } catch {
      // The audio context may already be closed.
    }
    activeReferenceSource = null;
  }
  for (const node of [activeReferenceFilter, activeReferenceMaster]) {
    if (!node) continue;
    try {
      node.disconnect();
    } catch {
      // The audio context may already be closed.
    }
  }
  activeReferenceFilter = null;
  activeReferenceMaster = null;
}

// Synthesise a plucked steel string by physical modelling (Karplus–Strong): a
// short noise burst excites a feedback delay line whose length is one period,
// so the pitch is exact while a one-pole loop filter bleeds off the high
// partials the way a real string does — a genuine pluck, not a stack of sines.
// The delay uses a fractional (interpolated) read so the fundamental lands on
// the target frequency to within a cent, which matters for a tuning reference.
function renderPluck(sampleRate, frequency, durationSec) {
  const total = Math.max(1, Math.floor(sampleRate * durationSec));
  const out = new Float32Array(total);
  const period = sampleRate / frequency;
  // The averaging loop filter adds ~half a sample of delay; take it back out of
  // the delay line so the total loop delay is exactly one period.
  const delayLen = Math.max(2, period - 0.5);
  const intDelay = Math.floor(delayLen);
  const fracDelay = delayLen - intDelay;
  const size = intDelay + 2;
  const ring = new Float32Array(size);
  // Per-sample loss tuned so the fundamental decays to a few percent by the end.
  const loss = Math.pow(0.05, 1 / total);
  const burst = intDelay;
  let write = 0;
  let prevDelayed = 0;
  let softNoise = 0;
  let peak = 0;
  for (let n = 0; n < total; n += 1) {
    const read0 = (write - intDelay + size) % size;
    const read1 = (write - intDelay - 1 + size) % size;
    const delayed = (1 - fracDelay) * ring[read0] + fracDelay * ring[read1];
    // One-pole averaging = the string's frequency-dependent damping.
    const damped = 0.5 * (delayed + prevDelayed);
    prevDelayed = delayed;
    let sample = loss * damped;
    if (n < burst) {
      // Soften the pick so the attack is warm, not a white-noise click.
      softNoise = 0.55 * (Math.random() * 2 - 1) + 0.45 * softNoise;
      sample += softNoise;
    }
    ring[write] = sample;
    out[n] = sample;
    write = write + 1 === size ? 0 : write + 1;
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  // Normalise so every string is equally loud, then fade the edges to kill clicks.
  const norm = peak > 1e-6 ? 0.9 / peak : 1;
  const attack = Math.min(total, Math.round(sampleRate * 0.002));
  const release = Math.min(total, Math.round(sampleRate * 0.03));
  for (let n = 0; n < total; n += 1) {
    let gain = norm;
    if (n < attack) gain *= n / attack;
    if (n >= total - release) gain *= (total - n) / release;
    out[n] *= gain;
  }
  return out;
}

// Play a string's target pitch as a plucked-string tone so the player can tune
// by ear. Rendered offline (renderPluck) and played through a warm low-pass so
// it reads as an acoustic pluck.
// Autocorrelation estimate of a buffer's fundamental, so a recorded sample can
// be pitch-locked exactly onto the target (a tuning reference must be in tune).
function measureFundamental(samples, sampleRate, approxHz) {
  const period = sampleRate / approxHz;
  const minLag = Math.max(2, Math.floor(period * 0.6));
  const maxLag = Math.ceil(period * 1.6);
  const start = Math.min(samples.length >> 2, Math.floor(sampleRate * 0.3));
  const end = Math.min(samples.length, start + Math.floor(sampleRate * 0.4));
  const correlate = (lag) => {
    let sum = 0;
    for (let i = start; i + lag < end; i += 1) sum += samples[i] * samples[i + lag];
    return sum;
  };
  let bestLag = -1;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = correlate(lag);
    if (value > best) { best = value; bestLag = lag; }
  }
  if (bestLag < 1) return approxHz;
  const y0 = correlate(bestLag - 1);
  const y1 = correlate(bestLag);
  const y2 = correlate(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return sampleRate / (bestLag + shift);
}

// Fetch and decode the recorded guitar notes once (via an OfflineAudioContext so
// it needs no user gesture), normalising each and measuring its true pitch.
function loadGuitarSamples() {
  if (guitarSamplesPromise) return guitarSamplesPromise;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (typeof fetch !== "function" || !OfflineCtx) {
    guitarSamplesPromise = Promise.resolve();
    return guitarSamplesPromise;
  }
  guitarSamplesPromise = (async () => {
    const decodeContext = new OfflineCtx(1, 1, 44100);
    await Promise.all(GUITAR_SAMPLE_NOTES.map(async (note) => {
      try {
        const response = await fetch(`samples/guitar/${note}.mp3`);
        if (!response.ok) return;
        const encoded = await response.arrayBuffer();
        const buffer = await decodeContext.decodeAudioData(encoded);
        const data = buffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const magnitude = Math.abs(data[i]);
          if (magnitude > peak) peak = magnitude;
        }
        if (peak > 1e-6) {
          const normalise = 0.95 / peak;
          for (let i = 0; i < data.length; i += 1) data[i] *= normalise;
        }
        const nominalHz = 440 * 2 ** ((noteToMidi(note) - CONFIG.midiA4) / 12);
        const measuredHz = measureFundamental(data, buffer.sampleRate, nominalHz);
        guitarSampleCache.set(note, { buffer, measuredHz });
      } catch {
        // A sample that fails to load just leaves the synth fallback in place.
      }
    }));
  })();
  return guitarSamplesPromise;
}

// Nearest loaded sample by log-frequency, so the playback-rate stretch is small.
// Rejects anything more than ~3.5 semitones away — that guards the cold-load
// window (only some notes decoded) from substituting a wrong-octave sample, and
// sends far-off alternate tunings to the synth fallback instead of a big stretch.
const SAMPLE_MAX_LOG2_DISTANCE = 0.29;
function pickGuitarSample(hz) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of guitarSampleCache.values()) {
    const distance = Math.abs(Math.log2(hz / entry.measuredHz));
    if (distance < bestDistance) { bestDistance = distance; best = entry; }
  }
  return bestDistance <= SAMPLE_MAX_LOG2_DISTANCE ? best : null;
}

function playGuitarSample(context, sample, targetHz) {
  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  // Resample so the recording lands exactly on the target frequency; clamp to a
  // sane range so a bad pitch estimate can never produce a runaway rate.
  const rawRate = targetHz / sample.measuredHz;
  const rate = Number.isFinite(rawRate) ? clamp(rawRate, 0.5, 2) : 1;
  source.playbackRate.value = rate;

  const masterGain = context.createGain();
  masterGain.gain.value = CONFIG.referenceToneGain;
  source.connect(masterGain).connect(context.destination);

  activeReferenceSource = source;
  activeReferenceFilter = null;
  activeReferenceMaster = masterGain;
  source.onended = () => {
    if (activeReferenceSource !== source) return;
    try {
      source.disconnect();
      masterGain.disconnect();
    } catch {
      // The audio context may already have been closed.
    }
    activeReferenceSource = null;
    activeReferenceMaster = null;
  };
  source.start();
  return (sample.buffer.duration / rate) * 1000;
}

// Fallback used until the recorded samples finish loading (or if they fail):
// the modelled pluck. Kept so a tap always makes a sound.
function playSynthPluck(context, hz) {
  const samples = renderPluck(context.sampleRate, hz, CONFIG.referenceToneMs / 1000);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;

  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(4200, context.sampleRate / 2 - 100);
  tone.Q.value = 0.6;

  const masterGain = context.createGain();
  masterGain.gain.value = CONFIG.referenceToneGain;
  source.connect(tone).connect(masterGain).connect(context.destination);

  activeReferenceSource = source;
  activeReferenceFilter = tone;
  activeReferenceMaster = masterGain;
  source.onended = () => {
    if (activeReferenceSource !== source) return;
    try {
      source.disconnect();
      tone.disconnect();
      masterGain.disconnect();
    } catch {
      // The audio context may already have been closed.
    }
    activeReferenceSource = null;
    activeReferenceFilter = null;
    activeReferenceMaster = null;
  };
  source.start();
  return CONFIG.referenceToneMs;
}

// Play a string's target pitch as a recorded acoustic-guitar note (nearest
// sample, resampled exactly onto the target) so the player can tune by ear.
function playStringReference(index) {
  const hz = targetsHz[index];
  if (!Number.isFinite(hz) || hz <= 0) return;
  const context = ensurePlaybackContext();
  if (!context) return;

  stopActiveReference();

  const sample = pickGuitarSample(hz);
  const toneMs = sample
    ? playGuitarSample(context, sample, hz)
    : playSynthPluck(context, hz);
  // Samples not ready yet — start loading them for next time.
  if (!sample) void loadGuitarSamples();

  // While the mic is live, freeze analysis for the whole tone so the meter and
  // completion chime never react to the app's own sound through the mic — a
  // shorter window would let the still-ringing reference read as "in tune".
  if (microphoneActive) {
    analysisBlankedUntil = Math.max(
      analysisBlankedUntil,
      performance.now() + toneMs + 120,
    );
    elements.tunerMain.dataset.inputBlanked = "true";
  }
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
  elements.gaugeFill.setAttribute("hidden", "");
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
  displayDimAt = null;
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
  displayConfirmed = false;
  onsetSamples = [];
  smoothedCents = null;
  lastDisplayAt = null;
  displayTuned = false;
  if (clearStableValue) {
    lastStableHz = null;
    lastStableAt = -Infinity;
    octaveFoldRun = 0;
  }
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

  // The in-tune centre line stands taller than the notch so it reads as a
  // distinct "dead centre" marker when the note lands.
  elements.gaugeCenterLine.setAttribute("x1", String(GAUGE.centerX));
  elements.gaugeCenterLine.setAttribute("x2", String(GAUGE.centerX));
  elements.gaugeCenterLine.setAttribute("y1", String(GAUGE.laneY - 34));
  elements.gaugeCenterLine.setAttribute("y2", String(GAUGE.laneY + 34));

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
  for (const [sign, symbol, side] of [[-1, "♭", "flat"], [1, "♯", "sharp"]]) {
    const label = document.createElementNS(SVG_NAMESPACE, "text");
    label.setAttribute("x", String(GAUGE.centerX + sign * GAUGE.halfSpanX));
    label.setAttribute("y", String(GAUGE.laneY + 28));
    label.setAttribute("class", `gauge-end-label gauge-end-${side}`);
    label.textContent = symbol;
    fragment.append(label);
  }

  elements.gaugeTicks.replaceChildren(fragment);
}

// Power mapping to [-1, 1] with exponent > 1: the bubble is LESS sensitive
// near the centre and more sensitive toward the edges. The previous scale did
// the opposite — it expanded the inner cents so the centre was ~19x more
// sensitive than the edge, which magnified a few cents of real measurement
// jitter into ~20 px of bubble chatter exactly when fine-tuning. Compressing
// the centre instead makes the in-tune region a stable well (the same jitter
// is ~3 px) while +-10..20 cents stay clearly readable to guide the tuning.
function lanePosition(cents) {
  const normalized = Math.min(Math.abs(cents), CONFIG.meterRangeCents) / CONFIG.meterRangeCents;
  return Math.sign(cents) * normalized ** CONFIG.meterCompressExponent;
}

function laneX(cents) {
  return GAUGE.centerX + lanePosition(cents) * GAUGE.halfSpanX;
}


function animateBubble(now) {
  if (bubbleTargetPosition === null) {
    if (bubblePosition !== null) {
      bubblePosition = null;
      elements.gaugeBubble.setAttribute("hidden", "");
      elements.gaugeFill.setAttribute("hidden", "");
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
  const x = GAUGE.centerX + bubblePosition * GAUGE.halfSpanX;
  const xText = x.toFixed(1);
  elements.gaugeBubble.setAttribute("transform", `translate(${xText} ${GAUGE.laneY})`);
  elements.gaugeBubble.removeAttribute("hidden");

  // Fill the lane from the centre out to the bubble so distance and direction
  // read at a glance; its colour follows the same band as the bubble.
  elements.gaugeFill.setAttribute("x1", String(GAUGE.centerX));
  elements.gaugeFill.setAttribute("x2", xText);
  elements.gaugeFill.setAttribute("y1", String(GAUGE.laneY));
  elements.gaugeFill.setAttribute("y2", String(GAUGE.laneY));
  elements.gaugeFill.setAttribute("class", `gauge-fill ${gaugeBand}`);
  elements.gaugeFill.removeAttribute("hidden");
}

function renderGaugeValue(cents) {
  bubbleTargetPosition = lanePosition(cents);
}

function renderNoTargetDisplay() {
  previousMidi = null;
  smoothedCents = null;
  displayConfirmed = false;
  onsetSamples = [];
  lastDisplayAt = null;
  elements.gaugeNote.textContent = "—";
  elements.gaugeOctave.textContent = "";
  elements.gaugeCents.textContent = "—";
  displayedCentsInt = null;
  bubbleTargetPosition = null;
  bubblePosition = null;
  elements.gaugeBubble.setAttribute("hidden", "");
  elements.gaugeFill.setAttribute("hidden", "");
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
  playStringReference(index);
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
          ? `${stringNumber}弦 ${note} の基準音を再生、手動選択を解除`
          : `${stringNumber}弦 ${note} の基準音を再生して手動選択`,
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

// Windowed single-frequency magnitude via the Goertzel recurrence (no
// per-sample trig) over the long buffer.
function harmonicMagnitude(hz) {
  const sampleRate = audioContext?.sampleRate;
  if (!Number.isFinite(sampleRate) || !refineBuffer) return 0;
  const coefficient = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let index = 0; index < refineBuffer.length; index += 1) {
    const s0 = refineBuffer[index] * octaveWindow[index] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2);
}

// Correct an octave-down lock (a plucked note read as its subharmonic) up to
// the true fundamental, using the long buffer's harmonic structure. Only fires
// when the odd harmonics are weak AND twice the reading lands on a target
// string, so a genuine low note is never pushed up. See octaveHarmonicRatioMax.
// While a note is actively tracked, snap a reading that lands on almost exactly
// half or double the tracked pitch back onto it. The spectral test in
// octaveCorrectHz cannot help when the string really does radiate at f/2 (a
// buzzing G string), but continuity can: a genuine octave change is re-plucked,
// which releases the note first, so this only ever folds a misdetection.
function foldOctaveToTracked(hz, now) {
  // RELEASE counts too: a decaying note is still the note being tracked, and
  // that is exactly when a stray subharmonic would otherwise end it early.
  // After the note ends, keep folding against the recently tracked pitch for
  // octaveFoldRecentMs — a device noise gate chops one continuous string into
  // separate episodes, and re-acquiring on a subharmonic must not relabel it.
  const tracked = lastStableHz;
  const activelyTracked =
    pitchTracker.state === PITCH_TRACKER_STATES.TRACKING ||
    pitchTracker.state === PITCH_TRACKER_STATES.RELEASE;
  const recentlyTracked = now - lastStableAt <= CONFIG.octaveFoldRecentMs;
  if (
    !Number.isFinite(hz) ||
    hz <= 0 ||
    !Number.isFinite(tracked) ||
    tracked <= 0 ||
    (!activelyTracked && !recentlyTracked)
  ) {
    octaveFoldRun = 0;
    return hz;
  }

  // The detector's known decay failures land on f/2 AND f/3 (round-1 audit:
  // "picks 1/2 and 1/3 subharmonics during real decay"). The f/3 case is nasty
  // in standard tuning because B3/3 = 82.31 Hz ≈ the open E2 (82.41) — a
  // decaying B read at its third subharmonic displays as E. Same family:
  // E4/3 = 109.88 ≈ A2. Fold all of ×2, ÷2, ×3, ÷3 onto the tracked pitch;
  // the max-run guard below still lets a genuinely different note through.
  const tolerance = CONFIG.octaveFoldToleranceCents;
  let folded = hz;
  let tripleFold = false;
  for (const candidate of [hz * 2, hz / 2, hz * 3, hz / 3]) {
    if (Math.abs(centsBetween(candidate, tracked)) <= tolerance) {
      folded = candidate;
      tripleFold = candidate === hz * 3 || candidate === hz / 3;
      break;
    }
  }

  if (folded === hz) {
    octaveFoldRun = 0;
    return hz;
  }
  // A sustained run is normally a real note change: let it through so the
  // tracker can go switch-pending and move, instead of masking it forever.
  // EXCEPT the ×3 family with no recent pluck onset: a genuine note change is
  // always re-plucked (RMS jump), while a decaying string can sit on its third
  // subharmonic indefinitely — and B3/3 lands exactly on the open E2.
  const decayOnly = now - lastOnsetAt > 400;
  if (octaveFoldRun >= CONFIG.octaveFoldMaxRun && !(tripleFold && decayOnly)) {
    return hz;
  }
  octaveFoldRun += 1;
  return folded;
}

function octaveCorrectHz(hz) {
  if (
    !Number.isFinite(hz) ||
    hz <= 0 ||
    targetsHz.length === 0 ||
    !refineBuffer ||
    2 * hz > CONFIG.maxPitchHz
  ) {
    return hz;
  }

  let nearestDoubleCents = Infinity;
  for (const target of targetsHz) {
    nearestDoubleCents = Math.min(
      nearestDoubleCents,
      Math.abs(centsBetween(2 * hz, target)),
    );
  }
  if (nearestDoubleCents > CONFIG.octaveTargetSnapCents) return hz;

  const oddEnergy =
    harmonicMagnitude(hz) + harmonicMagnitude(3 * hz) + harmonicMagnitude(5 * hz);
  const evenEnergy =
    harmonicMagnitude(2 * hz) + harmonicMagnitude(4 * hz) + harmonicMagnitude(6 * hz);

  return oddEnergy < CONFIG.octaveHarmonicRatioMax * evenEnergy ? 2 * hz : hz;
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
  elements.errorMessage.classList.remove("is-warning");
  elements.errorMessage.textContent = message;
}

// Same banner in amber for input-quality notices that are not failures.
function setInputWarning(message) {
  elements.errorMessage.classList.add("is-warning");
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
