import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { chromium } = await loadPlaywright();
const baseUrl = process.env.TUNER_URL ?? "http://127.0.0.1:8004/";
const chromePath = process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = { headless: true };
if (existsSync(chromePath)) launchOptions.executablePath = chromePath;

const browser = await chromium.launch(launchOptions);
const pageErrors = [];
const results = {
  observedRegressions: [],
  openStrings: [],
  sticky: [],
  manual: null,
  chromatic: null,
  chime: null,
};

try {
  for (const testCase of [
    { name: "D2", hz: 73.416, peg: 0, note: "E2", cents: -200, forbiddenPeg: 2 },
    { name: "G2", hz: 97.999, peg: 1, note: "A2", cents: -200, forbiddenPeg: 3 },
    { name: "D4", hz: 293.665, peg: 5, note: "E4", cents: -200, forbiddenPeg: 2 },
  ]) {
    const fixture = await openFixture({ tuningId: "standard", frequency: testCase.hz });
    const state = await waitForPreset(fixture.page, testCase);
    assert.equal(state.activePeg, String(testCase.peg), testCase.name);
    assert.notEqual(state.activePeg, String(testCase.forbiddenPeg), testCase.name);
    assert.equal(state.correction, "×1", `${testCase.name}: no harmonic correction`);
    results.observedRegressions.push({ name: testCase.name, ...state });
    await fixture.context.close();
  }

  for (const [peg, note] of ["E2", "A2", "D3", "G3", "B3", "E4"].entries()) {
    const hz = noteToHz(note);
    const fixture = await openFixture({ tuningId: "standard", frequency: hz });
    const state = await waitForPreset(fixture.page, { peg, note, cents: 0, hz });
    assert.equal(state.activePeg, String(peg), `open ${note}`);
    assert.ok(Math.abs(state.cents) <= 8, `open ${note}: ${state.cents} cents`);
    results.openStrings.push({ expected: note, ...state });
    await fixture.context.close();
  }

  {
    const d3 = noteToHz("D3");
    const fixture = await openFixture({ tuningId: "standard", frequency: d3 });
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 2, note: "D3", cents: 0, hz: d3 },
    ));

    // This is the observed failure path: the previous D3 target must not trap D2.
    await setFrequency(fixture.page, 73.416);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: -200, hz: 73.416 },
    ));

    const e2 = noteToHz("E2");
    await setFrequency(fixture.page, e2);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: 0, hz: e2 },
    ));

    // A2 is only 40 cents closer here, so the current E2 target must remain.
    const insideMargin = e2 * 2 ** (270 / 1200);
    await setFrequency(fixture.page, insideMargin);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: 270, hz: insideMargin, centsTolerance: 10 },
    ));

    // A2 becomes 100 cents closer here, exceeding the 80-cent margin.
    const outsideMargin = e2 * 2 ** (300 / 1200);
    await setFrequency(fixture.page, outsideMargin);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 1, note: "A2", cents: -200, hz: outsideMargin, centsTolerance: 10 },
    ));

    await fixture.context.close();
  }

  {
    const d3 = noteToHz("D3");
    const fixture = await openFixture({
      tuningId: "standard",
      frequency: d3,
      start: false,
    });
    await fixture.page.locator('.peg[data-i="0"]').click();
    await fixture.page.locator("#micButton").click();
    const state = await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 1000,
      hz: d3,
      centsTolerance: 10,
    });
    assert.equal(state.manualPeg, "0");
    assert.equal(state.activePeg, "0");
    results.manual = state;
    await fixture.context.close();
  }

  {
    const cs4 = noteToHz("C#4");
    const fixture = await openFixture({ tuningId: "chromatic", frequency: cs4 });
    const state = await waitForChromatic(fixture.page, "C♯4", cs4);
    assert.equal(state.activeCount, 0);
    assert.equal(state.scrollHeight, state.viewportHeight, "375px layout must not scroll");
    results.chromatic = state;
    await fixture.context.close();
  }

  {
    const e2 = noteToHz("E2");
    const fixture = await openFixture({
      tuningId: "standard",
      frequency: e2 * 2 ** (30 / 1200),
      soundEnabled: true,
    });
    await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 30,
      hz: e2 * 2 ** (30 / 1200),
      centsTolerance: 8,
    });

    await fixture.page.evaluate(() => {
      window.__firstTunedAt = null;
      const tunerMain = document.querySelector("#tunerMain");
      const recordFirstTunedFrame = () => {
        if (tunerMain?.dataset.tuned === "true" && window.__firstTunedAt === null) {
          window.__firstTunedAt = performance.now();
        }
      };
      window.__tunedObserver = new MutationObserver(recordFirstTunedFrame);
      window.__tunedObserver.observe(tunerMain, {
        attributes: true,
        attributeFilter: ["data-tuned"],
      });
      recordFirstTunedFrame();
    });
    await setFrequency(fixture.page, e2);
    await fixture.page.waitForFunction(
      () => window.__oscillatorStarts === 3 && window.__firstTunedAt !== null,
      null,
      { timeout: 12_000 },
    );
    const timing = await fixture.page.evaluate(() => ({
      firstTunedAt: window.__firstTunedAt,
      firstChimeAt: window.__firstChimeAt,
      oscillatorStarts: window.__oscillatorStarts,
    }));
    const heldMs = timing.firstChimeAt - timing.firstTunedAt;
    assert.ok(heldMs >= 200, `chime hold was only ${heldMs.toFixed(1)}ms`);
    results.chime = {
      heldMs: Math.round(heldMs),
      afterHold: timing.oscillatorStarts,
    };
    await fixture.context.close();
  }
} finally {
  await browser.close();
}

