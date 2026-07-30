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
  lowInput: null,
  octaveBurst: null,
  releaseReacquire: null,
  unmatchedSwitch: null,
  chime: null,
  landscapeLayouts: [],
  settingsDialogLandscape: null,
  tuningDialogKeyboard: null,
  microphoneButtonSemantics: null,
  microphoneStatusLayout: null,
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
    // All three presets sit 200 cents flat: the wordless raise hint (∧) must
    // show, and only that one.
    assert.equal(state.direction, "flat", `${testCase.name}: direction`);
    assert.deepEqual(
      { up: state.hintUp, down: state.hintDown, check: state.hintCheck },
      { up: true, down: false, check: false },
      `${testCase.name}: raise hint`,
    );
    assertOnlyExpectedPegs(
      await readUiTrace(fixture.page),
      [testCase.peg],
      `${testCase.name}: transient peg`,
    );
    results.observedRegressions.push({ name: testCase.name, ...state });
    await fixture.context.close();
  }

  for (const [peg, note] of ["E2", "A2", "D3", "G3", "B3", "E4"].entries()) {
    const hz = noteToHz(note);
    const fixture = await openFixture({ tuningId: "standard", frequency: hz });
    const state = await waitForPreset(fixture.page, { peg, note, cents: 0, hz });
    assert.equal(state.activePeg, String(peg), `open ${note}`);
    assert.ok(Math.abs(state.cents) <= 8, `open ${note}: ${state.cents} cents`);
    assertOnlyExpectedPegs(
      await readUiTrace(fixture.page),
      [peg],
      `open ${note}: transient peg`,
    );
    results.openStrings.push({ expected: note, ...state });
    await fixture.context.close();
  }

  {
    const e2 = noteToHz("E2");
    const fixture = await openFixture({
      tuningId: "standard",
      frequency: e2,
      inputGain: 0.0005,
    });
    const state = await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 0,
      hz: e2,
      centsTolerance: 10,
    });
    assert.equal(state.trackerState, "tracking", "low input must acquire tracking");
    assert.ok(
      state.rms >= 0.0002 && state.rms <= 0.0006,
      `low input RMS outside Android fixture range: ${state.rms}`,
    );
    assertOnlyExpectedPegs(
      await readUiTrace(fixture.page),
      [0],
      "low input: transient peg",
    );
    results.lowInput = state;
    await fixture.context.close();
  }

  {
    const e2 = noteToHz("E2");
    const fixture = await openFixture({ tuningId: "standard", frequency: e2 });
    await waitForPreset(fixture.page, { peg: 0, note: "E2", cents: 0, hz: e2 });
    await resetUiTrace(fixture.page);

    // A strong second harmonic may briefly win during a guitar attack. It must
    // not move the UI to another string before the octave candidate is proven.
    await setFrequency(fixture.page, noteToHz("E3"));
    await fixture.page.waitForTimeout(140);
    await setFrequency(fixture.page, e2);
    const state = await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: 0, hz: e2 },
    );
    const trace = await readUiTrace(fixture.page);
    assertOnlyExpectedPegs(trace, [0], "brief E2→E3 octave burst");
    assert.ok(
      trace.some((entry) => entry.tracker.includes("switch-pending")),
      `octave burst never reached switch-pending:\n${formatTrace(trace)}`,
    );
    results.octaveBurst = {
      activePeg: state.activePeg,
      switchPendingObserved: true,
      trace: compactUiTrace(trace),
    };
    await fixture.context.close();
  }

  {
    const e2 = noteToHz("E2");
    const a2 = noteToHz("A2");
    const fixture = await openFixture({ tuningId: "standard", frequency: e2 });
    await waitForPreset(fixture.page, { peg: 0, note: "E2", cents: 0, hz: e2 });

    await setInputGain(fixture.page, 0);

    // Release must dim and hold the last reading, not blank it instantly: a
    // fading string is still being read by the player.
    await fixture.page.waitForFunction(() => {
      const main = document.querySelector("#tunerMain");
      return main?.dataset.trackerState === "idle" && main.dataset.signal === "dim";
    }, null, { timeout: 4_000 });
    const held = await fixture.page.evaluate(() => ({
      atMs: performance.now(),
      activePeg: document.querySelector(".peg.is-active")?.dataset.i ?? null,
      note: `${document.querySelector("#gaugeNote")?.textContent ?? ""}${
        document.querySelector("#gaugeOctave")?.textContent ?? ""
      }`,
    }));
    assert.equal(held.activePeg, "0", "display hold must keep the E2 peg lit");
    assert.equal(held.note, "E2", "display hold must keep the last note visible");

    // ...and the held reading must clear on its own once displayHoldMs passes.
    // The reading survives choppy input for several seconds by design (dim at
    // 3 s, clear at 8 s), so the dim-to-empty stretch is ~5 s.
    await fixture.page.waitForFunction(() => {
      const main = document.querySelector("#tunerMain");
      return main?.dataset.signal === "empty" &&
        document.querySelector(".peg.is-active") === null;
    }, null, { timeout: 9_000 });
    const displayHoldMs =
      (await fixture.page.evaluate(() => performance.now())) - held.atMs;
    assert.ok(
      displayHoldMs >= 3_500 && displayHoldMs <= 6_500,
      `display hold cleared after ${Math.round(displayHoldMs)}ms, expected ~5000ms after dim`,
    );

    await setFrequency(fixture.page, a2);
    await resetUiTrace(fixture.page);
    await setInputGain(fixture.page, 0.05);
    const state = await waitForPreset(
      fixture.page,
      { peg: 1, note: "A2", cents: 0, hz: a2 },
    );
    const trace = await readUiTrace(fixture.page);
    assertOnlyExpectedPegs(trace, [1], "release then A2 reacquisition");
    assert.ok(
      trace.some((entry) => entry.tracker.includes("acquired")),
      `A2 reacquisition was not observed:\n${formatTrace(trace)}`,
    );
    results.releaseReacquire = {
      activePeg: state.activePeg,
      trackerState: state.trackerState,
      displayHoldMs: Math.round(displayHoldMs),
      trace: compactUiTrace(trace),
    };
    await fixture.context.close();
  }

  {
    const e2 = noteToHz("E2");
    const fixture = await openFixture({ tuningId: "standard", frequency: e2 });
    await waitForPreset(fixture.page, { peg: 0, note: "E2", cents: 0, hz: e2 });
    await setFrequency(fixture.page, 1000);
    // A sustained unmatched pitch must clear the stale peg once it has
    // persisted a few frames (isolated unmatched wisps are discarded instead,
    // so the clear is no longer same-frame with the switch event).
    await fixture.page.waitForFunction(() => {
      const main = document.querySelector("#tunerMain");
      return main?.dataset.trackerState === "tracking" &&
        document.querySelector(".peg.is-active") === null &&
        main.dataset.signal === "empty";
    }, null, { timeout: 4_000 });
    const state = await readState(fixture.page);
    assert.equal(state.activePeg, null, "an unmatched confirmed pitch must clear stale peg");
    results.unmatchedSwitch = state;
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

    // A smooth in-note movement remains locked even after crossing the margin.
    const outsideMargin = e2 * 2 ** (300 / 1200);
    await setFrequency(fixture.page, outsideMargin);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: 300, hz: outsideMargin, centsTolerance: 10 },
    ));

    // A separately confirmed cluster re-runs sticky target selection. A2 is
    // now 100 cents closer, so this real note change must move to A2.
    await setFrequency(fixture.page, e2);
    results.sticky.push(await waitForPreset(
      fixture.page,
      { peg: 0, note: "E2", cents: 0, hz: e2 },
    ));
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
    const inactiveButton = await readMicrophoneButton(fixture.page);
    assert.equal(inactiveButton.ariaPressed, null, "start button must not claim toggle semantics");
    assert.equal(inactiveButton.active, "false");
    assert.equal(inactiveButton.label, "チューニング開始");
    await fixture.page.locator('.peg[data-i="0"]').click();
    await fixture.page.locator("#micButton").click();
    await fixture.page.waitForFunction(
      () => document.querySelector("#micButton").textContent === "チューニング停止",
    );
    const activeButton = await readMicrophoneButton(fixture.page);
    assert.equal(activeButton.ariaPressed, null, "stop button must not claim toggle semantics");
    assert.equal(activeButton.active, "true");
    assert.equal(activeButton.label, "チューニング停止");
    const state = await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 1000,
      hz: d3,
      centsTolerance: 10,
    });
    assert.equal(state.manualPeg, "0");
    assert.equal(state.activePeg, "0");
    results.microphoneButtonSemantics = { inactiveButton, activeButton };
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

  for (const layoutCase of [
    { width: 844, height: 390, headstockType: "six-inline", leftHanded: false },
    { width: 667, height: 375, headstockType: "three-three", leftHanded: true },
    { width: 640, height: 360, headstockType: "six-inline", leftHanded: false },
  ]) {
    const context = await browser.newContext({
      viewport: { width: layoutCase.width, height: layoutCase.height },
    });
    await context.addInitScript(({ headstockType, leftHanded }) => {
      localStorage.setItem("tuner.settings", JSON.stringify({
        tuningId: "sevenStandard",
        soundEnabled: false,
        concertAHz: 440,
        headstockType,
        leftHanded,
      }));
    }, layoutCase);
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const layout = await page.evaluate(() => {
      const stage = document.querySelector(".headstock-stage").getBoundingClientRect();
      const labels = [...document.querySelectorAll(".peg:not([hidden]) .peg-label")].map((label) => {
        const bounds = label.getBoundingClientRect();
        return {
          note: label.textContent,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          insideStage:
            bounds.left >= stage.left &&
            bounds.right <= stage.right &&
            bounds.top >= stage.top &&
            bounds.bottom <= stage.bottom,
        };
      });
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        labels,
      };
    });
    assert.equal(layout.labels.length, 7, "seven-string landscape must show seven labels");
    assert.ok(layout.labels.every((label) => label.insideStage), "every label must fit inside the headstock stage");
    assert.equal(layout.scrollWidth, layout.viewportWidth, "landscape layout must not scroll horizontally");
    assert.equal(layout.scrollHeight, layout.viewportHeight, "landscape layout must not scroll vertically");
    results.landscapeLayouts.push(layout);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.click("#settings-open");
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector("#settings-sheet");
      const header = dialog.querySelector(".dialog-header");
      const body = dialog.querySelector(".settings-body");
      const link = dialog.querySelector(".settings-link");
      const dialogBounds = dialog.getBoundingClientRect();
      const headerTop = header.getBoundingClientRect().top;

      body.scrollTop = body.scrollHeight;

      const linkBounds = link.getBoundingClientRect();
      return {
        open: dialog.open,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        bodyScrollTop: body.scrollTop,
        headerStayedFixed: header.getBoundingClientRect().top === headerTop,
        lastControlInsideDialog:
          linkBounds.top >= dialogBounds.top &&
          linkBounds.bottom <= dialogBounds.bottom,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageScrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    assert.equal(layout.open, true, "settings dialog must open");
    assert.ok(
      layout.bodyScrollHeight > layout.bodyClientHeight,
      "short landscape settings must scroll inside the dialog",
    );
    assert.ok(layout.bodyScrollTop > 0, "settings body must accept scrolling");
    assert.equal(layout.headerStayedFixed, true, "settings header must stay fixed");
    assert.equal(layout.lastControlInsideDialog, true, "last settings control must be reachable");
    assert.equal(layout.pageScrollWidth, layout.viewportWidth, "settings must not scroll the page horizontally");
    assert.equal(layout.pageScrollHeight, layout.viewportHeight, "settings must not scroll the page vertically");
    results.settingsDialogLandscape = layout;
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const layout = await page.evaluate(() => {
      const message = document.querySelector("#errorMessage");
      message.className = "error-message is-note";
      message.textContent =
        "Bluetoothマイクは通話品質になります。端末の内蔵マイクへ切り替えて、もう一度お試しください";
      const style = getComputedStyle(message);
      const bounds = message.getBoundingClientRect();
      const lineHeight = Number.parseFloat(style.lineHeight);
      const parseRgb = (value) => value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
      const luminance = (rgb) => {
        const [red, green, blue] = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const foreground = luminance(parseRgb(style.color));
      const background = luminance(parseRgb(getComputedStyle(document.body).backgroundColor));
      const contrast =
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05);

      return {
        lineCount: Math.round(bounds.height / lineHeight),
        fullyVisible:
          message.scrollWidth <= message.clientWidth &&
          message.scrollHeight <= message.clientHeight,
        contrast,
        whiteSpace: style.whiteSpace,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    assert.ok(layout.lineCount >= 2, "long microphone status must wrap on a narrow screen");
    assert.equal(layout.fullyVisible, true, "microphone status must not be clipped");
    assert.ok(layout.contrast >= 4.5, `microphone status contrast too low: ${layout.contrast}`);
    assert.equal(layout.whiteSpace, "normal");
    assert.equal(layout.pageScrollWidth, layout.viewportWidth, "wrapped status must not widen the page");
    results.microphoneStatusLayout = layout;
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.click("#tuningButton");

    const semantics = await page.evaluate(() => {
      const options = [...document.querySelectorAll(".tuning-option")];
      return {
        optionCount: options.length,
        selectedCount: options.filter((option) => option.getAttribute("aria-pressed") === "true").length,
        radioRoleCount: options.filter((option) => option.getAttribute("role") === "radio").length,
        legacyCheckedCount: options.filter((option) => option.hasAttribute("aria-checked")).length,
      };
    });
    assert.ok(semantics.optionCount > 1, "tuning dialog must contain multiple options");
    assert.equal(semantics.selectedCount, 1, "one tuning button must expose its selected state");
    assert.equal(semantics.radioRoleCount, 0, "plain buttons must not claim radio keyboard semantics");
    assert.equal(semantics.legacyCheckedCount, 0, "tuning buttons must not expose aria-checked");

    const lastOption = page.locator(".tuning-option").last();
    const persistedName = (await lastOption.locator("span").first().textContent()).trim();
    await lastOption.click();
    await page.reload({ waitUntil: "networkidle" });
    await page.click("#tuningButton");
    await page.waitForFunction(
      () => document.activeElement?.matches('.tuning-option[aria-pressed="true"]'),
    );
    const persistedSelection = await page.evaluate(() => {
      const list = document.querySelector("#tuningList").getBoundingClientRect();
      const selected = document.querySelector('.tuning-option[aria-pressed="true"]');
      const bounds = selected.getBoundingClientRect();
      return {
        name: selected.querySelector("span").textContent,
        focused: document.activeElement === selected,
        visible: bounds.top >= list.top && bounds.bottom <= list.bottom,
      };
    });
    assert.equal(persistedSelection.name, persistedName, "saved tuning must remain selected");
    assert.equal(persistedSelection.focused, true, "saved tuning must receive focus when the dialog opens");
    assert.equal(persistedSelection.visible, true, "saved tuning must be visible when the dialog opens");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#tuningDialog").open);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "tuningButton",
      "Escape must return focus to the dialog opener",
    );

    await page.click("#tuningButton");
    const target = page.locator(".tuning-option").nth(1);
    const targetName = (await target.locator("span").first().textContent()).trim();
    await target.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("#tuningDialog").open);
    const keyboardResult = await page.evaluate(() => ({
      activeElement: document.activeElement?.id ?? "",
      tuningName: document.querySelector("#tuningButtonName").textContent,
      expanded: document.querySelector("#tuningButton").getAttribute("aria-expanded"),
    }));
    assert.equal(keyboardResult.activeElement, "tuningButton", "focus must return to the dialog opener");
    assert.equal(keyboardResult.tuningName, targetName, "Enter must select the focused tuning");
    assert.equal(keyboardResult.expanded, "false", "the tuning dialog must report its closed state");
    results.tuningDialogKeyboard = {
      ...semantics,
      persistedSelection,
      ...keyboardResult,
    };
    await context.close();
  }

  {
    const e2 = noteToHz("E2");
    const fixture = await openFixture({
      tuningId: "standard",
      frequency: e2 * 2 ** (30 / 1200),
      soundEnabled: true,
      simulateChimeFeedback: true,
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
    await fixture.page.waitForFunction(
      () => document.querySelector("#tunerMain")?.dataset.inputBlanked === "false",
      null,
      { timeout: 2_000 },
    );
    const afterFeedback = await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 0,
      hz: e2,
      centsTolerance: 8,
    });
    const trace = await readUiTrace(fixture.page);
    assertOnlyExpectedPegs(trace, [0], "chime feedback blanking");
    assert.ok(
      trace.some((entry) => entry.inputBlanked === "true"),
      `chime never blanked input:\n${formatTrace(trace)}`,
    );
    assert.ok(
      trace.some((entry) => entry.tracker.includes("chime-blank")),
      `chime blanking was not exposed in debug trace:\n${formatTrace(trace)}`,
    );

    // A natural release must rearm the completion sound for the next string.
    await setInputGain(fixture.page, 0);
    await fixture.page.waitForFunction(
      () => document.querySelector("#tunerMain")?.dataset.trackerState === "idle",
      null,
      { timeout: 4_000 },
    );
    await setInputGain(fixture.page, 0.05);
    await waitForPreset(fixture.page, {
      peg: 0,
      note: "E2",
      cents: 0,
      hz: e2,
      centsTolerance: 8,
    });
    await fixture.page.waitForFunction(
      () => window.__oscillatorStarts === 5,
      null,
      { timeout: 4_000 },
    );
    results.chime = {
      heldMs: Math.round(heldMs),
      afterHold: timing.oscillatorStarts,
      activePegAfterFeedback: afterFeedback.activePeg,
      inputBlankingObserved: true,
      rearmedAfterRelease: true,
    };
    await fixture.context.close();
  }
} finally {
  await browser.close();
}

