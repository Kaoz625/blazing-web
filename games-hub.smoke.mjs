import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';
// Headless-Comet smoke test for the GAMES HUB — the one browser that replaces
// the eight closed com.nookie.* "Game Browser" apps on mac1.
//
// ── THE MOCK MIRRORS THE REAL SERVER, AND THAT IS THE WHOLE POINT ────────────
//
// Everything the add-on would answer is intercepted, so nothing real is
// contacted. The first version of this file invented the shapes it intercepted
// — `sourceName`, `origin`, `lanes: ['direct']`, a size of '42 MB', an `error`
// that was a string — and not one of those has ever been sent by anything. A
// mock that disagrees with the server proves nothing and actively makes correct
// client code look broken, which is exactly what it did.
//
// So every shape below is transcribed from these two files, on 23 Sep 2026:
//
//     blazing/services/addon/lib/game-sources.js
//         PLATFORMS, DELIVERIES, KINDS, LANES, LANE_LABELS, lanesFor(),
//         laneFor(), normaliseRow(), registry list()
//     blazing/services/addon/lib/game-source-routes.js
//         GET /games/sources, GET /games/search, GET /games/resolve,
//         POST /games/sources, PATCH /games/sources/:id, GET /games/ps5/queue,
//         GET /games/browse
//
// Diff this file against those two when either moves. The registry is committed
// and pushed in the monorepo (commit 3886a668), so the old header line — "the
// registry is not live, so this suite IS the contract until it is" — is no
// longer true and has been deleted. The contract lives in the add-on now; this
// file only has to agree with it.
//
// Two rules are transcribed as CODE rather than as literals, because they are
// the two that decide almost everything on screen: `laneForRow()` is lanesFor()
// and `normalise()` is normaliseRow(). A hand-written row could drift from them
// silently; a transcribed function cannot drift without this comment being
// wrong too.
//
// What is proved:
//   1. the hub opens on BROWSE, not the RAWG catalogue, and a search renders
//      one wide row per release with its lane badge — and `size` is a NUMBER OF
//      BYTES, so 44040192 reads "42 MB" and 0 prints nothing at all;
//   2. the platform chips and the source dropdown both narrow the query — and
//      the assertion reads the URL the app actually requested, not the DOM;
//   3. the SOURCES tab lists the registry, the On/Off switch reaches
//      PATCH /games/sources/<id> and follows the REPLY, and the add form
//      reaches POST /games/sources in the documented nested shape;
//   4. ACCOUNTS: the lanes are armed by the SERVER's key state, not by anything
//      this browser stores — a box with a Real-Debrid key draws that lane armed
//      and a box without one draws it disarmed, on the rows themselves;
//   5. THE NORMAL WAY. With NO Real-Debrid and NO TorBox key anywhere, a
//      direct-HTTP release still resolves and still hands back a link. This is
//      the case most likely to be shipped broken, so it is a named check. The
//      lane token it asserts is "http" — the header used to say "direct", which
//      is a lane the server has never had;
//   6. a release the add-on cannot fetch is DIM AND DISABLED, not hidden — a
//      hidden row reads as "this source is broken" instead of "paste a key in";
//   7. PS5: on the console's user agent the hub offers NO download button at
//      all and offers the Mac hand-off instead. The console browser holds a
//      whole response body in RAM and dies on anything large
//      (blazing-ps5/README.md), so a Download button there is a button that is
//      guaranteed to fail on exactly the files it exists for;
//   8. IGDB artwork and copy render when they are there and leave nothing empty
//      behind when they are not — a box with no IGDB credentials answers the
//      same rows minus those fields.
import { launchBrowser } from './comet.mjs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const errors = [];
let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ── the server's own constants, verbatim ─────────────────────────────────────

/** PLATFORMS, lib/game-sources.js. /games/sources sends this whole list. */
const PLATFORMS = [
  'ps5', 'ps4', 'ps3', 'ps2', 'ps1', 'psp', 'psvita',
  'switch', 'wiiu', 'wii', 'gamecube', '3ds', 'nds',
  'xboxone', 'xbox360', 'xbox',
  'pc', 'mac', 'linux', 'android',
  'retro', 'arcade',
];

/** LANE_LABELS, lib/game-sources.js. `http` is "Direct download", not "Direct". */
const LANE_LABELS = { http: 'Direct download', realdebrid: 'Real-Debrid', torbox: 'TorBox' };

