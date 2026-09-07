/**
 * A returning viewer is re-selected, and EVERY module hears about it.
 *
 * WHY THIS FILE EXISTS. app.js grew a restore that set its own state.profileId
 * and told nobody. It shipped, and the home screen came back to life — 22 rows
 * and 2263 cards on the live site — while everything behind it stayed blind:
 *
 *     BlazingStreamPreferences.current().profileId   null
 *     BlazingStreamPreferences.query()               ""
 *     localStorage.profileId                         null
 *     the profile gate                               still open, over content
 *
 * Every module in this app learns who is watching from ONE event,
 * 'blazing-profile-selected', and only profile.js's selectProfile() sends it.
 * An assignment is not a selection. What that cost, all reported by Markus in
 * one message and all the same bug:
 *
 *   - "no streams loaded" on a film the addon answers with 229 real sources,
 *     because resolveStreams() throws 'Choose a profile first.' when
 *     preferences.profileId !== state.profileId.
 *   - "you cant click to toggle the audio", because stream-preferences.js
 *     mounts those selects and had no viewer to mount them for.
 *   - "the books search didn't populate anything", because mediaRequest()
 *     needs state.activeProfile and state.credentials, which live in profile.js.
 *
 * So this suite does not check that a variable got set. It checks the four
 * things a restore is FOR, and it checks the two cases a restore must refuse.
 *
 *   node profile-restore.smoke.mjs
 */
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const raw = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // extname('/') is '', so serving the bare root as octet-stream makes the
  // browser DOWNLOAD the page instead of rendering it, and goto() throws
  // "Download is starting". Resolve the name first, then read its extension.
  const name = raw === '/' ? 'index.html' : raw;
  try {
    const body = await readFile(join(ROOT, name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`ok    ${label}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const ART = 'https://images.example.test/p.png';
const TITLE = {
  id: 'tt777', name: 'Restore Fixture', type: 'movie', poster: ART, background: ART,
  description: 'A title used to prove sources resolve for a restored viewer.', contentRating: 'general',
};
const NO_PIN = { id: 'p1', name: 'Mark', maxRating: 'adult', allowAdult: true, isKids: false, hasPin: false };
const WITH_PIN = { ...NO_PIN, hasPin: true };
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const REMEMBERED = (id) => ({
  id, maxRating: 'adult', isKids: false, neededPin: false, allowAdult: true, savedAt: Date.now(),
});

/**
 * One browser, one remembered session, one server-side profile list.
 * `profiles` is what the SERVER says exists — the restore must obey it, not the
 * remembered copy, or a deleted profile could be replayed out of localStorage.
 */
async function run(browser, { remembered, profiles }) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  const seen = [];
  await ctx.addInitScript((session) => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-r', token: 'tok-r' }));
    localStorage.setItem('blazing-household-approved', '1');
    if (session) localStorage.setItem('blazing-web-profile-session-v1', JSON.stringify(session));
  }, remembered);

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === base) return route.continue();
    seen.push({ path: url.pathname, search: url.search, headers: req.headers() });
    if (req.resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(join(ROOT, 'icon-192.png')) });
    }
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles') return json(route, { profiles });
      if (url.pathname === '/accounts/me') {
        return json(route, { account: { id: 'acc-r' }, device: { id: 'dev-r', enrollmentStatus: 'approved' } });
      }
      if (url.pathname === '/media/books') {
        // The 403 the real fleet returns when the caller cannot say who it is.
        if (!url.searchParams.get('profileId') || !url.searchParams.get('deviceId')) {
          return json(route, { error: 'profile-required' }, 403);
        }
        return json(route, { items: [{ id: 'b1', title: 'Men Are from Mars, Women Are from Venus', poster: ART }] });
      }
      return json(route, { profiles: [], items: [], metas: [] });
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') {
        return json(route, { catalogs: [{ id: 'restore', type: 'movie', name: 'Restore fixtures' }] });
      }
      if (url.pathname === '/catalog/movie/restore.json') return json(route, { metas: [TITLE] });
      if (url.pathname.startsWith('/meta/')) return json(route, { meta: TITLE });
      if (url.pathname.startsWith('/stream/')) {
        return json(route, { streams: [{
          name: 'Fixture 1080p', title: 'Restore.Fixture.1080p.x264.mkv',
          url: 'https://cdn.example.test/restore.mkv',
        }] });
      }
      return json(route, { catalogs: [], metas: [], streams: [] });
    }
    return json(route, { metas: [], items: [], streams: [], events: [] });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const faults = [];
  page.on('pageerror', (e) => faults.push(e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { ctx, page, seen, faults };
}

const browser = await launchBrowser({ timeoutMs: 120000 });
try {
  // ── 1. THE RESTORE ────────────────────────────────────────────────────────
  {
    const { ctx, page, seen, faults } = await run(browser, {
      remembered: REMEMBERED('p1'), profiles: [NO_PIN],
    });

    // No click anywhere below this line. That is the whole point.
    await page.waitForFunction(
      () => window.BlazingStreamPreferences?.current().profileId === 'p1',
      null, { timeout: 20000 },
    ).catch(() => {});

    const after = await page.evaluate(() => ({
      prefsProfileId: window.BlazingStreamPreferences?.current().profileId ?? null,
      query: window.BlazingStreamPreferences?.query() ?? null,
      storedProfileId: localStorage.getItem('profileId'),
      gateOpen: document.querySelector('.bp-layer')?.hidden === false,
      connect: document.querySelector('.bp-connect')?.textContent?.trim() || '',
    }));

    ok(after.prefsProfileId === 'p1',
      'the preferences module is TOLD who is watching — without this every resolveStreams() throws',
      String(after.prefsProfileId));
    ok(typeof after.query === 'string' && after.query.length > 0,
      'so it builds a real ?audio=&sub= query instead of an empty string', JSON.stringify(after.query));
    ok(after.storedProfileId === 'p1',
      'localStorage.profileId is written, which is what the next load and the sync path read',
      String(after.storedProfileId));
    ok(after.gateOpen === false,
      'and the gate CLOSES ITSELF — it used to sit open on top of a fully drawn home screen');
    ok(/Mark/.test(after.connect),
      'the header names the restored viewer rather than offering "Sign in"', after.connect);

    // ── the audio/subtitle selects, and real sources ───────────────────────
    await page.getByRole('button', { name: `View ${TITLE.name}`, exact: true }).first().click();
    await page.locator('#detail-streams .stream-row').first().waitFor({ timeout: 20000 }).catch(() => {});
    const detail = await page.evaluate(() => ({
      selects: document.querySelectorAll('#detail-stream-preferences select').length,
      sources: document.querySelectorAll('#detail-streams .stream-row').length,
      status: document.querySelector('#detail-status')?.textContent?.trim() || '',
    }));
    ok(detail.selects >= 2,
      'the audio and subtitle selects are MOUNTED — "you cant click to toggle the audio" was them never being drawn',
      `${detail.selects} selects`);
    ok(detail.sources >= 1, 'and the title lists its sources', `${detail.sources} rows`);
    ok(!/No compatible stream available/i.test(detail.status),
      'so the detail page does NOT claim "No compatible stream available." for a title that has sources',
      JSON.stringify(detail.status));
    const streamCall = seen.find((r) => r.path.startsWith('/stream/'));
    ok(Boolean(streamCall), 'a source request actually went out');
    ok(Boolean(streamCall && /audio=/.test(streamCall.search)),
      'and it carried the viewer\'s language preferences', streamCall ? streamCall.search : 'no call');

    // ── books search ───────────────────────────────────────────────────────
    // The detail dialog is modal and intercepts every pointer event, so it has
    // to be dismissed before the nav is reachable at all.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#detail-dialog')?.open, null, { timeout: 10000 });
    await page.locator('#search-button').click();
    await page.fill('#search-input', 'men are from mars women are from venus');
    await page.locator('#search-form').press('Enter').catch(() => {});
    await page.waitForFunction(
      () => document.querySelectorAll('#search-media-results .media-search-card').length > 0,
      null, { timeout: 20000 },
    ).catch(() => {});
    const books = seen.find((r) => r.path === '/media/books');
    const cards = await page.locator('#search-media-results .media-search-card').count();
    ok(Boolean(books), 'the books library is actually asked — it used to bail before sending anything');
    ok(Boolean(books && /profileId=p1/.test(books.search) && /deviceId=dev-r/.test(books.search)),
      'with both ids the fleet requires, so it is a 200 and not a 403',
      books ? books.search : 'no call');
    ok(Boolean(books && books.headers['x-device-token']),
      'and the device token in a header, never in the URL');
    ok(cards >= 1, 'and a result is drawn', `${cards} cards`);

    ok(faults.length === 0, 'no page errors during a restore', faults.join(' | '));
    await ctx.close();
  }

  // ── 2. A PIN STILL STOPS IT ───────────────────────────────────────────────
  {
    const { ctx, page } = await run(browser, { remembered: REMEMBERED('p1'), profiles: [WITH_PIN] });
    await page.waitForTimeout(9000);
    const state = await page.evaluate(() => ({
      prefsProfileId: window.BlazingStreamPreferences?.current().profileId ?? null,
      gateOpen: document.querySelector('.bp-layer')?.hidden === false,
    }));
    ok(state.prefsProfileId === null,
      'a profile that HAS A PIN is never restored silently — a PIN means a human answers, every time',
      String(state.prefsProfileId));
    ok(state.gateOpen === true, 'so the gate stays up and asks');
    await ctx.close();
  }

  // ── 3. THE SERVER'S LIST DECIDES ──────────────────────────────────────────
  {
    // Remembered id 'p1'; the server now only knows 'someone-else'. A restore
    // that trusted localStorage would replay access the owner already removed.
    const { ctx, page } = await run(browser, {
      remembered: REMEMBERED('p1'), profiles: [{ ...NO_PIN, id: 'someone-else', name: 'Other' }],
    });
    await page.waitForTimeout(9000);
    const state = await page.evaluate(() => ({
      prefsProfileId: window.BlazingStreamPreferences?.current().profileId ?? null,
      gateOpen: document.querySelector('.bp-layer')?.hidden === false,
    }));
    ok(state.prefsProfileId === null,
      'a remembered profile the server no longer lists is NOT restored', String(state.prefsProfileId));
    ok(state.gateOpen === true, 'and that browser is asked to choose again');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
