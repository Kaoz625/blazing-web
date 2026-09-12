// THE SAVED LIST LIVES ON THE FLEET, AND THERE ARE THREE OF THEM.
//
// AUDIT B27, B31 and B22. Until this ran, a title saved in the browser was
// written to localStorage['blazing-my-list-v2:<profile>'] and nowhere else. It
// never reached the Roku or the Fire Stick, a title saved on a TV never reached
// the browser, and clearing site data deleted it. There was also ONE list where
// the two TVs have had three since the lists work.
//
// Markus's standing rule: "roku, web, and firestick should all feel like im
// using the same app no matter what."
//
// ------------------------------------------------------ WHAT IS ACTUALLY PINNED
//
//   1. THE OLD LOCALSTORAGE LIST IS MOVED UP, NOT DROPPED. A browser that had
//      saved titles before this change must still have them after it. The
//      assertion is on the FLEET's copy, and on the legacy key being gone —
//      a migration that leaves the old key behind runs again every session.
//
//   2. THREE BUTTONS, IN THE TVs' ORDER, AND EACH LABEL SHOWS THE STATE IT IS
//      IN. Fire TV's rule (DetailActivity.kt:784): "a button that reads
//      '+ Watchlist' after you added it is the single most common way this kind
//      of control lies to people."
//
//   3. A SAVE IS A ROUND TRIP, WITH THE DEVICE TOKEN ON IT. The method, the
//      path and the X-Device-Token header are all asserted. Without the header
//      the fleet answers 401 on every /profiles route and the button correctly
//      but uselessly reports "Couldn't save".
//
//   4. A FAILED WRITE DOES NOT FLIP THE LABEL. This is the whole reason
//      BlazingLists.toggle returns three things (true / false / null) instead
//      of two, and it is the audit's own complaint in miniature: a control that
//      is drawn and does nothing is worse than no control.
//
//   5. THE LIBRARY SCREEN IS THE THREE SECTIONS, COUNTED. Fire TV's
//      ListsActivity, word for word — "Watchlist (1)", "Titles you plan to
//      watch", "This list is empty.", "2 saved titles".
//
//   6. REMOVE ASKS FIRST, AND KEEP MEANS KEEP. ListsActivity never writes
//      without a confirmation, and the safe answer takes focus.
//
//   7. A SECOND BROWSER SEES THE SAME LIST. This is B27 itself: a fresh context
//      with empty storage and the same device identity draws what the first one
//      saved. If this ever goes red the list is back in one browser.
//
// Everything is mocked at the network boundary. This is about THIS CLIENT.
//
//   node lists-fleet.smoke.mjs
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

const LEGACY_ID = 'tt5000001';
const LEGACY_NAME = 'The Old Favourite';
const TITLE_ID = 'tt5000002';
const TITLE_NAME = 'The New Arrival';

const title = {
  id: TITLE_ID, type: 'movie', name: TITLE_NAME, releaseInfo: '2026',
  contentRating: 'mature',
  description: 'A title to save, unsave and save again.',
  poster: 'https://img.example.test/new.jpg',
};

// The fixture fleet's list store, and the switch that makes one write fail.
const lists = { watchlist: [], collection: [], watched: [] };
const seen = { gets: 0, writes: [], tokens: new Set() };
let failNextWrite = false;

const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function listsRoute(url, route, request) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'profiles' || parts[2] !== 'lists') return false;
  seen.tokens.add(request.headers()['x-device-token'] || '');
  const name = parts[3] ? decodeURIComponent(parts[3]) : '';
  if (request.method() === 'GET' && !name) {
    seen.gets += 1;
    reply(route, lists);
    return true;
  }
  if (failNextWrite) {
    failNextWrite = false;
    seen.writes.push({ method: request.method(), list: name, id: parts[4] || null, refused: true });
    reply(route, { error: 'nope' }, 500);
    return true;
  }
  if (request.method() === 'POST' && lists[name]) {
    const item = JSON.parse(request.postData() || '{}');
    seen.writes.push({ method: 'POST', list: name, id: item.id });
    // Idempotent upsert, the way the server's POST is.
    lists[name] = [
      { ...item, addedAt: new Date(Date.now() + lists[name].length + 1).toISOString() },
      ...lists[name].filter((row) => row.id !== item.id),
    ];
    reply(route, { ok: true });
    return true;
  }
  if (request.method() === 'DELETE' && lists[name] && parts[4]) {
    const id = decodeURIComponent(parts[4]);
    seen.writes.push({ method: 'DELETE', list: name, id });
    lists[name] = lists[name].filter((row) => row.id !== id);
    reply(route, { ok: true });
    return true;
  }
  return false;
}