assert.deepEqual(pageErrors, [], `browser errors:\n${pageErrors.join("\n")}`);
console.log(JSON.stringify(results, null, 2));

async function openFixture({
  tuningId,
  frequency,
  start = true,
  soundEnabled = false,
  inputGain = 0.05,
  simulateChimeFeedback = false,
}) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(({
    tuningId,
    frequency,
    soundEnabled,
    inputGain,
    simulateChimeFeedback,
  }) => {
    localStorage.setItem("tuner.settings", JSON.stringify({
      tuningId,
      soundEnabled,
      concertAHz: 440,
      headstockType: "three-three",
      leftHanded: false,
    }));

    window.__oscillatorStarts = 0;
    window.__firstChimeAt = null;
    window.__inputTargetFrequency = frequency;
    window.__simulateChimeFeedback = simulateChimeFeedback;
    window.__feedbackInjected = false;
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = originalCreateOscillator.apply(this, args);
      const originalStart = oscillator.start.bind(oscillator);
      oscillator.start = (...startArgs) => {
        window.__oscillatorStarts += 1;
        if (window.__oscillatorStarts > 1 && window.__firstChimeAt === null) {
          window.__firstChimeAt = performance.now();
        }
        if (
          window.__oscillatorStarts > 1 &&
          window.__simulateChimeFeedback &&
          !window.__feedbackInjected &&
          window.__tunerRegressionInput
        ) {
          window.__feedbackInjected = true;
          const { inputContext, oscillator: inputOscillator } =
            window.__tunerRegressionInput;
          inputOscillator.frequency.setValueAtTime(880, inputContext.currentTime);
          setTimeout(() => {
            inputOscillator.frequency.setValueAtTime(
              window.__inputTargetFrequency,
              inputContext.currentTime,
            );
          }, 320);
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
      gain.gain.value = inputGain;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await inputContext.resume();
      window.__tunerRegressionInput = { inputContext, oscillator, gain };
      return destination.stream;
    };
  }, { tuningId, frequency, soundEnabled, inputGain, simulateChimeFeedback });

  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      pageErrors.push(message.text());
    }
  });
  await page.goto(new URL("?debug=1", baseUrl).href, { waitUntil: "networkidle" });
  await installUiTrace(page);
  if (start) await page.locator("#micButton").click();
  return { context, page };
}