// ── the mock registry, in registry list()'s exact shape ──────────────────────
//
// list() emits: { id, label, platforms[], delivery, kind, backend, indexer,
// enabled, builtin, lane, minQueryLength, error }. There is no `name`, no
// `origin`, and `error` is an OBJECT — `{ reason, message }` — because that is
// what createGameSourceRegistry's load() stores for an overlay it could not
// compile. `lane` is NOT a literal here: it is computed per request the way the
// server computes it, because it depends on the debrid state.
const REGISTRY = [
  {
    id: 'steamrip', label: 'SteamRIP', platforms: ['pc'], delivery: 'direct',
    kind: 'module', backend: '', indexer: '', enabled: true, builtin: true,
    collection: false, minQueryLength: 3, error: null,
  },
  {
    id: 'minerva', label: 'Minerva Archive', platforms: ['ps3', 'psp', 'switch', 'retro'],
    delivery: 'magnet', kind: 'module', backend: '', indexer: '', enabled: true,
    builtin: true, collection: false, minQueryLength: 3, error: null,
  },
  // A Prowlarr indexer, from the ~70 Prowlarr manages on mac2 (:9696). It is in
  // the SAME list as the two scraper modules and must be labelled apart, which
  // is the server's own stated rule.
  {
    id: 'skidrowrepack', label: 'SkidrowRepack', platforms: ['pc'], delivery: 'magnet',
    kind: 'indexer', backend: 'prowlarr', indexer: 'SkidrowRepack', enabled: false,
    builtin: false, collection: false, minQueryLength: 1, error: null,
  },
  // A user source the registry could NOT compile. load() records it rather than
  // throwing — "a mistyped platform must not be the reason the whole addon fails
  // to start" — and list() then reports it disabled whatever its switch says.
  // It is here for two reasons: the error object has to render as a sentence,
  // and it is the one row that proves the switch trusts the REPLY.
  {
    id: 'nopaystation', label: 'NoPayStation', platforms: [], delivery: 'direct',
    kind: 'module', backend: '', indexer: '', enabled: false, builtin: false,
    collection: false, minQueryLength: 1,
    error: {
      reason: 'unknown-platform',
      message: 'Source nopaystation declares platform(s) vita; known tokens are ps5, ps4, ps3, ps2, ps1, psp, psvita',
    },
  },
];

/**
 * lanesFor() + laneFor(), transcribed from lib/game-sources.js.
 *
 * A direct row answers 'http' with no debrid configuration at all — that is the
 * no-debrid requirement, and it is the reason this is a function rather than a
 * field. A hash row with no key configured answers NULL, which is the case
 * check 6 exists for.
 */
function laneForRow(row, { hasRd, hasTorbox }) {
  if (row.httpUrl) return 'http';
  if (!row.hash) return null;
  const order = row.path ? ['realdebrid', 'torbox'] : ['torbox', 'realdebrid'];
  const open = order.filter((lane) => (lane === 'realdebrid' ? hasRd : hasTorbox));
  return open.length ? open[0] : null;
}

/** The probe row registry list() uses to advertise a source's lane. */
function sourceLane(s, debrid) {
  return laneForRow(
    s.delivery === 'direct'
      ? { httpUrl: 'https://example.invalid/x' }
      : { hash: 'a'.repeat(40), path: s.collection ? 'a-file-inside.zip' : '' },
    debrid,
  );
}

function listSources(registry, debrid) {
  return registry.map((s) => ({
    id: s.id,
    label: s.label,
    platforms: s.platforms,
    delivery: s.delivery,
    kind: s.kind,
    backend: s.backend,
    indexer: s.indexer,
    // Boolean(s.enabled && !s.error) — a broken source is off however it was set.
    enabled: Boolean(s.enabled && !s.error),
    builtin: s.builtin,
    lane: sourceLane(s, debrid),
    minQueryLength: s.minQueryLength,
    error: s.error,
  }));
}

// ── the raw rows a source hands back, before normaliseRow() ──────────────────
//
// One release per lane shape. The steamrip one is what the NORMAL WAY case
// uses: it publishes an httpUrl, so lanesFor() answers 'http' and it must work
// with no debrid account anywhere.
const RAW = [
  {
    source: 'steamrip',
    row: {
      // normaliseRow strips a trailing extension off the title on purpose.
      title: 'Freedoom Phase 1.zip', filename: 'freedoom1.zip',
      platform: 'PC', format: 'zip',
      // BYTES. 44040192 is 42 MB, and the client has to do that arithmetic —
      // the wire never carries a human string.
      size: 44040192,
      httpUrl: 'https://cdn.example.test/freedoom1.zip',
      info: 'https://steamrip.test/freedoom', cover: 'https://media.example.test/freedoom.jpg',
      tier: 2,
      // IGDB, laid over server-side by igdb.enrich(). A box with no IGDB
      // credentials answers this same row without these five keys.
      summary: 'A free content first-person shooter built on the Doom engine.',
      genres: ['Shooter', 'Action'], released: '2019-08-25', rating: 4.1,
      screenshots: ['https://media.example.test/fd-1.jpg', 'https://media.example.test/fd-2.jpg'],
    },
  },
  {
    source: 'minerva',
    row: {
      title: 'Metroid Prime', filename: 'MetroidPrime.nsp',
      platform: 'Switch', format: 'nsp',
      // 0 IS AN HONEST ANSWER, not a missing one — normaliseRow's own words.
      // Minerva's search API states no size at all, so the card must print no
      // size rather than "0 B".
      size: 0,
      hash: 'b'.repeat(40), collection: 'Nintendo Switch Collection', region: 'USA',
      cover: '', tier: 1,
    },
  },
];

