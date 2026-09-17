// Headless smoke test for ARRIVE — the screen-enter dip to black, DESIGN-V2.md
// §2.7. One plate (#arrive-plate), one rule (styles.css), one hook (arrive() at
// the foot of showRoute() in app.js).
//
// WHY THIS EXISTS, and it is not "more coverage". ARRIVE landed with a comment
// block in app.js that said "MEASURED in headless Comet" four separate times,
// named the counts it had measured, and cited **this file** by name. This file
// did not exist. Every one of those numbers was a sentence somebody had typed:
//
//     animationend 1, animationcancel 1, hidden set exactly once     unproven
//     under `reduce` the plate never leaves display:none             unproven
//     a cancelled fade strands the plate, permanently                unproven
//     the stranded plate computes to opacity 0                       unproven
//     the plate covers the 900-z-index audio bar, 0 lit pixels       unproven
//
// A measurement that lives only in a comment is a measurement nobody can
// re-take, and the one in styles.css had already rotted in exactly that way —
// it carried an audio-bar height of "51px" that re-measuring read as 117px at
// 1440x900. The number was invented inside a real finding. So the rule here is
// that every claim either has a line in this file that takes it again, or it
// comes out of the comment.
//
// WHAT IS DELIBERATELY NOT MEASURED HERE. Not "does the fade look right" — a
// 220ms linear opacity ramp has no shape a harness can judge, and §2.7's
// duration lives in one custom property that this file reads back rather than
// re-types. What is measured is the STATE MACHINE around it, because that is
// what strands a full-screen black rectangle over a television: who raises the
// plate, who lowers it, and what lowers it when the thing that normally does
// never fires.
//
//   node arrive.smoke.mjs
//   BW_DIR=/path/to/checkout node arrive.smoke.mjs    any other checkout
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, p === '/' ? 'index.html' : p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// THE DEADMAN'S LENGTH IS READ OUT OF app.js, never re-typed here. A harness
// that carries its own copy of a product constant passes on the day the product
// changes it, which is the one day it needed to fail.
const source = await readFile(join(ROOT, 'app.js'), 'utf8');
const DEADMAN_MS = Number((source.match(/const ARRIVE_DEADMAN_MS\s*=\s*(\d+)/) || [])[1]);

const PIX = 'https://img.invalid/poster.jpg';
const META = (n, pre) => ({
  metas: Array.from({ length: n }, (_, i) => ({
    id: `tt800${i}0`, name: `${pre} ${i + 1}`, type: 'movie', poster: PIX, releaseInfo: '2026',
  })),
});

// A saved audio track, seeded the way media-library.js writes one, so the
// persistent mini-player at z-index 900 is really alive during a route change.
// That bar is the whole reason the plate sits at 1000 instead of 90, and a
// fixture without it would prove the census against an app that has no layer
// above the plate to begin with.
const MEDIA_KEY = 'blazing-media-progress-v1:p1';
const MEDIA_PROGRESS = JSON.stringify({
  books: {},
  audio: { 'archive:blazing-test-album/01': 42 },
  last: {
    kind: 'music',
    parentId: 'archive:blazing-test-album',
    trackId: 'archive:blazing-test-album/01',
    title: 'A saved track',
  },
});

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

/**
 * The recorder, installed once per page.
 *
 * `hidden` is watched with attributeOldValue rather than by reading el.hidden
 * inside the callback: MutationObserver batches its records into one microtask,
 * so a raise and a lower inside the same task would both read back the FINAL
 * value and the pair would look like two lowers. oldValue is the only exact
 * answer — null means the attribute was absent and has just been added (the
 * plate went DOWN), a string means it was present and has just been removed or
 * re-set (the plate came UP).
 */
