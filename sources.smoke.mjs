/**
 * Stream Sources (audit B2) — the read-only add-on directory, driven for real.
 *
 * The browser had NO such screen. Measured at 2d04285, before any of this
 * landed: `grep -c 'data-view="sources"' index.html` answered 0, and
 * `grep -rn addon_catalog` over the whole repo answered nothing at all — so
 * there was no destination, no view and no directory fetch of any kind, while
 * the Roku, the Fire TV and the Apple TV have all had the screen for weeks.
 *
 * WHAT THIS FILE IS FOR, and it is not "a Stream Sources row exists". The audit
 * B2 opened with is about controls that claim to be something they are not, so
 * the four claims worth pinning are:
 *
 *   1. THE ROW IS IN THE DRAWER AND NOT IN THE BAR. Both televisions put it
 *      last before Settings (tvOS NavBar.swift:144 drawerOrder) and neither
 *      puts it on a bar. A chip in .topnav would be a fourth arrangement.
 *   2. IT IS READ-ONLY, PROVEN ON THE WIRE. tvOS gives every row a Button with
 *      an EMPTY action and says why: a browser can install neither a Stremio
 *      add-on (that registry is per-Roku) nor a Kodi add-on (Python, on the
 *      server), so a switch here would be a control that does nothing. This
 *      file clicks every row and then asserts that NOTHING left the browser
 *      except GETs, and that the view holds no field, no select and no button
 *      whose words promise a write.
 *   3. A DEAD FEED SAYS SO. An empty list under a heading reads as "you have no
 *      sources", which is the silent no-op this whole audit exists to catch.
 *   4. THE GATE HOLDS (B13, already closed on this client and not to be
 *      reopened). A Kids profile and a capped profile each get neither the row
 *      nor the content — and the fetch never leaves the browser either, so the
 *      screen cannot be walked round.
 *
 * The fixture below is shaped from the live feed's real oddities rather than
 * invented: `resources` arrives as a MIX of plain strings and {name,types}
 * objects, a third of the community list carries configurationRequired, some
 * transportUrls are not http at all, and the same add-on appears in both feeds.
 * Every one of those is an assertion here, because each is a line of sources.js
 * that would otherwise be untested.
 *
 *   node sources.smoke.mjs
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
  // browser DOWNLOAD the page instead of rendering it.
  const name = raw === '/' ? 'index.html' : raw;
  try {
    const body = await readFile(join(ROOT, name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let pass = 0, fail = 0;
const ok = (condition, label, detail = '') => {
  if (condition) { pass += 1; console.log('ok   ', label, detail); }
  else { fail += 1; console.log('FAIL ', label, detail); }
};

/* THE ROKU'S OWN SENTENCE, from
   roku channels/components/screens/AddonsScreen.brs:28, repeated verbatim by
   tvOS at StreamSourcesView.swift:354. All three clients say these words so
   that nobody arrives here expecting the Fire Stick's screen. If this literal
   and sources.js ever disagree, one of the three clients has drifted. */
const ROKU_FOOTER = 'Kodi add-ons cannot run here - they are Python. These speak the Stremio protocol, which is plain HTTP, which is why a Roku can use them.';
/** The Roku's sentence for a directory that did not answer. */
const DEAD_DIRECTORY = 'Could not reach the add-on directory - check the network.';

/* A description longer than sources.js's 260-character clip. Real manifests run
   well past it, and a panel that renders one whole pushes the footer off the
   screen. */
const LONG_DESCRIPTION = `Trakt lists. ${'x'.repeat(400)}`;

/**
 * The two Cinemeta feeds, shaped from the live directory's real oddities.
 *
 * Between them these exercise every branch of `loadDirectory`: plain-string
 * resources, {name} object resources, configurationRequired, a transportUrl
 * that is not http, a transportUrl with a trailing slash and no
 * /manifest.json, an entry with no manifest at all, and the SAME add-on in both
 * feeds. Expected survivors, in order: Torrentio, Cinemeta, Trakt (official),
 * then MediaFusion, Comet (community) — five rows.
 */