const manifest = { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] };

async function wire(ctx) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.hostname === 'fleet.lyreosai.com') {
      if (listsRoute(url, route, route.request())) return;
      return reply(route, { metas: [], items: [] });
    }
    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: [title] });
      if (url.pathname.startsWith('/catalog/')) return reply(route, { metas: [] });
      if (url.pathname.startsWith('/meta/')) return reply(route, { meta: title });
      if (url.pathname.startsWith('/stream/')) return reply(route, { streams: [] });
      return reply(route, { metas: [], streams: [] });
    }
    return reply(route, { metas: [], items: [], results: [] });
  });
}

const labelOf = (page, id) => page.locator(id).textContent();
const go = async (page, route) => {
  await page.evaluate((name) => showRoute(name), route);
};

let browser;
let pass = 0;
try {
  browser = await launchBrowser();

  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx);
  await prepareProfile(ctx);
  // The browser this viewer already had: one title in the old single list.
  await ctx.addInitScript((entry) => {
    localStorage.setItem('blazing-my-list-v2:p1', JSON.stringify([entry]));
  }, { id: LEGACY_ID, type: 'movie', name: LEGACY_NAME, poster: 'https://img.example.test/old.jpg', contentRating: 'mature' });

  const faults = [];
  const page = await ctx.newPage();
  page.on('pageerror', (error) => faults.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  /* ===================================================================== 1
     THE OLD BROWSER-LOCAL LIST IS MOVED UP, NOT DROPPED.
  */
  await page.waitForFunction(
    (id) => window.BlazingLists?.contains('watchlist', id) === true,
    LEGACY_ID,
    { timeout: 30000 },
  );
  assert.deepEqual(
    lists.watchlist.map((row) => row.id), [LEGACY_ID],
    'the localStorage list was written to the fleet, not discarded',
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('blazing-my-list-v2:p1')), null,
    'and the legacy key is cleared, so the migration does not run again',
  );
  pass += 1;
  console.log('ok    1  the old localStorage list migrated to the fleet');

  /* ===================================================================== 2
     THREE BUTTONS, IN THE TVs' ORDER, EACH SHOWING THE STATE IT IS IN.
  */
  const card = page.getByRole('button', { name: `View ${TITLE_NAME}`, exact: true });
  await card.waitFor({ timeout: 30000 });
  await card.click();
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 30000 });
  assert.deepEqual(
    await page.evaluate(() => ['#detail-save', '#detail-collection', '#detail-watched']
      .map((id) => document.querySelector(id)?.textContent)),
    ['+ Watchlist', '+ Collection', 'Mark watched'],
    "the Roku's three labels, in the Roku's order",
  );
  pass += 1;
  console.log('ok    2  three list buttons, in the TVs’ order');

  /* ===================================================================== 3
     A SAVE IS A ROUND TRIP, WITH THE DEVICE TOKEN ON IT.
  */
  seen.writes.length = 0;
  await page.locator('#detail-collection').click();
  await page.waitForFunction(() => document.querySelector('#detail-collection').textContent.startsWith('✓'), null, { timeout: 30000 });
  assert.equal(await labelOf(page, '#detail-collection'), '✓ In collection', 'the label shows the state it is now IN');
  assert.deepEqual(seen.writes, [{ method: 'POST', list: 'collection', id: TITLE_ID }], 'one POST, to the collection route');
  assert.deepEqual(lists.collection.map((row) => row.id), [TITLE_ID], 'and the fleet holds it');
  assert.deepEqual([...seen.tokens], ['tok'], 'every /profiles call carried X-Device-Token');
  pass += 1;
  console.log('ok    3  a save reaches the fleet with the device token');

  /* ===================================================================== 4
     PRESSING IT AGAIN REMOVES IT.
  */
  seen.writes.length = 0;
  await page.locator('#detail-collection').click();
  await page.waitForFunction(() => document.querySelector('#detail-collection').textContent === '+ Collection', null, { timeout: 30000 });
  assert.deepEqual(seen.writes, [{ method: 'DELETE', list: 'collection', id: TITLE_ID }], 'one DELETE, to the item route');
  assert.deepEqual(lists.collection, [], 'and the fleet no longer holds it');
  pass += 1;
  console.log('ok    4  pressing it again removes it from the fleet');

  /* ===================================================================== 5
     A FAILED WRITE SAYS SO, AND DOES NOT FLIP THE LABEL.
  */
  failNextWrite = true;
  await page.locator('#detail-watched').click();
  await page.waitForFunction(
    () => document.querySelector('#detail-watched').textContent.startsWith('Couldn'),
    null,
    { timeout: 30000 },
  );
  assert.equal(
    await labelOf(page, '#detail-watched'), 'Couldn’t save — try again',
    'a refused write admits it rather than pretending it saved',
  );
  assert.deepEqual(lists.watched, [], 'and nothing was recorded anywhere');
  pass += 1;
  console.log('ok    5  a failed write does not flip the label');

  // Retry from the same button, which is the same gesture.
  await page.locator('#detail-watched').click();
  await page.waitForFunction(() => document.querySelector('#detail-watched').textContent === '✓ Watched', null, { timeout: 30000 });
  assert.deepEqual(lists.watched.map((row) => row.id), [TITLE_ID], 'the retry saved');

  /* ===================================================================== 6
     THE LIBRARY SCREEN IS THE THREE SECTIONS, COUNTED.
  */
  await page.locator('#detail-close').click();
  await go(page, 'library');
  await page.locator('#library-results .list-section').first().waitFor({ timeout: 30000 });
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('#library-results .list-section .row-title')].map((n) => n.textContent)),
    ['Watchlist (1)', 'Collection (0)', 'Watched (1)'],
    "Fire TV's three sections, in its order, each with its count",
  );
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll('#library-results .list-section-copy')].map((n) => n.textContent)),
    ['Titles you plan to watch', 'Titles you want to keep', 'Titles you finished'],
    'and ListsActivity’s three descriptions, word for word',
  );
  assert.equal(
    await page.locator('#library-status').textContent(), '2 saved titles',
    'the total is counted the way ListsActivity counts it',
  );
  assert.equal(
    await page.locator('#library-results [data-list="collection"] .empty-copy').textContent(),
    'This list is empty.',
    'an empty section says so instead of vanishing',
  );
  pass += 1;
  console.log('ok    6  the Library screen is the three counted sections');

  /* ===================================================================== 7
     REMOVE ASKS FIRST, AND KEEP MEANS KEEP.
  */
  const row = page.locator('#library-results [data-list="watchlist"] .list-item').first();
  await row.locator('.list-remove').click();
  assert.equal(
    await row.locator('.list-confirm-copy').textContent(),
    `Remove ${LEGACY_NAME} from your Watchlist?`,
    'it asks before it writes, in ListsActivity’s words',
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.className), 'list-keep',
    'and the SAFE answer has the focus',
  );
  seen.writes.length = 0;
  await row.locator('.list-keep').click();
  assert.deepEqual(seen.writes, [], 'Keep writes nothing');
  assert.deepEqual(lists.watchlist.map((r) => r.id), [LEGACY_ID], 'and the title is still saved');

  await row.locator('.list-remove').click();
  await row.locator('.list-keep').waitFor({ timeout: 30000 });
  await row.locator('.list-remove').click();
  await page.waitForFunction(
    () => document.querySelector('#library-results [data-list="watchlist"] .row-title')?.textContent === 'Watchlist (0)',
    null,
    { timeout: 30000 },
  );
  assert.deepEqual(seen.writes, [{ method: 'DELETE', list: 'watchlist', id: LEGACY_ID }], 'Remove writes once');
  assert.equal(await page.locator('#library-status').textContent(), '1 saved title', 'and the singular is a singular');
  pass += 1;
  console.log('ok    7  Remove asks first, and Keep means keep');

  /* ===================================================================== 8
     A SECOND BROWSER SEES THE SAME LIST. THIS IS B27.
  */
  const other = await browser.newContext({ serviceWorkers: 'block' });
  await wire(other);
  await prepareProfile(other);
  const second = await other.newPage();
  second.on('pageerror', (error) => faults.push(error.message));
  await second.goto(`${base}/index.html`);
  await selectProfile(second);
  await go(second, 'library');
  await second.waitForFunction(
    () => document.querySelector('#library-results [data-list="watched"] .row-title')?.textContent === 'Watched (1)',
    null,
    { timeout: 30000 },
  );
  assert.match(
    await second.locator('#library-results').innerText(), new RegExp(TITLE_NAME),
    'a browser that has never saved anything still sees the household’s list',
  );
  assert.equal(
    await second.evaluate(() => localStorage.getItem('blazing-my-list-v2:p1')), null,
    'and it was never the store: nothing was read from the old key',
  );
  pass += 1;
  console.log('ok    8  a second browser sees the same fleet-backed list');

  assert.deepEqual(faults, [], 'No browser errors');
  console.log(`\nPASS  ${pass}/8  B27 + B31 + B22: the saved list is on the fleet`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