const INSTRUMENT = () => {
  const el = document.getElementById('arrive-plate');
  const rec = { start: 0, end: 0, cancel: 0, marks: [], t0: performance.now() };
  window.__arrive = {
    reset() { rec.start = 0; rec.end = 0; rec.cancel = 0; rec.marks.length = 0; rec.t0 = performance.now(); },
    read: () => JSON.parse(JSON.stringify(rec)),
    plate: () => el,
  };
  el.addEventListener('animationstart', () => { rec.start += 1; });
  el.addEventListener('animationend', () => { rec.end += 1; });
  el.addEventListener('animationcancel', () => { rec.cancel += 1; });
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.attributeName !== 'hidden') continue;
      rec.marks.push({ up: m.oldValue !== null, t: Math.round(performance.now() - rec.t0) });
    }
  }).observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ['hidden'] });
};

/** Every origin this app talks to, stubbed. The same set navparity.smoke.mjs uses. */
async function stub(ctx) {
  await ctx.addInitScript(([key, progress]) => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-1', token: 'tok' }));
    localStorage.setItem('blazing-household-approved', '1');
    localStorage.setItem(key, progress);
  }, [MEDIA_KEY, MEDIA_PROGRESS]);
  await ctx.route('https://addon.lyreosai.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'no' });
    if (u.includes('/manifest.json')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ catalogs: [{ id: 'blazing-movies', type: 'movie', name: 'Movies' }] }) });
    if (u.includes('/api/sync/progress/recent')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    if (u.includes('/catalog/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'cat')) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const u = route.request().url();
    if (u.includes('/devices/register')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, device: { id: 'dev-1', status: 'approved' }, token: 'tok' }) });
    if (u.includes('/profiles')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ profiles: [{ id: 'p1', name: 'Mark', maxRating: 'adult', hasPin: false }] }) });
    if (u.includes('/discover/filter/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META(6, 'fresh')) });
    if (u.includes('/media/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    if (u.includes('/emby/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"metas":[]}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await ctx.route('https://upscale.lyreosai.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('https://v3-cinemeta.strem.io/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"addons":[]}' }));
}

/** Load, choose a profile the way a person does, and wait for the app to settle. */
async function open(ctx, errors) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const tile = page.locator('.bp-profile').first();
  if (await tile.count()) { await tile.click(); await page.waitForTimeout(2200); }
  await page.evaluate(INSTRUMENT);
  return page;
}

const errors = [];
const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await stub(ctx);
const page = await open(ctx, errors);

ok(Number.isInteger(DEADMAN_MS) && DEADMAN_MS > 0,
  'app.js declares ARRIVE_DEADMAN_MS, and this harness reads it rather than re-typing it', `(${DEADMAN_MS}ms)`);

// The one duration, read back off the live custom property. If the motion table
// is ever edited the waits below follow it instead of going quietly stale.
const ARRIVE_MS = await page.evaluate(() =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-arrive')) || 0);
ok(ARRIVE_MS > 0 && ARRIVE_MS < DEADMAN_MS,
  '--dur-arrive resolves, and the deadman is longer than the fade it rescues', `(${ARRIVE_MS}ms fade / ${DEADMAN_MS}ms deadman)`);

// ── 1. A route change raises the plate; animationend puts it back down ──────
await page.evaluate(() => window.__arrive.reset());
await page.evaluate(() => document.querySelector('.drawer-nav [data-view="movies"], [data-view="movies"]').click());
await page.waitForTimeout(ARRIVE_MS + 500);
const one = await page.evaluate(() => ({
  ...window.__arrive.read(),
  down: document.getElementById('arrive-plate').hidden,
  arriving: document.getElementById('arrive-plate').classList.contains('arriving'),
}));
const seq = (r) => r.marks.map((h) => (h.up ? 'up' : 'down')).join(' -> ');
ok(seq(one) === 'up -> down', 'one route change: the plate goes up, then back down, once each', `(${seq(one) || 'nothing moved'})`);
ok(one.start === 1 && one.end === 1 && one.cancel === 0,
  'and it is animationend that lowers it, not a timer', `(start ${one.start}, end ${one.end}, cancel ${one.cancel})`);
ok(one.down && !one.arriving, 'the plate is left hidden with the class off');

// ── 2. Two route changes 80ms apart ─────────────────────────────────────────
// The precise measurement the app.js comment asserts: animationend 1,
// animationcancel 1, and `hidden` set exactly once. The second arrive() removes
// the class and adds it again, which cancels the running animation rather than
// ending it, and re-setting `hidden = false` on an element whose attribute is
// already absent is not a mutation at all — so the pair costs one cancel and
// still lands on exactly one raise and one lower.
await page.evaluate(() => window.__arrive.reset());
await page.evaluate(async () => {
  document.querySelector('[data-view="shows"]').click();
  await new Promise((r) => setTimeout(r, 80));
  document.querySelector('[data-view="anime"]').click();
});
await page.waitForTimeout(ARRIVE_MS + 600);
const two = await page.evaluate(() => ({ ...window.__arrive.read(), down: document.getElementById('arrive-plate').hidden }));
ok(two.end === 1 && two.cancel === 1,
  'two route changes 80ms apart: animationend 1, animationcancel 1', `(end ${two.end}, cancel ${two.cancel}, start ${two.start})`);
ok(two.marks.filter((h) => !h.up).length === 1 && two.marks.filter((h) => h.up).length === 1,
  'and `hidden` is set exactly once across the pair', `(${seq(two)})`);
ok(two.down, 'the plate is down when the pair is over');

// ── 3. THE DEADMAN ──────────────────────────────────────────────────────────
// Cancel the running animation so `animationend` can never fire, then watch
// what puts the plate away. The comment says that without the timer the plate
// stayed display:block with `.arriving` still on it and was STILL THERE two
// seconds later; both halves are taken here — the strand, and the rescue.
// reset() re-zeroes the recorder's clock, so every `t` below is milliseconds
// since immediately before the click that raises the plate.
await page.evaluate(() => window.__arrive.reset());
await page.evaluate(() => document.querySelector('[data-view="library"]').click());
await page.waitForTimeout(60);
const stranded = await page.evaluate(() => {
  const el = document.getElementById('arrive-plate');
  const live = el.getAnimations();
  live.forEach((a) => a.cancel());
  const cs = getComputedStyle(el);
  return {
    cancelled: live.length,
    hidden: el.hidden,
    arriving: el.classList.contains('arriving'),
    display: cs.display,
    opacity: cs.opacity,
    animations: el.getAnimations().length,
  };
});
ok(stranded.cancelled === 1 && stranded.animations === 0,
  'the running fade can be cancelled outright, and nothing restarts it', `(cancelled ${stranded.cancelled}, left ${stranded.animations})`);
ok(!stranded.hidden && stranded.arriving && stranded.display === 'block',
  'a cancelled fade STRANDS the plate: display:block with .arriving still on it',
  `(display ${stranded.display}, .arriving ${stranded.arriving})`);
// The cost of that strand, and the reason it is a parked layer rather than a
// black television: the base rule is opacity 0 and only the animation's fill
// ever raised it, so cancelling drops the fill and the plate computes to 0.
ok(stranded.opacity === '0', 'and the stranded plate computes to opacity 0 — a parked layer, not a black screen', `(opacity ${stranded.opacity})`);

// Nothing but the deadman can lower it now. Sample once well before it is due,
// so a pass here cannot be something else putting the plate away early.
await page.waitForTimeout(Math.max(0, DEADMAN_MS * 0.5 - 60));
const midway = await page.evaluate(() => ({
  down: document.getElementById('arrive-plate').hidden,
  ...window.__arrive.read(),
}));
ok(!midway.down && midway.end === 0,
  'halfway to the deadman the plate is still up, and animationend never fired', `(end ${midway.end})`);

await page.waitForTimeout(DEADMAN_MS * 0.5 + 500);
const rescued = await page.evaluate(() => {
  const el = document.getElementById('arrive-plate');
  return { down: el.hidden, arriving: el.classList.contains('arriving'), ...window.__arrive.read() };
});
const downRecord = rescued.marks.find((h) => !h.up);
const downMs = downRecord ? downRecord.t : -1;
ok(rescued.down && !rescued.arriving && rescued.end === 0,
  'THE DEADMAN: with animationend dead, the timer puts the plate away anyway', `(down after ${downMs}ms, animationend ${rescued.end})`);
ok(downMs > 0 && downMs <= DEADMAN_MS + 400,
  'and it does it within ARRIVE_DEADMAN_MS + margin', `(${downMs}ms vs ${DEADMAN_MS}ms)`);

// ── 4. The live path that produces that strand ──────────────────────────────
// A viewer flipping the OS reduced-motion switch mid-fade. macOS toggles it
// live; styles.css's `reduce` override then sets `animation: none` on
// `.arriving`, which CANCELS the running animation, and app.js's listener is
// never called again. This is the case the comment names, taken through the
// media query rather than through a hand-cancel.
await page.evaluate(() => window.__arrive.reset());
await page.evaluate(() => document.querySelector('[data-view="games"]').click());
await page.waitForTimeout(60);
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.waitForTimeout(80);
const flipped = await page.evaluate(() => ({
  ...window.__arrive.read(),
  down: document.getElementById('arrive-plate').hidden,
  animations: document.getElementById('arrive-plate').getAnimations().length,
}));
ok(flipped.cancel === 1 && flipped.end === 0 && flipped.animations === 0 && !flipped.down,
  'flipping prefers-reduced-motion mid-fade cancels the animation and strands the plate',
  `(cancel ${flipped.cancel}, end ${flipped.end})`);
await page.waitForTimeout(DEADMAN_MS + 500);
const flippedDown = await page.evaluate(() => ({
  down: document.getElementById('arrive-plate').hidden, ...window.__arrive.read(),
}));
ok(flippedDown.down && flippedDown.end === 0,
  'and the deadman rescues that one too — the named live path, not a synthetic cancel');
await page.emulateMedia({ reducedMotion: 'no-preference' });

// ── 5. The audio bar, and the pixel census behind z-index 1000 ──────────────
// styles.css puts the plate at 1000 because of ONE element: media-library.js's
// persistent mini-player at 900, which leave() never hides, so it is the only
// layer in the product that is both above the old z-index and alive during a
// route change. Walk into the books room to bring it to life, walk back out so
// it is genuinely surviving a navigation, then read back every pixel the plate
// claims to cover.
await page.evaluate(() => document.querySelector('[data-view="books"]').click());
await page.waitForTimeout(1200);
const bar = await page.evaluate(() => {
  const host = document.getElementById('media-player-host');
  const box = host.getBoundingClientRect();
  return { hidden: host.hidden, z: getComputedStyle(host).zIndex, h: Math.round(box.height), w: Math.round(box.width) };
});
ok(!bar.hidden && bar.z === '900' && bar.h > 0,
  'the saved track brings up the persistent audio bar at z-index 900', `(${bar.w}x${bar.h}, z ${bar.z})`);

// Walk back out of the books room and check the bar DURING the dip, not after.
await page.evaluate(() => window.__arrive.reset());
await page.evaluate(() => document.querySelector('[data-view="movies"]').click());
await page.waitForTimeout(Math.min(80, ARRIVE_MS / 2));
const duringDip = await page.evaluate(() => {
  const host = document.getElementById('media-player-host');
  const plate = document.getElementById('arrive-plate');
  return {
    barHidden: host.hidden,
    barPainting: host.getBoundingClientRect().height > 0,
    plateUp: !plate.hidden && plate.classList.contains('arriving'),
  };
});
ok(!duringDip.barHidden && duringDip.barPainting && duringDip.plateUp,
  'leaving the books room does not hide the bar: it is alive underneath a raised plate');
await page.waitForTimeout(ARRIVE_MS + 600);

// Freeze the plate at opacity 1 and read the viewport back. The fade itself is
// never screenshotted — a 220ms ramp caught at an arbitrary frame would make
// the census depend on shutter timing. What is being proven is COVERAGE.
const rect = await page.evaluate(() => {
  const el = document.getElementById('arrive-plate');
  el.hidden = false;
  el.style.opacity = '1';
  const box = el.getBoundingClientRect();
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
});
const png = (await page.screenshot({ clip: rect })).toString('base64');
const census = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0, brightest = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(data[i], data[i + 1], data[i + 2]);
    if (v > brightest) brightest = v;
    if (v > 8) lit += 1;
  }
  return { w: canvas.width, h: canvas.height, pixels: canvas.width * canvas.height, lit, brightest };
}, png);
ok(census.lit === 0,
  'with the plate up, EVERY pixel it covers is black — the 900 bar included',
  `(${census.pixels.toLocaleString('en-US')} pixels at ${census.w}x${census.h}, ${census.lit} lit, brightest channel ${census.brightest})`);