const OFFICIAL = {
  addons: [
    { transportUrl: 'https://torrentio.strem.fun/manifest.json',
      manifest: { name: 'Torrentio', description: 'Torrent streams from scraped providers.', types: ['movie', 'series'], resources: ['stream'] } },
    // `resources` as OBJECTS. A strict [String] decode throws here and takes
    // the whole catalogue with it — tvOS decodes it by hand for this reason.
    { transportUrl: 'https://v3-cinemeta.strem.io/manifest.json',
      manifest: { name: 'Cinemeta', description: 'The catalogue behind every row in this app.', types: ['movie', 'series'], resources: [{ name: 'catalog', types: ['movie'] }, { name: 'meta' }] } },
    // NOT http. The Roku's AddonBaseFromManifestUrl drops it and so must this.
    { transportUrl: 'stremio://local-files/manifest.json',
      manifest: { name: 'Local Files', description: 'Plays files off the device.', types: ['other'], resources: ['catalog'] } },
    { transportUrl: 'https://trakt.example.test/manifest.json',
      manifest: { name: 'Trakt', description: LONG_DESCRIPTION, types: ['movie', 'series', 'anime', 'other', 'fifth'], resources: ['stream', { name: 'catalog' }], behaviorHints: { configurationRequired: true } } },
  ],
};
const COMMUNITY = {
  addons: [
    // THE SAME BASE AS THE OFFICIAL TORRENTIO. Official is read first, so this
    // copy must be dropped whole — name included.
    { transportUrl: 'https://torrentio.strem.fun/manifest.json',
      manifest: { name: 'Torrentio (community fork)', description: 'A second listing of the same add-on.', types: ['movie'], resources: ['stream'] } },
    // No /manifest.json and a trailing slash — the other shape the directory
    // really publishes.
    { transportUrl: 'https://mediafusion.example.test/',
      manifest: { name: 'MediaFusion', description: 'Needs a debrid key before it answers with anything playable.', types: ['movie', 'series'], resources: ['stream'], behaviorHints: { configurationRequired: true } } },
    { transportUrl: 'https://comet.example.test/manifest.json',
      manifest: { name: 'Comet', description: 'A debrid-backed indexer.', types: ['movie', 'series'], resources: ['stream'] } },
    // No manifest at all. Dropped without throwing.
    { transportUrl: 'https://broken.example.test/manifest.json' },
  ],
};

/** The aggregator's own account of itself, plus the catalogs app.js boots on. */
const AGGREGATOR = {
  name: 'Blazing Aggregator',
  version: '3.7.0',
  description: 'Fans one request out to its own upstreams server-side.',
  types: ['movie', 'series'],
  resources: ['stream', 'catalog'],
  catalogs: [
    { id: 'blazing-movies', type: 'movie', name: 'Movies' },
    { id: 'blazing-series', type: 'series', name: 'Shows' },
    { id: 'blazing-anime', type: 'series', name: 'Anime' },
  ],
};

/* The household. Alex is a grown-up (not Kids, rated 'mature'); Kit is a Kids
   profile; Robin is the OTHER half of settings.js:330-333 `grownUp` — not a
   Kids profile at all, just capped below 'mature'. Both halves are gated, and a
   fixture with only a Kids profile would leave the second one untested. */
const PROFILES = [
  { id: 'p-alex', name: 'Alex', avatar: '🦊', maxRating: 'mature', allowAdult: false, isKids: false, hasPin: false },
  { id: 'p-kit', name: 'Kit', avatar: '🐻', maxRating: 'general', allowAdult: false, isKids: true, hasPin: false },
  { id: 'p-robin', name: 'Robin', avatar: '🦉', maxRating: 'teen', allowAdult: false, isKids: false, hasPin: false },
];