/** normaliseRow(), transcribed. These eighteen fields are the whole row. */
function normalise({ source: sid, row }, debrid) {
  const s = REGISTRY.find((x) => x.id === sid);
  const lane = laneForRow(row, debrid);
  // signRef() returns '' when no lane can fetch the row, and normaliseRow then
  // sets url/direct/playable off that same empty ref.
  const ref = lane ? `ref-${sid}-${lane}` : '';
  const out = {
    source: s.id,
    provider: s.label,
    title: String(row.title || row.filename || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim(),
    platform: row.platform || '',
    collection: row.collection || '',
    region: row.region || '',
    format: String(row.format || '').toUpperCase(),
    size: Number.isFinite(row.size) && row.size > 0 ? Math.floor(row.size) : 0,
    url: ref || null,
    ref,
    direct: Boolean(ref),
    playable: Boolean(ref),
    info: row.info || '',
    cover: row.cover || '',
    tier: Number(row.tier) || 0,
    lane,
    delivery: s.delivery,
    kind: s.kind,
  };
  for (const key of ['summary', 'genres', 'released', 'rating', 'screenshots']) {
    if (row[key] != null) out[key] = row[key];
  }
  return out;
}

const browser = await launchBrowser();

/**
 * @param {object} options
 * @param {boolean} options.ps5        drive the console's user agent
 * @param {boolean} options.hasRd      the ADD-ON holds a Real-Debrid key
 * @param {boolean} options.hasTorbox  the ADD-ON holds a TorBox key
 */
async function openHub({ ps5 = false, hasRd = false, hasTorbox = false } = {}) {
  const debrid = { hasRd, hasTorbox };
  // lanesAvailable(), lib/game-source-routes.js. `http` is true unconditionally.
  const lanes = { http: true, realdebrid: hasRd, torbox: hasTorbox };
  // A per-context copy, so a PATCH in one case cannot leak into another.
  const registry = REGISTRY.map((s) => ({ ...s }));

  const ctx = await browser.newContext(
    ps5
      // The console's real UA string. The app also honours a
      // window.BLAZING_FORCE_PS5 override, set below, so this branch is
      // provable on a Mac without a console in the loop.
      ? { userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 5/8.20) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15' }
      : {}
  );
  const calls = [];

  await ctx.route('https://addon.lyreosai.com/**', (route) => {
    const req = route.request();
    const url = req.url();
    const u = new URL(url);
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ url, method: req.method(), headers: req.headers(), path: u.pathname, params: u.searchParams, body });
    const json = (status, payload) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(payload),
    });

    /* GET /games/sources */
    if (u.pathname === '/games/sources' && req.method() === 'GET') {
      const sources = listSources(registry, debrid);
      return json(200, {
        count: sources.length,
        sources,
        platforms: PLATFORMS,
        // Empty until a Questarr client is wired. A client reads this rather
        // than assuming a backend exists.
        backends: [],
        lanes,
        laneLabels: LANE_LABELS,
        debridEnabled: hasRd || hasTorbox,
        configFile: 'sources.local.json',
      });
    }

    /* POST /games/sources — { ok, saved, count, sources[] } */
    if (u.pathname === '/games/sources' && req.method() === 'POST') {
      const decl = (body && body.source) || body || {};
      const sources = listSources(registry, debrid);
      return json(200, {
        ok: true, saved: String(decl.id || '').toLowerCase(), count: sources.length, sources,
      });
    }

    /* PATCH /games/sources/:id — { ok, id, enabled, count, sources[] } */
    if (u.pathname.startsWith('/games/sources/') && req.method() === 'PATCH') {
      const id = u.pathname.slice('/games/sources/'.length);
      const row = registry.find((s) => s.id === id);
      if (!row) return json(404, { error: 'unknown-source', reason: 'unknown-source', message: `No game source is registered as "${id}".` });
      // A non-boolean is refused with 400 `bad-enabled` on purpose: "false" is
      // a truthy string and coercing it would switch a source ON.
      if (!body || typeof body.enabled !== 'boolean') {
        return json(400, { error: 'bad-enabled', reason: 'bad-enabled', message: '"enabled" must be true or false, not a string.' });
      }
      row.enabled = body.enabled;
      const sources = listSources(registry, debrid);
      const after = sources.find((s) => s.id === id);
      return json(200, {
        ok: true,
        id,
        // READ BACK OFF THE REGISTRY, never echoed. A source with an error
        // reports disabled however the switch was set.
        enabled: after ? after.enabled : false,
        count: sources.length,
        sources,
      });
    }

    /* GET /games/search */
    if (u.pathname === '/games/search') {
      const platform = (u.searchParams.get('platform') || '').toLowerCase();
      const source = (u.searchParams.get('source') || '').toLowerCase();
      // platformFilter(): a CANONICAL token is answered by what the SOURCE
      // declares, not by the row's own free-form platform text.
      const canonical = PLATFORMS.includes(platform) ? platform : '';
      const asked = registry
        .filter((s) => s.enabled && !s.error)
        .filter((s) => !source || s.id === source)
        .filter((s) => !canonical || s.platforms.includes(canonical));
      const askedIds = asked.map((s) => s.id);
      const results = RAW
        .filter((r) => askedIds.includes(r.source))
        .map((r) => normalise(r, debrid))
        .sort((a, b) => b.tier - a.tier);
      return json(200, {
        query: u.searchParams.get('q') || '',
        platform: u.searchParams.get('platform') || '',
        source,
        count: results.length,
        results,
        asked: askedIds,
        errors: [],
        lanes,
        debridEnabled: hasRd || hasTorbox,
        unavailable: results.length ? null : {
          reason: 'no-match',
          message: 'No registered source holds anything matching that title.',
        },
      });
    }

    /* GET /games/resolve — THE SERVER PICKS THE LANE. There is no ?lane=. */
    if (u.pathname === '/games/resolve') {
      const ref = u.searchParams.get('ref') || '';
      const lane = ref.split('-').pop();
      if (!LANE_LABELS[lane]) {
        return json(404, {
          error: 'invalid-reference', reason: 'invalid-reference',
          message: 'That reference is expired or was not issued here.',
        });
      }
      // THE SERVER-SIDE HALF OF THE NORMAL-WAY RULE. The http lane's resolver
      // is `async (p) => p.u` and consults no account at all; a debrid lane is
      // only built at all when the server holds that key, which is why a lane
      // it cannot serve never reaches this point.
      return json(200, {
        ok: true,
        lane,
        provider: LANE_LABELS[lane],
        source: ref.split('-')[1] || null,
        tried: [lane],
        url: lane === 'http'
          ? 'https://cdn.example.test/freedoom1.zip'
          : `https://cdn.example.test/${ref}.bin`,
      });
    }

    /* GET /games/ps5/queue — a GET, because JTPlay's sandbox has only http.get */
    if (u.pathname === '/games/ps5/queue') {
      return json(200, {
        ok: true, queued: true, duplicate: false, count: 1,
        dest: '/mnt/usb0/PS5-DOWNLOADS/Freedoom Phase 1',
        message: 'Queued. The Mac writes it to /mnt/usb0/PS5-DOWNLOADS/Freedoom Phase 1, then Blazing Mount installs it.',
      });
    }

    /* GET /games/browse — IGDB titles, and 503 on a box with no credentials. */
    if (u.pathname === '/games/browse') {
      return json(503, {
        error: 'igdb-not-configured', reason: 'igdb-not-configured',
        platform: u.searchParams.get('platform') || '', count: 0, results: [],
        message: 'This add-on has no IGDB credentials, so it cannot list what exists for a system.',
      });
    }

    return json(200, { catalogs: [], metas: [] });
  });

  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await ctx.route('https://cdn.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'ok' }));
  await ctx.route('https://media.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: '' }));

  await ctx.addInitScript((forcePs5) => {
    // A LEFTOVER KEY WOULD PROVE THE WRONG THING. Nothing in this app writes a
    // debrid key to the browser any more — the add-on owns both, and check 5
    // asserts the store stays empty — so this is a guard against a future
    // regression putting one back, not a cleanup of something we wrote.
    try {
      window.localStorage.removeItem('blazing.games.realdebrid');
      window.localStorage.removeItem('blazing.games.torbox');
    } catch { /* private mode */ }
    if (forcePs5) window.BLAZING_FORCE_PS5 = true;
  }, ps5);

  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await selectProfile(page);
  // Same reason games.smoke.mjs dispatches this directly: "Games" lives in the
  // drawer-only "More" nav, which styles.css hides at a desktop viewport, and
  // app.js binds every [data-view] button the same way regardless.
  await page.evaluate(() => document.querySelector('[data-view="games"]').click());
  await page.waitForSelector('#games-tab-browse', { state: 'visible', timeout: 10000 });
  return { ctx, page, calls };
}

async function search(page, term) {
  await page.fill('#games-hub-input', term);
  await page.click('#games-hub-form button[type="submit"]');
  await page.waitForFunction(
    () => !/Searching/.test(document.getElementById('games-hub-status').textContent || ''),
    null, { timeout: 8000 });
}

const text = async (locator) => ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim();

// ── 1: the hub opens on Browse and renders wide rows with a lane badge ───────
{
  const { ctx, page } = await openHub();
  check('Browse is the tab that is showing', await page.locator('#games-tab-browse').isVisible());
  check('the RAWG catalogue is NOT the tab that is showing', (await page.locator('#games-tab-catalogue').isVisible()) === false);
  // The chips are built from the SERVER's platforms[], which is the whole
  // PLATFORMS list, plus one "All" chip. The old assertion counted 9, which was
  // the client's own FALLBACK_PLATFORMS — it passed only because the mock never
  // sent a platforms[] at all.
  check('the platform chips are built from the server\'s platform list',
    (await page.locator('#games-platform-chips .games-chip').count()) === PLATFORMS.length + 1,
    String(await page.locator('#games-platform-chips .games-chip').count()));

  await search(page, 'anything');
  check('two releases render as rows', (await page.locator('#games-hub-results .games-row').count()) === 2);
  const first = page.locator('#games-hub-results .games-row').first();
  check('a row shows its title', (await text(first.locator('.games-row-title'))).includes('Freedoom'));
  // `provider`, the friendly name. Reading `sourceLabel` printed the lower-case
  // id on every row and looked like it worked.
  check('a row shows platform, provider and a size in human units',
    /PC.*SteamRIP.*42 MB/.test(await text(first.locator('.games-row-meta'))),
    await text(first.locator('.games-row-meta')));
  const second = page.locator('#games-hub-results .games-row').nth(1);
  // size 0 means "the archive stated no size". Printing "0 B" would invent the
  // claim normaliseRow deliberately refused to make.
  check('a release whose archive stated NO size prints no size at all',
    !/\d+(\.\d+)?\s*(B|KB|MB|GB|TB)\b/.test(await text(second.locator('.games-row-meta'))),
    await text(second.locator('.games-row-meta')));
  check('the direct release shows the http lane badge, labelled the server\'s way',
    (await first.locator('.games-lane-badge[data-lane="http"]').count()) === 1
    && (await text(first.locator('.games-lane-badge'))) === LANE_LABELS.http,
    await text(first.locator('.games-lane-badge')));
  await ctx.close();
}

// ── 2: the filters reach the WIRE, not just the DOM ──────────────────────────
{
  const { ctx, page, calls } = await openHub();
  await search(page, 'metroid');
  await page.click('#games-platform-chips .games-chip[data-platform="switch"]');
  await page.waitForFunction(
    () => (document.getElementById('games-hub-status').textContent || '').includes('release'),
    null, { timeout: 8000 });
  const platformCall = calls.filter((c) => c.path === '/games/search').pop();
  check('the platform chip is sent as ?platform=switch', platformCall.params.get('platform') === 'switch', platformCall.url);
  check('the chip filter narrows to one row', (await page.locator('#games-hub-results .games-row').count()) === 1);
  check('the pressed chip is the only one pressed',
    (await page.locator('#games-platform-chips .games-chip[aria-pressed="true"]').count()) === 1);

  // Back to All, then narrow by source instead.
  await page.click('#games-platform-chips .games-chip[data-platform=""]');
  await page.waitForFunction(() => document.querySelectorAll('#games-hub-results .games-row').length === 2, null, { timeout: 8000 });
  check('the source dropdown is built from the registry, disabled and broken sources left out',
    (await page.locator('#games-source-filter option').count()) === 3,
    await page.locator('#games-source-filter').evaluate((n) => Array.from(n.options).map((o) => o.value).join('|')));
  await page.selectOption('#games-source-filter', 'steamrip');
  await page.waitForFunction(() => document.querySelectorAll('#games-hub-results .games-row').length === 1, null, { timeout: 8000 });
  const sourceCall = calls.filter((c) => c.path === '/games/search').pop();
  check('the dropdown is sent as ?source=steamrip', sourceCall.params.get('source') === 'steamrip', sourceCall.url);
  await ctx.close();
}

// ── 3: the SOURCES registry, its switch and its add form ─────────────────────
{
  const { ctx, page, calls } = await openHub();
  await page.click('[data-games-tab="sources"]');
  await page.waitForSelector('#games-sources-list .games-source-item', { timeout: 8000 });
  check('every registered source is listed, on and off and broken alike',
    (await page.locator('#games-sources-list .games-source-item').count()) === 4);
  check('a disabled source is marked disabled, not dropped',
    (await page.locator('.games-source-item[data-source-id="skidrowrepack"]').getAttribute('data-enabled')) === 'false');
  check('a Prowlarr indexer and a built-in scraper sit in ONE list, labelled apart',
    (await text(page.locator('.games-source-item[data-source-id="skidrowrepack"] .games-source-sub'))).startsWith('Prowlarr indexer')
    && (await text(page.locator('.games-source-item[data-source-id="steamrip"] .games-source-sub'))).startsWith('Built-in scraper'),
    await text(page.locator('.games-source-item[data-source-id="skidrowrepack"] .games-source-sub')));
  check('the status line counts them',
    (await text(page.locator('#games-sources-status'))).includes('4 sources, 2 on'),
    await text(page.locator('#games-sources-status')));
  // `error` is { reason, message }. Rendering the object draws "[object Object]",
  // which tells him nothing and hides the one sentence that would.
  check('a broken source shows its error MESSAGE, not [object Object]',
    (await text(page.locator('.games-source-item[data-source-id="nopaystation"] .games-source-error')))
      .includes('declares platform(s) vita'),
    await text(page.locator('.games-source-item[data-source-id="nopaystation"] .games-source-error')));

  // THE SWITCH. It used to be a state badge with a comment saying a switch was
  // impossible, because the only write was a POST that upserts a whole live
  // declaration. PATCH /games/sources/<id> { enabled } is the endpoint that
  // comment named, and it now exists.
  await page.click('.games-source-item[data-source-id="skidrowrepack"] .games-source-toggle');
  await page.waitForFunction(
    () => document.querySelector('.games-source-item[data-source-id="skidrowrepack"]').dataset.enabled === 'true',
    null, { timeout: 8000 });
  const patch = calls.filter((c) => c.method === 'PATCH').pop();
  check('the switch sends PATCH /games/sources/<id>', Boolean(patch) && patch.path === '/games/sources/skidrowrepack',
    patch ? patch.url : 'no PATCH');
  check('the switch sends a BOOLEAN enabled, which is what the route demands',
    Boolean(patch) && patch.body && patch.body.enabled === true && typeof patch.body.enabled === 'boolean',
    patch ? JSON.stringify(patch.body) : 'no PATCH');
  check('a source switched on appears in the Browse dropdown with no reload',
    (await page.locator('#games-source-filter option').count()) === 4,
    await page.locator('#games-source-filter').evaluate((n) => Array.from(n.options).map((o) => o.value).join('|')));

  // THE STATE FOLLOWS THE REPLY, NOT THE PRESS. The route reads `enabled` back
  // off the reloaded registry, so a source carrying an error is reported
  // disabled however the switch was set. A screen that painted its own echo
  // would show On over a source that is not running.
  await page.evaluate(() => {
    document.querySelector('.games-source-item[data-source-id="nopaystation"]').dataset.probe = 'before';
  });
  await page.click('.games-source-item[data-source-id="nopaystation"] .games-source-toggle');
  await page.waitForFunction(
    () => document.querySelector('.games-source-item[data-source-id="nopaystation"]').dataset.probe !== 'before',
    null, { timeout: 8000 });
  const patch2 = calls.filter((c) => c.method === 'PATCH').pop();
  check('switching a BROKEN source on still sends the PATCH',
    Boolean(patch2) && patch2.path === '/games/sources/nopaystation' && patch2.body.enabled === true,
    patch2 ? patch2.url : 'no PATCH');
  check('…and the row stays OFF, because the reply says so and the reply is the truth',
    (await page.locator('.games-source-item[data-source-id="nopaystation"]').getAttribute('data-enabled')) === 'false');

  // THE ADD FORM. The documented body is nested under `source` — the route says
  // so in its own 400 — and its field names are validateSource()'s: id, label,
  // platforms[], delivery. Not `name`, not `kind`, and there is no `origin`.
  await page.fill('#games-source-id', 'mymirror');
  await page.fill('#games-source-name', 'My Own Mirror');
  await page.fill('#games-source-url', 'https://mirror.example.test');
  await page.fill('#games-source-platforms', 'ps4, ps5');
  await page.selectOption('#games-source-kind', 'direct');
  await page.click('#games-source-add button[type="submit"]');
  await page.waitForFunction(
    () => (document.getElementById('games-source-add-status').textContent || '').includes('Added'),
    null, { timeout: 8000 });
  const post = calls.filter((c) => c.method === 'POST' && c.path === '/games/sources').pop();
  check('the add form sends POST /games/sources', Boolean(post));
  check('the add form sends the DOCUMENTED nested shape with the real field names',
    Boolean(post) && post.body && post.body.source
      && post.body.source.id === 'mymirror'
      && post.body.source.label === 'My Own Mirror'
      && post.body.source.url === 'https://mirror.example.test'
      && post.body.source.delivery === 'direct'
      && Array.isArray(post.body.source.platforms)
      && post.body.source.platforms.join(',') === 'ps4,ps5',
    post ? JSON.stringify(post.body) : 'no POST');
  // DELIVERIES is magnet|torrent|direct. The form used to offer http/magnet/nzb,
  // and validateSource() would have refused every one of them with bad-delivery.
  check('the delivery menu offers only the deliveries the server accepts',
    (await page.locator('#games-source-kind').evaluate((n) => Array.from(n.options).map((o) => o.value).join(','))) === 'direct,magnet,torrent',
    await page.locator('#games-source-kind').evaluate((n) => Array.from(n.options).map((o) => o.value).join(',')));
  check('the add form cleared its boxes after a success',
    (await page.inputValue('#games-source-name')) === '' && (await page.inputValue('#games-source-url')) === '');
  await ctx.close();
}

// ── 4: the debrid lanes are armed by the SERVER, never by this browser ───────
//
// The claim is unchanged — "saving a Real-Debrid key arms that lane" — but the
// key does not live here any more and the check had to move with it. An earlier
// draft of the hub kept both keys in localStorage and sent them as headers;
// /games/sources answers `lanes` and `debridEnabled` off the add-on's own
// debrid.hasRd / debrid.hasTorbox and /games/resolve uses those, so a second
// copy in the browser could draw a lane ready while the server refused it. Two
// sources of truth for one credential is worse than none. So the two halves of
// this claim are now two boxes: one whose add-on holds a key and one whose
// does not.
{
  const cold = await openHub();
  await search(cold.page, 'metroid');
  const coldRow = cold.page.locator('#games-hub-results .games-row').nth(1);
  check('with NO key on the add-on, the torrent release is drawn DISARMED',
    (await coldRow.locator('.games-lane-badge').getAttribute('data-armed')) === 'false');
  await cold.page.click('[data-games-tab="accounts"]');
  const httpRow = cold.page.locator('#games-lane-state .games-lane-state-row').first();
  check('the lane state names the http lane the server\'s way and says it needs no account',
    (await text(httpRow.locator('.games-lane-badge'))) === LANE_LABELS.http
    && (await text(httpRow)).includes('Always ready'),
    await text(httpRow));
  check('…and that the add-on has no Real-Debrid key',
    (await text(cold.page.locator('#games-lane-state'))).includes('The add-on has no key for this'));
  check('the accounts line says where the key really lives',
    (await text(cold.page.locator('#games-accounts-status'))).includes('No debrid account is configured on the add-on'),
    await text(cold.page.locator('#games-accounts-status')));
  await cold.ctx.close();

  const warm = await openHub({ hasRd: true });
  await search(warm.page, 'metroid');
  const warmRow = warm.page.locator('#games-hub-results .games-row').nth(1);
  check('with a Real-Debrid key ON THE ADD-ON, the same release is armed on that lane',
    (await warmRow.locator('.games-lane-badge[data-lane="realdebrid"]').getAttribute('data-armed')) === 'true',
    await text(warmRow.locator('.games-lane-badge')));
  await warm.page.click('[data-games-tab="accounts"]');
  check('and the accounts tab says the add-on holds the key, not this browser',
    (await text(warm.page.locator('#games-accounts-status'))).includes('The add-on holds the keys; nothing is stored in this browser'),
    await text(warm.page.locator('#games-accounts-status')));
  await warm.ctx.close();
}

// ── 5: THE NORMAL WAY — direct HTTP with NO debrid key anywhere ──────────────
//
// This is the named case. The add-on holds neither key, nothing is in
// localStorage, and the release publishes a plain httpUrl — so lanesFor()
// answers 'http' and /games/resolve's http arm is `async (p) => p.u`, which
// consults no account at all. It must still resolve, and it must resolve AS
// 'http'. The old suite asserted the token was literally "direct"; there has
// never been a lane by that name.
{
  const { ctx, page, calls } = await openHub();
  const stored = await page.evaluate(() => ({
    rd: window.localStorage.getItem('blazing.games.realdebrid'),
    tb: window.localStorage.getItem('blazing.games.torbox'),
  }));
  check('NO debrid key is stored in this browser, for this case or any other',
    stored.rd === null && stored.tb === null, JSON.stringify(stored));

  await search(page, 'freedoom');
  await page.click('#games-hub-results .games-row >> nth=0');
  await page.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
  check('the download button is ENABLED with no debrid account at all',
    (await page.locator('#game-source-lanes button').isDisabled()) === false);
  check('there is ONE button, because /games/resolve picks the lane itself',
    (await page.locator('#game-source-lanes button').count()) === 1);
  check('and the copy names the lane that will carry it',
    (await text(page.locator('#game-source-lanes p'))).includes(LANE_LABELS.http),
    await text(page.locator('#game-source-lanes p')));

  await page.click('#game-source-lanes button');
  await page.waitForFunction(
    () => (document.getElementById('game-source-status').textContent || '').startsWith('Started'),
    null, { timeout: 8000 });
  const resolveCall = calls.filter((c) => c.path === '/games/resolve').pop();
  check('resolve was asked by REF and nothing else — there is no ?lane= parameter',
    resolveCall.params.get('ref') === 'ref-steamrip-http' && resolveCall.params.get('lane') === null,
    resolveCall.url);
  check('NO credential header was sent on that request',
    !('x-blazing-rd' in resolveCall.headers) && !('x-blazing-tb' in resolveCall.headers),
    Object.keys(resolveCall.headers).filter((h) => h.startsWith('x-blazing')).join(',') || 'none');
  const status = await text(page.locator('#game-source-status'));
  check('the dialog reports it started, and names the lane that did it and the file',
    status.includes(LANE_LABELS.http) && status.includes('freedoom1.zip'), status);
  check('the lane the app recorded is literally "http"',
    (await page.getAttribute('#game-source-status', 'data-lane')) === 'http');
  await ctx.close();
}

// ── 6: a release the add-on cannot fetch is dim and disabled, never hidden ───
{
  const { ctx, page } = await openHub();
  await search(page, 'metroid');
  check('a release with no usable lane is still LISTED',
    (await page.locator('#games-hub-results .games-row').count()) === 2);
  const row = page.locator('#games-hub-results .games-row').nth(1);
  check('its lane badge is still SHOWN, disarmed rather than removed',
    (await row.locator('.games-lane-badge').count()) === 1
    && (await row.locator('.games-lane-badge').getAttribute('data-armed')) === 'false'
    && (await row.locator('.games-lane-badge').getAttribute('aria-disabled')) === 'true');

  await page.click('#games-hub-results .games-row >> nth=1');
  await page.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
  check('the download button is still SHOWN with no key',
    (await page.locator('#game-source-lanes button').count()) === 1);
  check('and it is disabled',
    (await page.locator('#game-source-lanes button').isDisabled()) === true);
  check('and it says why, rather than failing on click',
    /Real-Debrid.*TorBox/.test(await text(page.locator('#game-source-lanes p'))),
    await text(page.locator('#game-source-lanes p')));
  await ctx.close();
}

// ── 7: PS5 — browse and choose, never fetch ──────────────────────────────────
{
  const { ctx, page, calls } = await openHub({ ps5: true });
  await search(page, 'metroid');
  await page.click('#games-hub-results .games-row >> nth=0');
  await page.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
  check('the console is offered NO download button at all',
    (await page.locator('#game-source-lanes button').count()) === 0);
  check('and it is told why in plain words',
    (await text(page.locator('#game-source-lanes'))).includes('runs out'),
    await text(page.locator('#game-source-lanes')));
  check('the Mac hand-off is offered instead',
    (await page.locator('#game-source-ps5').isVisible()) === true);

  await page.click('#game-source-ps5');
  await page.waitForFunction(
    () => (document.getElementById('game-source-status').textContent || '').includes('Queued'),
    null, { timeout: 8000 });
  const queued = calls.filter((c) => c.path === '/games/ps5/queue').pop();
  // A GET, and the old assertion demanding a POST was wrong about the server.
  // JTPlay's QuickJS sandbox exposes exactly one network call, `http.get`, so
  // the add-on serves this as app.get() — a POST-only queue would be a queue
  // the console cannot reach. It is made safe by being LAN-only, idempotent on
  // a ref already queued, and by taking only a signed ref.
  check('the hand-off sends the chosen ref to the queue, as a GET',
    Boolean(queued) && queued.method === 'GET' && queued.params.get('ref') === 'ref-steamrip-http',
    queued ? `${queued.method} ${queued.url}` : 'no call');
  check('nothing on the console ever called /games/resolve',
    calls.filter((c) => c.path === '/games/resolve').length === 0);
  await ctx.close();
}

// ── 8: IGDB artwork and copy in the detail view ──────────────────────────────
//
// IGDB is Twitch-owned and Markus's account is already signed in, so the
// add-on lays cover, summary, genres, release date, rating and screenshots over
// the rows an archive gave it. It is the METADATA lane and it fails soft: a box
// with no IGDB credentials answers the same rows without those five keys. So
// the view must SHOW them when they are there and leave nothing empty when they
// are not.
{
  const { ctx, page } = await openHub();
  await search(page, 'freedoom');
  const firstRow = page.locator('#games-hub-results .games-row').first();
  check('a release with a cover renders the real image, not the initial fallback',
    (await firstRow.locator('img.games-row-art').count()) === 1
    && (await firstRow.locator('.games-row-art.is-blank').count()) === 0);

  await page.click('#games-hub-results .games-row >> nth=0');
  await page.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
  check('the IGDB summary is shown',
    (await page.locator('#game-source-summary').isVisible())
    && (await text(page.locator('#game-source-summary'))).includes('Doom engine'));
  check('the IGDB screenshots are shown',
    (await page.locator('#game-source-shots img').count()) === 2);
  check('the meta line carries the release date, the rating and the genres',
    /2019-08-25.*4\.1.*Shooter, Action/.test(await text(page.locator('#game-source-meta'))),
    await text(page.locator('#game-source-meta')));

  // And the degraded case: a release with none of it must leave nothing empty
  // on screen, and must fall back to the platform initial rather than a
  // broken-image glyph.
  await page.locator('#game-source-close').click();
  await search(page, 'metroid');
  await page.click('#games-hub-results .games-row >> nth=1');
  await page.waitForSelector('#game-source-dialog[open]', { timeout: 8000 });
  check('a release with no IGDB art leaves no empty summary in the flow',
    (await page.locator('#game-source-summary').isVisible()) === false);
  check('and no empty screenshot strip',
    (await page.locator('#game-source-shots').isVisible()) === false);
  // `format`, `region` and `collection` are the fields a row really carries.
  // The old view printed `row.file`, which no row has ever had.
  check('the file line is built from the fields a row really carries',
    /NSP.*USA.*Nintendo Switch Collection/.test(await text(page.locator('#game-source-file'))),
    await text(page.locator('#game-source-file')));
  await page.locator('#game-source-close').click();
  check('a cover-less row falls back to the platform initial, not a broken image',
    (await page.locator('#games-hub-results .games-row').nth(1).locator('.games-row-art.is-blank').count()) === 1);
  await ctx.close();
}

const real = errors.filter((e) => !/Failed to fetch|NetworkError|CORS|load resource/i.test(e));
check('no page errors', real.length === 0, real.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
