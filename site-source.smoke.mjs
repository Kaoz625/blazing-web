// SITE-SCRAPED SOURCES: found, resolved, played — and never a blank panel.
//
// WHY THIS EXISTS. Until 7 Sep 2026 this app REFUSED TO TRY. app.js held one
// predicate, `isMwp(meta)`, pinned to `^mwp:tv:<digits>$`, and four branches
// read it:
//
//   openDetail()    detailPlay.hidden = isMwp(meta)      — no Play button
//   openDetail()    the website link, shown immediately, with the status line
//                   "Source page only. Open MrWorldPremiere in a web browser
//                   to watch."
//   loadStreams()   `if (isMwp(meta)) return;`            — never asked at all
//   playSelected()  a message about "no verified direct stream"
//
// So a MrWorldPremiere episode could be found (from the addon's mwp-search
// catalog), drawn with its poster, opened — and never once attempted. Markus,
// 7 Sep 2026: "these were two sites we should have wired in to scrape and
// search and its not working. we should have all their shows and movies
// everything they have we should have had already."
//
// A SECOND dead end was measured while fixing the first, and it is asserted
// here too. runSearch() asked the FLEET and only the fleet, and the fleet's
// index does not carry the scrapers' pages:
//
//   GET fleet.lyreosai.com/search/movie?q=baddies&limit=20
//       200, 4 rows, every one a tt id — no mwp row at all
//   GET addon.lyreosai.com/catalog/movie/mwp-search/search=baddies.json
//       200, 20 rows: mwp:tv:14995 "Baddies USA Season 2 Episode 17", …
//
// Fixing playback alone would have left a door with nothing behind it.
//
// WHAT THIS FILE PROVES, and each of these is a thing that WAS broken:
//   1. a site-source title asks the addon for streams and RENDERS them
//   2. Play is offered, not hidden
//   3. a genuinely empty answer reveals the source page link and says so —
//      the fallback is demoted, not deleted
//   4. a SECOND prefix (`bs:`, BrokenSilenze — measured live; the brief
//      predicted `bsz:` and was wrong) behaves identically with its own name
//      and badge, through the same code — no `mwp` literal anywhere in the
//      path. This is the regression guard on requirement 3 of the brief: a
//      third site must cost one table row, not five branches.
//   5. search finds the site rows, discovered from the addon manifest's own
//      search extra rather than a hardcoded `mwp-search`, and the Adult
//      catalog is never among them
//   6. a stream's Referer/User-Agent requirement is FORWARDED to a native
//      shell instead of being dropped on the floor
//   7. the addon's `refused` array is READ and shown — the relay note on
//      BLZ-0019 records that no client did
//
// Everything is mocked at the network boundary, so this suite is about THIS
// CLIENT's behaviour and cannot go red because a scraper had a quiet night.
//
//   node site-source.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './comet.mjs';
import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';