/** Every request the browser made, so read-only can be asserted on the WIRE. */
const wire = [];
const faults = [];

/**
 * One isolated browser context per case.
 *
 * Separate contexts rather than one page re-navigated: `localStorage.profileId`
 * survives a reload, so a later case would silently inherit the profile an
 * earlier one selected, and sources.js caches the directory per page. A fresh
 * context is the only way each case starts from the state it claims to test.
 */
async function open(browser, { feed = 'ok' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-src', token: 'fixture-token' }));
    localStorage.setItem('blazing-household-approved', '1');
  });
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const method = route.request().method();

    if (url.hostname === 'v3-cinemeta.strem.io') {
      if (url.pathname.startsWith('/addon_catalog/')) {
        // THE FAILURE CASE IS A REAL 503, not a stubbed empty list. An empty
        // `{addons:[]}` would exercise the same code path as a working feed
        // that happens to be empty, which is not the case this is testing.
        if (feed === 'dead') return route.fulfill({ status: 503, contentType: 'text/plain', body: 'nope' });
        return json(route, url.pathname.includes('official') ? OFFICIAL : COMMUNITY);
      }
      return json(route, {});
    }

    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return json(route, AGGREGATOR);
      if (url.pathname.includes('/api/ui/home-config')) return route.fulfill({ status: 404, body: 'no' });
      return json(route, { metas: [], items: [] });
    }

    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles' && method === 'GET') return json(route, { profiles: PROFILES });
      if (url.pathname === '/accounts/me') {
        return json(route, { account: { id: 'acc', name: 'Fixture' }, device: { id: 'dev-src', enrollmentStatus: 'approved' } });
      }
      if (url.pathname === '/devices/register') {
        return json(route, { ok: true, device: { id: 'dev-src', status: 'approved' }, token: 'fixture-token' });
      }
      return json(route, {});
    }

    return json(route, {});
  });

  const page = await ctx.newPage();
  page.on('pageerror', (error) => faults.push(String(error).slice(0, 160)));
  page.on('request', (request) => wire.push({ method: request.method(), url: request.url() }));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

async function choose(page, name) {
  const tile = page.getByRole('button', { name: `Choose ${name}`, exact: true });
  if (!(await tile.isVisible().catch(() => false))) {
    await page.evaluate(() => window.BlazingProfile && window.BlazingProfile.open());
  }
  await tile.waitFor({ timeout: 12000 });
  await tile.click();
  await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden === true, null, { timeout: 12000 });
}

/** Press the drawer row the way a viewer does, not by typing a route. */
const openSources = (page) => page.evaluate(() => document.querySelector('.drawer-nav [data-view="sources"]').click());

const drawerState = (page) => page.evaluate(() => {
  const row = document.querySelector('.drawer-nav [data-view="sources"]');
  return {
    inDrawer: Boolean(row),
    /* NOT offsetParent. The drawer itself is `hidden` whenever it is closed —
       which at 1440px is always, because .topnav carries navigation at that
       width — so every button in it measures as unrendered and the check would
       pass for a row that is perfectly on offer. The mechanism IS the `hidden`
       attribute plus styles.css:117's `[hidden]{display:none!important}`, so
       measure exactly that: the attribute, and the computed display it forces
       on this element regardless of the ancestor. */
    offered: Boolean(row) && row.hidden === false && getComputedStyle(row).display !== 'none',
    label: row ? (row.textContent || '').trim() : '',
    // The drawer order both televisions use: last before Settings.
    order: [...document.querySelectorAll('.drawer-nav [data-view]')].map((b) => b.dataset.view),
    inTopBar: [...document.querySelectorAll('.topnav [data-view]')].map((b) => b.dataset.view).includes('sources'),
  };
});

