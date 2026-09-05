// The browser every harness in this repo uses. It is COMET, headless.
//
// WHY THIS FILE EXISTS. Until it landed, all 19 `*.smoke.mjs` in this repo
// opened with the same two lines:
//
//     import { chromium } from 'playwright';
//     const browser = await chromium.launch();
//
// which downloads and runs Google's Chrome for Testing. One `npm test` bounced
// the Chrome icon in Markus's Dock nineteen times. He has said, repeatedly and
// in ~/CLAUDE.md, that this machine drives COMET and nothing else: "it makes no
// sense to use something that i dont use my self."
//
// The carve-out that used to excuse exactly these files — "*.smoke.mjs may use
// headless Chromium against a localhost fixture, because driving them through
// Comet would open test pages in his own browser" — was DELETED on 3 Sep 2026,
// because headless Comet was measured working that day. A scratch
// `--user-data-dir` means his profile is never touched and no window ever
// opens. There is nothing left for Chromium to do here.
//
// ---------------------------------------------------------------- THE FLAGS
// `--headless=new` is the whole trick, and getting it wrong is why four
// separate sessions wrote down "Comet cannot be headless":
//
//   bare `--headless`     IGNORED by Comet. Boots the full visible Perplexity
//                         onboarding AND PLAYS AUDIO OUT LOUD.
//   chromium.launch({executablePath: comet, headless: true})
//                         HANGS — Playwright emits the bare flag.
//   chromium.launch({..., args:['--headless=new']})
//                         Starts, but measured 37% FLAKY (5 pass / 3 fail over
//                         8 identical runs). launch() returns as soon as it
//                         sees "DevTools listening on ws://…" on stderr, and
//                         Comet prints that BEFORE it can serve a page.
//
// So: spawn it ourselves, then poll /json/version until it really answers, then
// connectOverCDP. That path measured 8 pass / 0 fail and is faster. Do NOT
// "simplify" this back into a launch() call — it will pass one manual test and
// then fail one run in three in a harness people trust.
//
// **NEVER add `--disable-gpu`.** It reads like a safe headless flag and it
// silently switches h264 OFF: with it, 0 frames decode and the video element
// reports DECODER_ERROR_NOT_SUPPORTED. `canPlayType()` still answers "probably"
// either way, so a capability check never catches it and a video page just
// screenshots its poster frame and reads as a pass.
//
// ------------------------------------------------------------------- AND CI
// The GitHub runner in .github/workflows/pages.yml is Linux and has no Comet
// at all, so a hard failure there would take out the gate in front of the live
// site. The split is therefore drawn at the OS, not at a preference:
//
//   macOS  — Comet, or throw. This machine can never open Chrome.
//   other  — Playwright's bundled chromium, with a line saying why.
//
// That keeps his Dock quiet and keeps the deploy gate real. It is the only
// branch in this file and it is deliberate.

// Playwright is resolved leniently on purpose. This same file is vendored into
// `samsunt tv/test/` and `blazing-webos/test/`, and those two repos have no
// playwright of their own — every harness in them imported it from an absolute
// path under ~/.hermes. Try the normal resolution first so CI and this repo
// work, and fall back to that path so the other two keep running.
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs')); }

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const COMET_BIN = '/Applications/Comet.app/Contents/MacOS/Comet';

/** His visible browser. Never spawn on this port, never write to that profile. */
const HIS_PORT = 9222;

/**
 * Port 0 lets the OS pick, which NARROWS the race with another agent doing the
 * same thing — it does not close it, because this listener is closed before
 * Comet binds. Two parallel runs can still be handed the same port; that
 * surfaces as the CDP timeout below, not as a wrong page.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until the browser can really serve a page, not just until it said so. */
async function cdpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = await res.json();
        if (body.webSocketDebuggerUrl) return body;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * A drop-in for `await chromium.launch()`.
 *
 * Returns a Playwright Browser with the SAME shape the harnesses already use —
 * `newContext()`, `newPage()`, `close()` — so a harness converts by changing
 * its import and that one line, and nothing else. Verified: `newContext()` does
 * work over connectOverCDP against Comet 151.0.7922.247.
 *
 * `close()` is overridden to also kill Comet and delete the scratch profile.
 * The kill is on the PROCESS GROUP: `child.kill()` alone leaves the renderer,
 * GPU and network helpers running — measured 3 descendants before, 2 still
 * alive after.
 */
export async function launchBrowser({ timeoutMs = 30000, extraArgs = [] } = {}) {
  if (process.platform !== 'darwin' || !existsSync(COMET_BIN)) {
    if (process.platform === 'darwin') {
      throw new Error(
        `Comet is not at ${COMET_BIN}. This machine drives Comet and nothing else — ` +
        'do NOT fall back to Chrome or Chromium here. Install Comet, or run this harness on CI.',
      );
    }
    console.log('[comet] not macOS — using Playwright chromium (CI has no Comet).');
    return chromium.launch();
  }

  const port = await freePort();
  if (port === HIS_PORT) throw new Error('refusing to spawn on 9222 — that is his visible browser');

  const profile = mkdtempSync(path.join(tmpdir(), 'blazing-smoke-comet-'));
  const child = spawn(COMET_BIN, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // THESE THREE ARE NOT OPTIONAL, and leaving them out cost a real regression.
    //
    // `chromium.launch()` passes them for you. Spawning the browser by hand
    // does not, and a headless page with no window is treated as BACKGROUNDED —
    // so Chrome clamps its timers. `samsunt tv/test/comics.smoke.mjs` waits
    // 1500ms for a 1-second retryAfterSec to elapse and repaint; without these
    // the retry timer had not fired yet and two assertions went red, on a file
    // whose product code had not changed at all.
    //
    // Any harness that waits on a setTimeout, an interval, a debounce or a
    // poll depends on this. It is the price of spawn-and-attach, and it is
    // paid here once rather than debugged again per suite.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...extraArgs,
  ], { stdio: 'ignore', detached: true });

  // Kill the GROUP, not the leader. Safe to call twice.
  let stopped = false;
  const hardStop = () => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* nothing to remove */ }
  };

  const info = await cdpReady(port, timeoutMs);
  if (!info) {
    hardStop();
    throw new Error(`Comet did not answer CDP on 127.0.0.1:${port} within ${timeoutMs}ms`);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const disconnect = browser.close.bind(browser);
  // Shadow the prototype method so every existing `await browser.close()` also
  // reaps the process group and the scratch profile. Without this the harness
  // ends green and leaves a headless Comet running for ever.
  browser.close = async () => {
    try { await disconnect(); } catch { /* the browser may already be gone */ }
    hardStop();
  };
  // A harness that throws never reaches its close(). Without this the failure
  // leaks a browser per run, and a red suite is exactly when that happens most.
  process.once('exit', hardStop);
  return browser;
}

export default launchBrowser;