const root = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(join(root, path === '/' ? 'index.html' : path)));
  } catch { res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// The ids are the REAL live shapes, not invented ones. mwp:tv:14995 is the
// episode the coordinator measured on 7 Sep 2026, and its website is the page
// the addon's own meta route returns for it.
const MWP_PLAYS = 'mwp:tv:14995';
const MWP_EMPTY = 'mwp:tv:14996';
// The REAL live prefix is `bs`, two letters — measured 7 Sep 2026:
//   /catalog/movie/bs-search/search=baddies.json -> bs:223006
// The brief predicted `bsz:`. The alias title below keeps that spelling
// covered too, so a rename either way stays labelled.
const BSZ_PLAYS = 'bs:223006';
const BSZ_EMPTY = 'bs:222870';
const BSZ_ALIAS = 'bsz:99001';
// A title whose CATALOG row carries no website and whose /meta route does.
// /meta/movie/mwp:tv:14995.json really does carry `website` while a catalog
// row need not, so mergeFullMeta() has to bring it across or the fallback
// link has no target on exactly the titles that most need one.
const MWP_LATE = 'mwp:tv:14997';
const LATE_SITE = 'https://mrworldpremiere.tv/2026/09/04/baddies-late-meta/';

const titles = [
  {
    id: MWP_PLAYS, type: 'movie', name: 'Baddies USA Season 2 Episode 17',
    releaseInfo: '2026', contentRating: 'mature',
    website: 'https://mrworldpremiere.tv/2026/09/06/baddies-usa-season-2-episode-17/',
  },
  {
    id: MWP_EMPTY, type: 'movie', name: 'Baddies Quiet Night', releaseInfo: '2026',
    contentRating: 'mature',
    website: 'https://mrworldpremiere.tv/2026/09/05/baddies-quiet-night/',
  },
  {
    id: BSZ_PLAYS, type: 'movie', name: 'Silenze Mixtape Special', releaseInfo: '2026',
    contentRating: 'mature',
    website: 'https://www.brokensilenze.net/2026/09/silenze-mixtape-special.html',
  },
  {
    id: BSZ_EMPTY, type: 'movie', name: 'Silenze Quiet Night', releaseInfo: '2026',
    contentRating: 'mature',
    website: 'https://www.brokensilenze.net/2026/09/silenze-quiet-night.html',
  },
  {
    id: BSZ_ALIAS, type: 'movie', name: 'Silenze Alias Night', releaseInfo: '2026',
    contentRating: 'mature',
    website: 'https://www.brokensilenze.net/2026/09/silenze-alias-night.html',
  },
  // NOTE: no `website` here on purpose — the /meta route below supplies it.
  { id: MWP_LATE, type: 'movie', name: 'Baddies Late Meta', releaseInfo: '2026', contentRating: 'mature' },
  // A control. An ordinary imdb title must keep behaving exactly as it did:
  // no badge, no source pill, no fallback link.
  { id: 'tt55501', type: 'movie', name: 'Ordinary Control Movie', contentRating: 'general' },
];

// THE mwp-search ROW IS COPIED VERBATIM FROM THE LIVE MANIFEST, 7 Sep 2026:
//
//   {"id":"mwp-search","type":"movie","name":"Blazing · MrWorldPremiere Search",
//    "extra":[{"name":"search","isRequired":true}]}
//
// `isRequired: true` is the whole reason this shape is pinned. The first cut of
// the discovery code filtered the manifest through activeCatalogs(), which
// DROPS every catalog with a required extra — correctly, because such a row is
// not a home shelf. Against a fixture that said `extra: ['search']` the suite
// was green; against the real addon it found zero catalogs and made no request
// at all. A fixture that is easier than production proves nothing.
//
// The bsz-search row keeps the bare-string spelling from the Stremio docs so both
// forms stay exercised, and blazing-adult-search must NEVER be queried — the
// adult filter has to survive being separated from the home filter.
const manifest = {
  catalogs: [
    { id: 'fixture', type: 'movie', name: 'Test titles' },
    { id: 'mwp-search', type: 'movie', name: 'Blazing · MrWorldPremiere Search', extra: [{ name: 'search', isRequired: true }] },
    { id: 'bsz-search', type: 'movie', name: 'Blazing · BrokenSilenze Search', extra: ['search'] },
    { id: 'blazing-adult-search', type: 'movie', name: 'Blazing · Adult (18+) Search', extra: [{ name: 'search', isRequired: true }] },
  ],
};

// The referrer requirement, in BOTH shapes app.js has to read: the Stremio
// behaviorHints form and the flat one our own scrapers set.
const REFERER = 'https://mrworldpremiere.tv/2026/09/06/baddies-usa-season-2-episode-17/';
const UA = 'BlazingTV/1.0 (verified-embed)';

// The addon's `refused` array, copied from the live answer for bs:223006 on
// 7 Sep 2026. The relay note on BLZ-0019 says NO CLIENT READS IT YET, and it
// is the difference between "nothing found" — which reads as our bug — and
// "two hosts had it and both served junk", which is the truth.
const REFUSED = [
  { host: 'voe.sx', url: 'https://voe.sx/e/ldfy1c4wwde8', reason: 'resolver returns a jwplayer analytics pixel, not media' },
  { host: 'vidmoly.org', url: 'https://vidmoly.org/w/abc', reason: 'media manifest answers 403 without headers a television cannot send' },
];

const streamsFor = (id) => {
  if (id === MWP_PLAYS) {
    return {
      streams: [{
        name: '1080p', title: 'baddies-usa-s02e17.1080p.H264.AAC.mp4',
        url: 'https://cdn.mwp.example.test/baddies-s02e17.mp4',
        behaviorHints: { proxyHeaders: { request: { Referer: REFERER, 'User-Agent': UA } } },
      }],
    };
  }
  if (id === BSZ_PLAYS) {
    return {
      streams: [{
        name: '720p', title: 'silenze-mixtape-special.720p.H264.AAC.mp4',
        url: 'https://cdn.bsz.example.test/silenze-special.mp4',
        referrer: 'https://www.brokensilenze.net/2026/09/silenze-mixtape-special.html',
      }],
    };
  }
  if (id === 'tt55501') {
    return { streams: [{ name: '1080p', title: 'control.1080p.H264.AAC.mp4', url: 'https://cdn.example.test/control.mp4' }] };
  }
  // THE LIVE EMPTY ANSWER, reproduced exactly. Measured 7 Sep 2026, before the
  // addon fix landed:
  //   GET addon.lyreosai.com/stream/movie/mwp:tv:14995.json -> {"streams":[]}
  // This is the case the fallback link exists for. MWP_EMPTY also carries the
  // live `refused` shape; MWP_LATE deliberately does not, so the sentence is
  // proven to appear only when there is something to say.
  if (id === MWP_EMPTY) return { streams: [], refused: REFUSED };
  return { streams: [] };
};

const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Every network rule both contexts in this file share. */
async function wireAddon(ctx, seen) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: titles });
      // The site search catalogs. `search=<q>` is a PATH segment in Stremio,
      // which is why this matches on pathname and not on a query parameter.
      const search = /^\/catalog\/movie\/([a-z-]+)\/search=([^/]+)\.json$/.exec(url.pathname);
      if (search) {
        seen.searched.push(`${search[1]}:${decodeURIComponent(search[2])}`);
        const prefix = search[1].startsWith('mwp') ? 'mwp:' : 'bs';
        return reply(route, { metas: titles.filter((t) => t.id.startsWith(prefix) && /baddies|silenze/i.test(t.name)) });
      }
      if (url.pathname.startsWith('/catalog/')) return reply(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        const found = titles.find((t) => t.id === id) || null;
        // The late-website case: the catalog row has none, /meta does.
        if (found && found.id === MWP_LATE) return reply(route, { meta: { ...found, website: LATE_SITE } });
        return reply(route, { meta: found });
      }
      if (url.pathname.startsWith('/stream/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop().replace('.json', ''));
        seen.streamed.push(id);
        return reply(route, streamsFor(id));
      }
      return reply(route, { metas: [], items: [], catalogs: [], streams: [] });
    }
    return reply(route, { metas: [], items: [], results: [] });
  });
}