async function setFrequency(page, frequency) {
  await page.evaluate((hz) => {
    const { inputContext, oscillator } = window.__tunerRegressionInput;
    window.__inputTargetFrequency = hz;
    oscillator.frequency.setValueAtTime(hz, inputContext.currentTime);
  }, frequency);
}

async function readMicrophoneButton(page) {
  return page.locator("#micButton").evaluate((button) => ({
    ariaPressed: button.getAttribute("aria-pressed"),
    active: button.dataset.active,
    label: button.textContent.trim(),
  }));
}

async function setInputGain(page, value) {
  await page.evaluate((gainValue) => {
    const { inputContext, gain } = window.__tunerRegressionInput;
    gain.gain.setValueAtTime(gainValue, inputContext.currentTime);
  }, value);
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

async function installUiTrace(page) {
  await page.evaluate(() => {
    window.__tunerUiTraceObserver?.disconnect();
    window.__tunerUiTrace = [];
    window.__tunerUiTraceStartedAt = performance.now();

    const record = () => {
      const main = document.querySelector("#tunerMain");
      const entry = {
        atMs: Math.round(performance.now() - window.__tunerUiTraceStartedAt),
        activePeg: document.querySelector(".peg.is-active")?.dataset.i ?? null,
        trackerState: main?.dataset.trackerState ?? "",
        tracker: document.querySelector("#debugTracker")?.textContent ?? "",
        inputBlanked: main?.dataset.inputBlanked ?? "false",
        note: `${document.querySelector("#gaugeNote")?.textContent ?? ""}${
          document.querySelector("#gaugeOctave")?.textContent ?? ""
        }`,
      };
      const previous = window.__tunerUiTrace.at(-1);
      const signature = JSON.stringify({ ...entry, atMs: 0 });
      const previousSignature = previous
        ? JSON.stringify({ ...previous, atMs: 0 })
        : null;
      if (signature !== previousSignature) window.__tunerUiTrace.push(entry);
    };

    window.__tunerUiTraceObserver = new MutationObserver(record);
    window.__tunerUiTraceObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-tracker-state", "data-input-blanked"],
    });
    record();
  });
}