assert.deepEqual(pageErrors, [], `browser errors:\n${pageErrors.join("\n")}`);
console.log(JSON.stringify(results, null, 2));

async function openFixture({ tuningId, frequency, start = true, soundEnabled = false }) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(({ tuningId, frequency, soundEnabled }) => {
    localStorage.setItem("tuner.settings", JSON.stringify({
      tuningId,
      soundEnabled,
      concertAHz: 440,
      headstockType: "three-three",
      leftHanded: false,
    }));

    window.__oscillatorStarts = 0;
    window.__firstChimeAt = null;
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = originalCreateOscillator.apply(this, args);
      const originalStart = oscillator.start.bind(oscillator);
      oscillator.start = (...startArgs) => {
        window.__oscillatorStarts += 1;
        if (window.__oscillatorStarts > 1 && window.__firstChimeAt === null) {
          window.__firstChimeAt = performance.now();
        }
        return originalStart(...startArgs);
      };
      return oscillator;
    };

    navigator.mediaDevices.getUserMedia = async () => {
      const inputContext = new AudioContext({ sampleRate: 48_000 });
      const oscillator = inputContext.createOscillator();
      const gain = inputContext.createGain();
      const destination = inputContext.createMediaStreamDestination();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.05;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await inputContext.resume();
      window.__tunerRegressionInput = { inputContext, oscillator };
      return destination.stream;
    };
  }, { tuningId, frequency, soundEnabled });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      pageErrors.push(message.text());
    }
  });
  await page.goto(new URL("?debug=1", baseUrl).href, { waitUntil: "networkidle" });
  if (start) await page.locator("#micButton").click();
  return { context, page };
}

async function setFrequency(page, frequency) {
  await page.evaluate((hz) => {
    const { inputContext, oscillator } = window.__tunerRegressionInput;
    oscillator.frequency.setValueAtTime(hz, inputContext.currentTime);
  }, frequency);
}

async function waitForPreset(page, expected) {
  const centsTolerance = expected.centsTolerance ?? 8;
  await page.waitForFunction(({ peg, note, cents, hz, centsTolerance }) => {
    const activePeg = document.querySelector(".peg.is-active")?.dataset.i ?? null;
    const shownNote = `${document.querySelector("#gaugeNote")?.textContent ?? ""}${document.querySelector("#gaugeOctave")?.textContent ?? ""}`;
    const shownCents = Number(document.querySelector("#debugCents")?.textContent);
    const stableHz = Number(document.querySelector("#debugStable")?.textContent);
    const stableErrorCents = 1200 * Math.log2(stableHz / hz);
    return activePeg === String(peg) &&
      shownNote === note &&
      Number.isFinite(shownCents) &&
      Math.abs(shownCents - cents) <= centsTolerance &&
      Number.isFinite(stableErrorCents) &&
      Math.abs(stableErrorCents) <= 6;
  }, { ...expected, centsTolerance }, { timeout: 12_000 });
  return readState(page);
}

async function waitForChromatic(page, note, hz) {
  await page.waitForFunction(({ note, hz }) => {
    const shownNote = `${document.querySelector("#gaugeNote")?.textContent ?? ""}${document.querySelector("#gaugeOctave")?.textContent ?? ""}`;
    const stableHz = Number(document.querySelector("#debugStable")?.textContent);
    return shownNote === note &&
      Number.isFinite(stableHz) &&
      Math.abs(1200 * Math.log2(stableHz / hz)) <= 6;
  }, { note, hz }, { timeout: 12_000 });
  return readState(page);
}

async function readState(page) {
  return page.evaluate(() => ({
    note: `${document.querySelector("#gaugeNote")?.textContent ?? ""}${document.querySelector("#gaugeOctave")?.textContent ?? ""}`,
    cents: Number(document.querySelector("#debugCents")?.textContent),
    rawHz: Number(document.querySelector("#debugRaw")?.textContent),
    stableHz: Number(document.querySelector("#debugStable")?.textContent),
    clarity: Number(document.querySelector("#debugClarity")?.textContent),
    correction: document.querySelector("#debugCorrection")?.textContent ?? "",
    activePeg: document.querySelector(".peg.is-active")?.dataset.i ?? null,
    manualPeg: document.querySelector(".peg.is-manual")?.dataset.i ?? null,
    activeCount: document.querySelectorAll(".peg.is-active").length,
    sigmaRaw: document.querySelector("#debugSigmaRaw")?.textContent ?? "",
    sigmaStable: document.querySelector("#debugSigmaStable")?.textContent ?? "",
    lag: document.querySelector("#debugLag")?.textContent ?? "",
    centsPerSample: document.querySelector("#debugCentsPerSample")?.textContent ?? "",
    sampleRate: document.querySelector("#debugSampleRate")?.textContent ?? "",
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (packageError) {
    const bundledPath = `${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`;
    if (!existsSync(bundledPath)) throw packageError;
    return import(pathToFileURL(bundledPath).href);
  }
}

function noteToHz(note) {
  const names = {
    C: 0,
    "C#": 1,
    D: 2,
    "D#": 3,
    E: 4,
    F: 5,
    "F#": 6,
    G: 7,
    "G#": 8,
    A: 9,
    "A#": 10,
    B: 11,
  };
  const match = /^([A-G]#?)(-?\d+)$/.exec(note);
  const midi = names[match[1]] + (Number(match[2]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}