const card = (page, name) => page.getByRole('button', { name: `View ${name}`, exact: true });

let browser;
try {
  browser = await launchBrowser();

  /* ================================================================= PART 1
     The detail panel: resolve, render, and the fallback when there is nothing.
  */
  const seen = { streamed: [], searched: [] };
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wireAddon(ctx, seen);
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  // ── 1a. A MrWorldPremiere title asks for streams and renders them ────────
  await card(page, 'Baddies USA Season 2 Episode 17').waitFor();
  assert.equal(
    await page.locator('.card:has-text("Baddies USA Season 2 Episode 17") .card-source').first().innerText(),
    'MWP', 'the card badge comes from the site table',
  );
  await card(page, 'Baddies USA Season 2 Episode 17').click();
  await page.locator('#detail-streams .stream-row').waitFor({ timeout: 20000 });
  assert.ok(seen.streamed.includes(MWP_PLAYS), `/stream was asked for ${MWP_PLAYS} — it never was before`);
  assert.match(await page.locator('#detail-streams').innerText(), /baddies-usa-s02e17/);
  assert.equal(await page.locator('#detail-source').innerText(), 'MrWorldPremiere source');
  assert.equal(await page.locator('#detail-play').isVisible(), true, 'Play is offered, not hidden');
  assert.equal(await page.locator('#detail-source-link').isHidden(), true,
    'the website link stays DEMOTED while a real stream exists');
  assert.equal(await page.locator('#detail-status').innerText(), '');
  await page.screenshot({ path: '/tmp/blazing-site-source-plays.png' });
  console.log(`PASS ${MWP_PLAYS} resolved and rendered its stream row, Play offered`);

  // ── 1b. An empty answer shows the page link, not a blank panel ───────────
  await page.locator('#detail-close').click();
  await card(page, 'Baddies Quiet Night').click();
  const link = page.locator('#detail-source-link');
  await link.waitFor({ state: 'visible', timeout: 20000 });
  assert.ok(seen.streamed.includes(MWP_EMPTY), 'the addon was still asked, even for the empty one');
  assert.equal(await page.locator('#detail-streams .stream-row').count(), 0);
  const emptyStatus = await page.locator('#detail-status').innerText();
  assert.match(emptyStatus,
    /No playable stream came back for this title yet\. Open the MrWorldPremiere page to watch it there\./);
  // THE `refused` ARRAY, read for the first time by any client. Without it the
  // panel says only "nothing came back", which reads as our bug rather than as
  // two hosts serving junk.
  assert.match(emptyStatus, /2 hosts had it \(voe\.sx and vidmoly\.org\)/);
  assert.match(emptyStatus, /jwplayer analytics pixel, not media/);
  assert.equal(await link.getAttribute('href'),
    'https://mrworldpremiere.tv/2026/09/05/baddies-quiet-night/');
  await page.screenshot({ path: '/tmp/blazing-site-source-empty.png' });
  console.log(`PASS ${MWP_EMPTY} answered empty → source page link revealed with a reason`);

  // ── 1c. THE SECOND PREFIX, through the same code ─────────────────────────
  await page.locator('#detail-close').click();
  assert.equal(
    await page.locator('.card:has-text("Silenze Mixtape Special") .card-source').first().innerText(),
    'BS', 'a BrokenSilenze card must not claim to be a MrWorldPremiere one',
  );
  await card(page, 'Silenze Mixtape Special').click();
  await page.locator('#detail-streams .stream-row').waitFor({ timeout: 20000 });
  assert.ok(seen.streamed.includes(BSZ_PLAYS), `/stream was asked for ${BSZ_PLAYS}`);
  assert.equal(await page.locator('#detail-source').innerText(), 'BrokenSilenze source');
  assert.match(await page.locator('#detail-streams').innerText(), /silenze-mixtape-special/);
  console.log(`PASS ${BSZ_PLAYS} resolved through the same path, labelled BrokenSilenze`);

  await page.locator('#detail-close').click();
  await card(page, 'Silenze Quiet Night').click();
  await link.waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('#detail-status').innerText(), /Open the BrokenSilenze page/);
  console.log(`PASS ${BSZ_EMPTY} answered empty → BrokenSilenze page link, no second branch needed`);

  // The alias row. `bsz:` was the prefix the brief predicted; keeping it in the
  // table costs one line and means a rename cannot silently un-label the site.
  await page.locator('#detail-close').click();
  await card(page, 'Silenze Alias Night').click();
  await link.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await page.locator('#detail-source').innerText(), 'BrokenSilenze source');
  console.log(`PASS ${BSZ_ALIAS} (the predicted spelling) is labelled BrokenSilenze too`);

  // ── 1c-bis. A website that only arrives with /meta still becomes the link ─
  await page.locator('#detail-close').click();
  await card(page, 'Baddies Late Meta').click();
  await link.waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await link.getAttribute('href'), LATE_SITE,
    'mergeFullMeta() must carry `website` across, or the fallback link has no target');
  const lateStatus = await page.locator('#detail-status').innerText();
  assert.match(lateStatus, /Open the MrWorldPremiere page/);
  assert.ok(!/hosts? had it/.test(lateStatus),
    'with no `refused` array there must be no refused sentence — a status line must not invent one');
  console.log(`PASS ${MWP_LATE} got its fallback link from /meta, not from the catalog row`);

  // ── 1d. The control. An ordinary title is untouched by all of it ──────────
  await page.locator('#detail-close').click();
  await card(page, 'Ordinary Control Movie').click();
  await page.locator('#detail-streams .stream-row').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#detail-source').isHidden(), true, 'no source pill on an imdb title');
  assert.equal(await link.isHidden(), true, 'no fallback link on an imdb title');
  assert.equal(
    await page.locator('.card:has-text("Ordinary Control Movie") .card-source').count(), 0,
    'no badge on an imdb title',
  );
  console.log('PASS an ordinary tt title is unchanged by the site-source path');

  /* ================================================================= PART 2
     Search. The site catalogs are discovered from the manifest, not named.
  */
  await page.locator('#detail-close').click();
  await page.locator('[data-view="search"]').first().click();
  await page.locator('#search-form input#search-input').fill('baddies');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => !(document.getElementById('search-status')?.textContent || '').includes('Searching'),
    null, { timeout: 45000 },
  );
  assert.ok(seen.searched.includes('mwp-search:baddies'),
    'the mwp-search catalog was queried DESPITE its extra being isRequired:true — ' +
    `the live shape; saw ${JSON.stringify(seen.searched)}`);
  assert.ok(seen.searched.includes('bsz-search:baddies'),
    'EVERY manifest catalog declaring a search extra is queried, in both spellings — ' +
    `not a hardcoded mwp-search; saw ${JSON.stringify(seen.searched)}`);
  assert.ok(!seen.searched.some((entry) => entry.startsWith('blazing-adult-search')),
    `the Adult catalog is NEVER queried from ordinary search; saw ${JSON.stringify(seen.searched)}`);
  await card(page, 'Baddies USA Season 2 Episode 17').first().waitFor({ timeout: 20000 });
  console.log(`PASS search queried ${seen.searched.length} discovered site catalogs and rendered the mwp row`);

  assert.deepEqual(faults, [], 'No browser runtime errors');
  await ctx.close();

  /* ================================================================= PART 3
     The referrer requirement is FORWARDED, not dropped.

     Observed through the Android shell bridge because that is a client whose
     player really can set request headers, and it is the only one whose
     payload this harness can read. A browser cannot send Referer or
     User-Agent at all — they are forbidden header names — which is why
     app.js keeps the requirement and reports it in the failure message
     instead of pretending.
  */
  const shell = await browser.newContext({ serviceWorkers: 'block' });
  await wireAddon(shell, { streamed: [], searched: [] });
  await prepareProfile(shell);
  await shell.addInitScript(() => {
    window.__blazingPlays = [];
    window.AndroidBridge = { postMessage: (payload) => window.__blazingPlays.push(payload) };
  });
  const shellPage = await shell.newPage();
  const shellFaults = [];
  shellPage.on('pageerror', (error) => shellFaults.push(error.message));
  await shellPage.goto(`${base}/index.html`);
  await selectProfile(shellPage);
  await card(shellPage, 'Baddies USA Season 2 Episode 17').click();
  await shellPage.locator('#detail-streams .stream-row').first().waitFor({ timeout: 20000 });
  await shellPage.locator('#detail-streams .stream-row').first().click();
  await shellPage.waitForFunction(() => (window.__blazingPlays || []).length > 0, null, { timeout: 10000 });
  const payload = JSON.parse(await shellPage.evaluate(() => window.__blazingPlays[0]));
  assert.equal(payload.cmd, 'play');
  assert.equal(payload.url, 'https://cdn.mwp.example.test/baddies-s02e17.mp4');
  assert.ok(payload.headers, 'the shell payload carries a headers object');
  assert.equal(payload.headers.referer, REFERER,
    'behaviorHints.proxyHeaders.request.Referer reaches the native player');
  assert.equal(payload.headers.userAgent, UA,
    'the User-Agent requirement reaches the native player too');
  console.log('PASS a Referer/User-Agent requirement is forwarded to the shell, not dropped');

  // The FLAT `referrer` field our own scrapers set must work as well as the
  // Stremio one — a row that only carries the flat form used to lose it.
  // No #detail-close here: the stream-row handler calls closeDetail() itself
  // right after openPlayer(), so the panel is already gone.
  await card(shellPage, 'Silenze Mixtape Special').click();
  await shellPage.locator('#detail-streams .stream-row').first().waitFor({ timeout: 20000 });
  await shellPage.locator('#detail-streams .stream-row').first().click();
  await shellPage.waitForFunction(() => (window.__blazingPlays || []).length > 1, null, { timeout: 10000 });
  const flat = JSON.parse(await shellPage.evaluate(() => window.__blazingPlays[1]));
  assert.equal(flat.headers.referer, 'https://www.brokensilenze.net/2026/09/silenze-mixtape-special.html',
    'a flat `referrer` field is read as well as behaviorHints.proxyHeaders');
  console.log('PASS the flat `referrer` field is read too');

  assert.deepEqual(shellFaults, [], 'No browser runtime errors in the shell context');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