let browser;
try {
  browser = await launchBrowser();

  /* ═══ 1. A grown-up profile: the row, the view and the rows ═════════════ */
  const grown = await open(browser);
  await choose(grown.page, 'Alex');

  const drawer = await drawerState(grown.page);
  ok(drawer.inDrawer && drawer.offered,
    'B2: a grown-up profile gets a Stream Sources row in the drawer', `(${drawer.label})`);
  ok(drawer.label === 'Stream Sources',
    'and it is called Stream Sources, not Sources — the detail sheet already owns that word', `(${drawer.label})`);
  ok(!drawer.inTopBar,
    'and it is NOT a chip in the canonical top bar, which neither television puts it on');
  ok(drawer.order.indexOf('sources') === drawer.order.indexOf('settings') - 1,
    'it sits last before Settings, the position tvOS NavBar.swift:144 puts it in',
    `(… ${drawer.order.slice(-3).join(' → ')})`);

  await openSources(grown.page);
  await grown.page.waitForSelector('#sources-view:not([hidden]) #sources-list .sources-row', { timeout: 15000 });
  ok(true, 'B2: pressing the row opens a real #sources-view with rows in it');

  const list = await grown.page.evaluate(() => ({
    names: [...document.querySelectorAll('#sources-list .sources-row .sources-row-name')].map((n) => n.textContent),
    metas: [...document.querySelectorAll('#sources-list .sources-row .sources-row-meta')].map((n) => n.textContent),
    status: (document.getElementById('sources-status') || {}).textContent || '',
    readonly: (document.getElementById('sources-readonly') || {}).textContent || '',
  }));
  ok(list.names.length === 5,
    'both feeds are read and every add-on that survives the Roku\'s own rules is drawn',
    `(${list.names.length}: ${list.names.join(', ')})`);
  ok(list.names.join('|') === 'Torrentio|Cinemeta|Trakt|MediaFusion|Comet',
    'official first, then community — the Roku\'s order, which puts the recognisable ones on top',
    `(${list.names.join(' → ')})`);
  ok(!list.names.includes('Local Files'),
    'a transportUrl that is not http is dropped, exactly as AddonBaseFromManifestUrl drops it');
  ok(!list.names.some((n) => n.includes('community fork')) && list.names.filter((n) => n === 'Torrentio').length === 1,
    'the same add-on listed in BOTH feeds is drawn once, and it keeps the official listing');
  ok(list.metas[0] === 'streams  ·  Official',
    'the row meta is the Roku\'s RowMeta, minus the INSTALLED tag that has no meaning here', `(${list.metas[0]})`);
  ok(list.metas[1] === 'catalogs  ·  Official',
    'a manifest whose `resources` are OBJECTS is read, not thrown away with the rest of the feed', `(${list.metas[1]})`);
  ok(list.metas[2] === 'streams  ·  catalogs  ·  needs setup  ·  Official',
    'configurationRequired is surfaced as the Roku\'s own "needs setup"', `(${list.metas[2]})`);
  ok(list.metas[3] === 'streams  ·  needs setup  ·  Community',
    'a transportUrl with a trailing slash and no /manifest.json still resolves to a base', `(${list.metas[3]})`);
  ok(/^5 add-ons in the Stremio directory$/.test(list.status.trim()),
    'and the screen says how many it found', `(${list.status.trim()})`);
  ok(/read only/i.test(list.readonly), 'it says out loud that it is read only', `(${list.readonly.trim()})`);

  /* The aggregator — the actual answer to the question the screen's name asks,
     and the reason it is drawn ABOVE the directory rather than below it. */
  const card = await grown.page.evaluate(() => {
    const node = document.getElementById('sources-aggregator');
    return node ? node.innerText.replace(/\s+/g, ' ').trim() : '';
  });
  ok(card.includes('THIS BROWSER') && card.includes('Blazing Aggregator')
    && card.includes('addon.lyreosai.com') && card.includes('Fans one request out'),
    'the aggregator\'s own /manifest.json is read live and shown first — it is what actually resolves a stream',
    `(${card.slice(0, 70)}…)`);
  ok(card.includes('3 catalogues'), 'including how many catalogues it serves', `(${card.slice(0, 70)}…)`);

  /* The detail panel, which is the whole of what a row press can mean here. */
  const firstDetail = await grown.page.evaluate(() =>
    (document.querySelector('#sources-detail .sources-detail-title') || {}).textContent || '');
  ok(firstDetail === 'Torrentio', 'the panel opens on the first add-on, so it is never empty', `(${firstDetail})`);

  await grown.page.locator('.sources-row[data-base="https://mediafusion.example.test"]').click();
  const detail = await grown.page.evaluate(() => ({
    title: (document.querySelector('#sources-detail .sources-detail-title') || {}).textContent || '',
    copy: [...document.querySelectorAll('#sources-detail .sources-detail-copy')].map((n) => n.textContent),
    footer: [...document.querySelectorAll('#sources-footer .sources-footer-line')].map((n) => n.textContent),
  }));
  ok(detail.title === 'MediaFusion', 'pressing a row moves the panel onto it', `(${detail.title})`);
  ok(detail.copy.some((line) => line.startsWith('Configure this one on its own website first.')),
    'a "needs setup" add-on carries the Roku\'s own explanation of what that means');
  ok(detail.copy.some((line) => line.includes('not in this browser')),
    'and it names the thing the reader is actually holding, so the instruction is followable');

  await grown.page.locator('.sources-row[data-base="https://trakt.example.test"]').click();
  const clipped = await grown.page.evaluate(() =>
    [...document.querySelectorAll('#sources-detail .sources-detail-copy')].map((n) => n.textContent)[0] || '');
  ok(clipped.length === 261 && clipped.endsWith('…'),
    'a long manifest description is clipped rather than pushing the footer off the screen',
    `(${clipped.length} chars)`);

  /* THE FOCUS PATH, which is the only one a D-pad has — and this same file is
     what a webOS and a Tizen television run. tvOS fills its panel on focus
     rather than on press for exactly that reason.

     The second assertion is the one that matters. Selecting used to re-render
     the whole host, and the row is wired to `focus`, so a rebuild tore the
     element out from under the very focus event that asked for it and then put
     focus back by hand, inside the handler. Re-entrant DOM work like that is
     the classic pass-in-one-browser-fail-in-the-other, which is the shape this
     repo's CI split exists to catch. */
  await grown.page.evaluate(() =>
    document.querySelector('.sources-row[data-base="https://comet.example.test"]').focus());
  const byFocus = await grown.page.evaluate(() => ({
    title: (document.querySelector('#sources-detail .sources-detail-title') || {}).textContent || '',
    stillFocused: document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.base || '' : '',
    pressed: [...document.querySelectorAll('.sources-row[aria-pressed="true"]')].map((n) => n.dataset.base),
  }));
  ok(byFocus.title === 'Comet',
    'arriving on a row by keyboard or D-pad fills the panel, without a press', `(${byFocus.title})`);
  ok(byFocus.stillFocused === 'https://comet.example.test',
    'and the row keeps the focus it just took — the list is not rebuilt underneath it',
    `(${byFocus.stillFocused})`);
  ok(byFocus.pressed.length === 1 && byFocus.pressed[0] === 'https://comet.example.test',
    'exactly one row reads as selected', `(${byFocus.pressed.join(', ')})`);

  ok(detail.footer[0] === ROKU_FOOTER,
    'THE FOOTER IS THE ROKU\'S SENTENCE, word for word — all three clients say the same thing about Kodi',
    detail.footer[0] === ROKU_FOOTER ? '' : `(${detail.footer[0]})`);
  ok((detail.footer[1] || '').startsWith('This browser installs neither.'),
    'and this client\'s half of the same truth says where a source IS switched on');

  /* ═══ 2. READ-ONLY, proven in the DOM and on the wire ═══════════════════ */
  // Press EVERY row first. A write path that only fires on a press would sit
  // green through an assertion taken before anybody pressed anything.
  const rowCount = await grown.page.locator('#sources-list .sources-row').count();
  for (let index = 0; index < rowCount; index += 1) {
    await grown.page.locator('#sources-list .sources-row').nth(index).click();
  }

  const controls = await grown.page.evaluate(() => {
    const view = document.getElementById('sources-view');
    const text = (node) => (node.textContent || '').trim();
    return {
      fields: view.querySelectorAll('input, select, textarea, [contenteditable="true"]').length,
      // Every button in the view, by its words. A row is allowed; anything that
      // promises to change something is not.
      buttons: [...view.querySelectorAll('button')].map(text),
      rows: view.querySelectorAll('.sources-row').length,
      forms: view.querySelectorAll('form').length,
    };
  });
  const WRITE_WORDS = /\b(install|uninstall|add|save|sync|enable|disable|remove|delete|apply|toggle|switch on|switch off|turn on|turn off)\b/i;
  ok(controls.fields === 0,
    'READ-ONLY: the view holds no input, select, textarea or editable box at all', `(${controls.fields})`);
  ok(controls.forms === 0, 'and no form to submit', `(${controls.forms})`);
  ok(controls.buttons.length === controls.rows,
    'every button in the view is an add-on row — there is no control beside them',
    `(${controls.buttons.length} buttons, ${controls.rows} rows)`);
  ok(!controls.buttons.some((label) => WRITE_WORDS.test(label)),
    'and not one of them promises to change anything',
    controls.buttons.filter((label) => WRITE_WORDS.test(label)).join(' | '));

  // THE WIRE IS THE ASSERTION THAT MATTERS. A control that is drawn but does
  // nothing is the defect this audit opened with; its opposite — a row that
  // quietly writes — would pass every DOM check above.
  const writes = wire.filter((entry) => entry.method !== 'GET');
  const sourceWrites = writes.filter((entry) =>
    entry.url.includes('v3-cinemeta.strem.io')
    || entry.url.includes('addon.lyreosai.com')
    || entry.url.includes('/account/secret')
    || entry.url.includes('/device/live/sources'));
  ok(sourceWrites.length === 0,
    'READ-ONLY on the wire: clicking every row wrote nothing to the directory, the aggregator or the account',
    sourceWrites.map((entry) => `${entry.method} ${entry.url}`).join(' | '));
  const catalogCalls = wire.filter((entry) => entry.url.includes('/addon_catalog/'));
  ok(catalogCalls.length === 2 && catalogCalls.every((entry) => entry.method === 'GET'),
    'the directory is two GETs and is not re-asked for on every render',
    `(${catalogCalls.length}: ${catalogCalls.map((entry) => entry.method).join(',')})`);
  await grown.ctx.close();

  /* ═══ 3. A dead feed says so, instead of reading as "no sources" ════════ */
  const dead = await open(browser, { feed: 'dead' });
  await choose(dead.page, 'Alex');
  await openSources(dead.page);
  await dead.page.waitForSelector('#sources-empty', { timeout: 15000 });
  const deadState = await dead.page.evaluate(() => ({
    rows: document.querySelectorAll('#sources-list .sources-row').length,
    status: (document.getElementById('sources-status') || {}).textContent || '',
    empty: (document.getElementById('sources-empty') || {}).textContent || '',
    aggregator: Boolean(document.getElementById('sources-aggregator')),
  }));
  ok(deadState.rows === 0 && deadState.status.trim() === DEAD_DIRECTORY,
    'a directory that does not answer says so in the Roku\'s own words', `(${deadState.status.trim()})`);
  ok(deadState.empty.trim() === DEAD_DIRECTORY,
    'and it says it AGAIN where the rows would have been, so the list cannot read as "you have no sources"');
  ok(deadState.aggregator,
    'while the aggregator card still stands — the one thing that did answer is still the answer');
  await dead.ctx.close();

  /* ═══ 4. B13: the gate, both halves ════════════════════════════════════ */
  const kids = await open(browser);
  await choose(kids.page, 'Kit');
  const kidsDrawer = await drawerState(kids.page);
  ok(kidsDrawer.inDrawer && !kidsDrawer.offered,
    'B13: a Kids profile is offered no Stream Sources row at all');

  // AND IT CANNOT BE WALKED ROUND. Press the row by hand anyway: the view opens
  // — every view does — and has to refuse on its own rather than lean on a
  // hidden button.
  const before = wire.filter((entry) => entry.url.includes('/addon_catalog/')).length;
  await openSources(kids.page);
  await kids.page.waitForSelector('#sources-view:not([hidden]) #sources-gate', { timeout: 12000 });
  const kidsView = await kids.page.evaluate(() => ({
    gate: (document.getElementById('sources-gate') || {}).textContent || '',
    rows: document.querySelectorAll('#sources-view .sources-row').length,
    list: Boolean(document.getElementById('sources-list')),
    aggregator: Boolean(document.getElementById('sources-aggregator')),
    footer: Boolean(document.getElementById('sources-footer')),
  }));
  ok(kidsView.rows === 0 && !kidsView.list && !kidsView.aggregator && !kidsView.footer,
    'B13: and opening the route by hand draws no list, no aggregator and no add-on');
  ok(/rating limit/.test(kidsView.gate),
    'it draws one line saying why, the way settings.js:475 does', `(${kidsView.gate.trim()})`);
  const after = wire.filter((entry) => entry.url.includes('/addon_catalog/')).length;
  ok(after === before,
    'B13: and the directory was never even asked for — the gate is before the fetch, not over it',
    `(${after - before} requests)`);

  /* The OTHER half of grownUp(): capped below 'mature', but not a Kids profile
     at all. A fixture with only a Kids profile leaves this arm untested, and it
     is the arm an ordinary teenager's profile actually takes. */
  await choose(kids.page, 'Robin');
  const cappedDrawer = await drawerState(kids.page);
  ok(cappedDrawer.inDrawer && !cappedDrawer.offered,
    'B13: a profile capped below "mature" gets no row either, Kids flag or not');
  await openSources(kids.page);
  await kids.page.waitForSelector('#sources-view:not([hidden]) #sources-gate', { timeout: 12000 });
  const cappedRows = await kids.page.locator('#sources-view .sources-row').count();
  ok(cappedRows === 0, 'and no add-on is drawn for it either', `(${cappedRows})`);

  /* Back to a grown-up WITHOUT LEAVING THE SCREEN, and that is the point of
     this block rather than a tidy-up at the end.
     app.js's blazing-profile-selected listener does NOT call showRoute — grep
     it: the route a viewer is standing on survives a profile switch — so
     switching profiles here re-runs nothing. The first cut of sources.js
     re-rendered on that event and never fetched, which left the screen sitting
     on "Loading the add-on directory…" for ever with nothing in flight: a
     status line telling the truth about the present and lying about the future,
     which is the silent no-op in its most convincing form. Nothing below
     presses the drawer row again, so only the fix can make this pass. */
  await choose(kids.page, 'Alex');
  const reopened = await drawerState(kids.page);
  ok(reopened.offered, 'switching back to a grown-up profile returns the row without a reload');
  await kids.page.waitForSelector('#sources-list .sources-row', { timeout: 15000 });
  const reopenedRows = await kids.page.locator('#sources-list .sources-row').count();
  ok(reopenedRows === 5,
    'and the directory it was refused loads WHERE THE VIEWER IS STANDING, with no second press',
    `(${reopenedRows})`);
  ok(!(await kids.page.locator('#sources-view').isHidden()),
    'without the router having been re-run at all');
  await kids.ctx.close();

  ok(faults.length === 0, 'no page threw on the way through', faults.slice(0, 3).join(' | '));
} finally {
  await browser?.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