// The census is only worth anything while nothing else is declared above the
// plate. Enumerate the live stacking order so a future layer is NAMED here
// rather than discovered on a television.
const above = await page.evaluate(() => [...document.querySelectorAll('*')]
  .map((el) => ({ id: el.id, cls: String(el.className || '').split(' ')[0], z: getComputedStyle(el).zIndex }))
  .filter((e) => e.z !== 'auto' && Number(e.z) >= 1000)
  .map((e) => `${e.id || e.cls || '?'}@${e.z}`));
ok(above.length === 1 && above[0] === 'arrive-plate@1000',
  'nothing in the live document is declared at or above the plate', `(${above.join(', ') || 'none'})`);
await page.evaluate(() => {
  const el = document.getElementById('arrive-plate');
  el.style.removeProperty('opacity');
  el.hidden = true;
});

// ── 6. prefers-reduced-motion: an instant cut, both halves ──────────────────
// A fresh context, because this is a viewer whose OS says `reduce` before the
// app ever loads, not one who flipped it mid-session — that case is §4 above.
const reduceCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await stub(reduceCtx);
const reducePage = await open(reduceCtx, errors);

// The JS half: arrive() early-returns, so the class is never added and there is
// nothing to tear down. Four frames of a real route change, sampled with rAF
// rather than a timeout, because the question is whether the plate is ever
// painted at all — and a single sample after the fact cannot answer it.
const frames = await reducePage.evaluate(() => new Promise((resolve) => {
  const el = document.getElementById('arrive-plate');
  const out = [];
  const step = () => {
    const cs = getComputedStyle(el);
    out.push({ display: cs.display, opacity: cs.opacity, arriving: el.classList.contains('arriving'), hidden: el.hidden });
    if (out.length < 4) requestAnimationFrame(step); else resolve(out);
  };
  document.querySelector('[data-view="movies"]').click();
  requestAnimationFrame(step);
}));
ok(frames.length === 4 && frames.every((f) => f.display === 'none'),
  'under reduce the plate never leaves display:none across four frames of a real route change',
  `(${frames.map((f) => f.display).join(', ')})`);
ok(frames.every((f) => !f.arriving && f.hidden),
  'the JS half: arrive() never adds the class, so nothing animates and nothing needs tearing down');

// The CSS half, which is the belt for a viewer who flips the switch while the
// app is open. Force the class on and read what the cascade answers.
const cssHalf = await reducePage.evaluate(() => {
  const el = document.getElementById('arrive-plate');
  el.hidden = false;
  el.classList.add('arriving');
  const cs = getComputedStyle(el);
  const out = { animationName: cs.animationName, opacity: cs.opacity, animations: el.getAnimations().length };
  el.classList.remove('arriving');
  el.hidden = true;
  return out;
});
ok(cssHalf.animationName === 'none' && cssHalf.opacity === '0' && cssHalf.animations === 0,
  'the CSS half: even with .arriving forced on, reduce leaves animation:none and opacity 0',
  `(animation-name ${cssHalf.animationName}, opacity ${cssHalf.opacity})`);

ok(errors.length === 0, 'no page threw while the plate was driven through every one of these', errors.slice(0, 2).join(' ; '));

await reduceCtx.close();
await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