async function resetUiTrace(page) {
  await page.evaluate(() => {
    window.__tunerUiTrace = [];
    window.__tunerUiTraceStartedAt = performance.now();
  });
}

async function readUiTrace(page) {
  // Let the MutationObserver flush changes made in the preceding animation frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  return page.evaluate(() => window.__tunerUiTrace ?? []);
}

function assertOnlyExpectedPegs(trace, expectedPegs, label) {
  const expected = new Set(expectedPegs.map(String));
  const wrong = trace.filter(
    (entry) => entry.activePeg !== null && !expected.has(entry.activePeg),
  );
  assert.deepEqual(wrong, [], `${label}:\n${formatTrace(trace)}`);
}

function compactUiTrace(trace) {
  return trace.map(({ atMs, activePeg, tracker, inputBlanked }) => ({
    atMs,
    activePeg,
    tracker,
    inputBlanked,
  }));
}

function formatTrace(trace) {
  return JSON.stringify(compactUiTrace(trace), null, 2);
}

async function readState(page) {
  return page.evaluate(() => ({
    note: `${document.querySelector("#gaugeNote")?.textContent ?? ""}${document.querySelector("#gaugeOctave")?.textContent ?? ""}`,
    cents: Number(document.querySelector("#debugCents")?.textContent),
    rawHz: Number(document.querySelector("#debugRaw")?.textContent),
    stableHz: Number(document.querySelector("#debugStable")?.textContent),
    clarity: Number(document.querySelector("#debugClarity")?.textContent),
    rms: Number(document.querySelector("#debugRms")?.textContent),
    correction: document.querySelector("#debugCorrection")?.textContent ?? "",
    direction: document.querySelector("#tunerMain")?.dataset.direction ?? "",
    hintUp: !document.querySelector("#gaugeHintUp")?.hasAttribute("hidden"),
    hintDown: !document.querySelector("#gaugeHintDown")?.hasAttribute("hidden"),
    hintCheck: !document.querySelector("#gaugeHintCheck")?.hasAttribute("hidden"),
    trackerState: document.querySelector("#tunerMain")?.dataset.trackerState ?? "",
    tracker: document.querySelector("#debugTracker")?.textContent ?? "",
    inputBlanked: document.querySelector("#tunerMain")?.dataset.inputBlanked ?? "false",
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
