/**
 * The Settings screen and the parental controls, driven for real.
 *
 * B32 / B35 — the web had no settings screen at all: no view, no route, no
 * chip. B1 / B3 / B15 / B28 — it had no parental surface either, and a PIN
 * could never be created, changed or removed from a browser. B13 — changing
 * where content comes from has to be grown-up only.
 *
 * The point of this file is the sentence the audit itself makes: "A control
 * that is drawn but does nothing is worse than no control." So nothing here
 * asserts that a row EXISTS. Every assertion presses a control and then checks
 * the request that left the browser, or the value that was stored.
 *
 * 12 Sep 2026 — the same sentence applied to this file. It drove the add-on row
 * with a 43-character URL and the Live TV row with a 37-character one, and it
 * seeded the account with NO stored value at all, so it sat green through a
 * defect that silently destroyed a household's add-on list: accountSecret() was
 * handing the account's stored value back through text(), the 160-character
 * display-name cap, and settings.js wrote that shortened value back to the
 * account record every approved Roku, Fire TV and Apple TV reads. A harness
 * that reports safety it never tested is worse than no harness. The fixture is
 * now 913 characters across two add-ons and 202 on the playlist, and the three
 * assertions that check them are string-length assertions on the VALUE — see
 * STORED_ADDONS and LIVE_PLAYLIST below. Measured against the pre-fix
 * profile.js they read 160/913 (1 of 2 add-ons) and 160/202.
 *
 *   node settings.smoke.mjs
 */
import assert from 'node:assert/strict';
import { launchBrowser } from './comet.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const name = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, name === '/' ? 'index.html' : name));
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let pass = 0, fail = 0;
const ok = (condition, label, detail = '') => {
  if (condition) { pass += 1; console.log('ok   ', label, detail); }
  else { fail += 1; console.log('FAIL ', label, detail); }
};

// The household. Alex is the viewer (grown-up, no PIN, so the gate opens with
// one press); Sam is the profile being administered, and Sam has the PIN.
let profiles = [
  { id: 'p-alex', name: 'Alex', avatar: '🦊', maxRating: 'mature', allowAdult: false, isKids: false, hasPin: false },
  { id: 'p-sam', name: 'Sam', avatar: '🐯', maxRating: 'teen', allowAdult: false, isKids: false, hasPin: true },
];
const patches = [];
const deletes = [];
const verifies = [];
const secrets = [];

/**
 * THE ACCOUNT'S REAL ADD-ON VALUE — long, and a two-entry list.
 *
 * This used to be `null`. The GET stub below therefore answered
 * {present:false}, settings.js:551 took the `: ''` arm, and the read path never
 * carried a value at all — so the only string these rows were ever driven with
 * was the 43-character literal typed on the Save press further down. That is
 * the whole reason this harness sat green through the defect it was supposed to
 * cover: accountSecret() (profile.js:3922) used to hand the account's stored
 * value back through text() (profile.js:265), the 160-character DISPLAY-NAME
 * cap, and 43 characters cannot show a cut at 160.
 *
 * The shape is picked so no accident can save it:
 *   · 913 characters, so a 160-character slice lands 124 characters into the
 *     first entry's config segment and the SECOND ENTRY DISAPPEARS ENTIRELY;
 *   · two comma-separated entries, because settings.js:563 says in its own
 *     words that "A comma-separated list is legal here and is how the house
 *     adds more than one source at once", and firetv AddonConfig.kt:20-40
 *     documents the account locker holding exactly that list with no length
 *     cap of its own — so another client writes the full value that this
 *     browser reads;
 *   · NO comma inside either entry, so normalizeUrl (settings.js:562-576)
 *     splits it into two parts that each parse as https and the list survives
 *     validation on the way back out.
 *
 * MEASURED here before writing this: `new URL()` accepts the 160-character
 * TRUNCATION too — it comes out as a single valid
 * `https://mediafusion.elfhosted.com/D-eeee…` — so normalizeUrl passes the
 * shortened list straight through to the PUT at settings.js:586. Nothing
 * downstream catches the loss, which is why the assertions below have to be on
 * the string itself.
 *
 * The lengths are not invented. Real manifest URLs on this fleet measure 413
 * (mediafusion), 510 (comet), 941 (cometnet) and 1856 characters, and the
 * 1856-character one is itself a three-entry comma-separated list.
 */
const STORED_ADDONS = [
  `https://mediafusion.elfhosted.com/D-${'e'.repeat(360)}/manifest.json`,
  `https://comet.elfhosted.com/${'c'.repeat(460)}/manifest.json`,
].join(',');

/**
 * The OTHER half of the same defect: a 202-character Xtream get.php link.
 *
 * addLiveSource (profile.js:3948) ran `source.url` through the same
 * display-name cap, and a cut at 160 lands inside the token run below — so a
 * dead playlist was POSTed to /device/live/sources as a real source while
 * settings.js:691 reported "Playlist added — it will appear in Live TV
 * shortly." The token is a run of 't'; nothing in this file is a credential.
 */
const LIVE_PLAYLIST = `https://tv.example.test:8080/get.php?username=house&token=${'t'.repeat(120)}&type=m3u_plus&output=ts`;

let storedSecret = STORED_ADDONS;

let browser;
try {
  browser = await launchBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('blazing-web-profile-device-v1', JSON.stringify({ id: 'dev-set', token: 'fixture-token' }));
    localStorage.setItem('blazing-household-approved', '1');
  });
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const method = route.request().method();
    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname === '/profiles' && method === 'GET') return json(route, { profiles });
      if (url.pathname === '/accounts/me') return json(route, { account: { id: 'acc', name: 'Fixture' }, device: { id: 'dev-set', enrollmentStatus: 'approved' } });
      const verify = url.pathname.match(/^\/profiles\/([^/]+)\/verify$/);
      if (verify && method === 'POST') {
        verifies.push({ id: verify[1], body: JSON.parse(route.request().postData() || '{}') });
        return json(route, { ok: true, unlockToken: 'unlock-1', expiresAt: new Date(Date.now() + 600000).toISOString() });
      }
      const one = url.pathname.match(/^\/profiles\/([^/]+)$/);
      if (one && method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        patches.push({ id: one[1], body, unlockToken: url.searchParams.get('unlockToken') });
        const index = profiles.findIndex((p) => p.id === one[1]);
        const next = { ...profiles[index] };
        if (typeof body.name === 'string') next.name = body.name;
        if (typeof body.avatar === 'string') next.avatar = body.avatar;
        if (typeof body.isKids === 'boolean') next.isKids = body.isKids;
        if (typeof body.maxRating === 'string') next.maxRating = body.maxRating;
        if (typeof body.allowAdult === 'boolean') next.allowAdult = body.allowAdult;
        if ('pin' in body) next.hasPin = body.pin !== null;
        profiles[index] = next;
        return json(route, { profile: next });
      }
      if (one && method === 'DELETE') {
        deletes.push({ id: one[1], unlockToken: url.searchParams.get('unlockToken') });
        profiles = profiles.filter((p) => p.id !== one[1]);
        return json(route, { ok: true });
      }
      if (url.pathname === '/account/secret/stremio_addon_url') {
        secrets.push({ method, body: route.request().postData() || '' });
        if (method === 'GET') return json(route, storedSecret === null ? { present: false } : { present: true, value: storedSecret });
        if (method === 'PUT') { storedSecret = JSON.parse(route.request().postData() || '{}').value; return json(route, { ok: true }); }
        if (method === 'DELETE') { storedSecret = null; return json(route, { ok: true }); }
      }
      if (url.pathname === '/device/live/sources' && method === 'POST') {
        secrets.push({ method: 'LIVE', body: route.request().postData() || '' });
        return json(route, { ok: true });
      }
      if (url.pathname.startsWith('/profiles/')) return json(route, { items: [] });
      return json(route, {});
    }
    return json(route, {});
  });

  const page = await ctx.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(error.message));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden === true, null, { timeout: 8000 });

  /* ── B32: the route, the chip and the view ─────────────────────────────── */
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await page.waitForSelector('#settings-view:not([hidden]) #settings-min-height', { timeout: 8000 });
  ok(true, 'B32: the Settings chip opens a Settings view with real rows');

  const rowText = (id) => page.locator(`#${id}`).innerText();

  /* ── B35: the rows actually cycle, and the store follows the label ─────── */
  ok((await rowText('settings-min-height')).includes('Off'), 'Minimum quality starts Off', `(${await rowText('settings-min-height')})`);
  const ladder = [];
  for (let press = 0; press < 4; press += 1) {
    await page.locator('#settings-min-height').click();
    ladder.push((await rowText('settings-min-height')).replace('Minimum quality: ', ''));
  }
  ok(ladder.join(' → ') === '720p → 1080p → 4K → Off',
    'Minimum quality walks Fire TV\'s HEIGHT_LADDER and wraps back to Off', `(${ladder.join(' → ')})`);

  // Back up the ladder to 1080p, which is what the filter check below leans on.
  await page.locator('#settings-min-height').click();
  await page.locator('#settings-min-height').click();
  await page.locator('#settings-min-seeders').click();
  await page.locator('#settings-max-size').click();
  await page.locator('#settings-no-uncached').click();
  await page.locator('#settings-no-hevc').click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('blazing-source-filters-v1') || 'null'));
  ok(stored && stored.minHeight === 1080 && stored.minSeeders === 5 && stored.maxSizeGb === 2 && stored.noUncached === true && stored.noHevc === true,
    'every press is written to storage, so the label can never drift from the value', JSON.stringify(stored));
  ok((await rowText('settings-no-hevc')).includes('On'), 'and the row says so', `(${await rowText('settings-no-hevc')})`);

  // Auto-next defaults ON — Markus asked for it by name — and the row turns it off.
  ok((await rowText('settings-auto-next')).includes('On'), 'Play next episode automatically starts On',
    `(${await rowText('settings-auto-next')})`);
  await page.locator('#settings-auto-next').click();
  ok(await page.evaluate(() => localStorage.getItem('blazing-auto-next-episode-v1')) === '0',
    'and turning it off is stored the way the Roku registry stores it');
  await page.locator('#settings-auto-next').click();

  // The filters actually reach the source search.
  const applied = await page.evaluate(() => {
    const rows = [
      { name: '480p', title: '👤 50 · 1 GB', url: 'https://a/low.mkv' },
      { name: '1080p x265', title: '👤 50 · 1 GB', url: 'https://a/hevc.mkv' },
      { name: '1080p', title: '👤 50 · 1 GB', url: 'https://a/keep.mkv' },
    ];
    const out = window.BlazingSettings.filterStreams(rows);
    return { kept: out.streams.map((s) => s.url), dropped: out.dropped.total };
  });
  ok(applied.kept.length === 1 && applied.kept[0] === 'https://a/keep.mkv' && applied.dropped === 2,
    'B32: the stored filters really remove sources — they are not decoration', JSON.stringify(applied));

  /* ── Language: the two selects moved onto Settings and still save ──────── */
  const languageSelects = await page.locator('#settings-language select').count();
  ok(languageSelects === 2, 'Preferred audio and Preferred subtitles are on Settings now', `(${languageSelects})`);
  await page.locator('#settings-language select').first().selectOption('any');
  await page.waitForTimeout(150);
  const savedLanguage = await page.evaluate(() => JSON.parse(localStorage.getItem('blazing-stream-preferences-v1:p-alex') || 'null'));
  ok(savedLanguage && savedLanguage.audio === 'any', 'and changing one on Settings saves it for this profile', JSON.stringify(savedLanguage));

  /* ── B13: where content comes from, and who may change it ──────────────── */
  await page.waitForSelector('#settings-addon-url', { timeout: 8000 });
  await page.waitForFunction(
    () => (document.getElementById('settings-addon-note')?.textContent || '').includes('follows your account'),
    null, { timeout: 8000 },
  );
  ok(secrets.some((entry) => entry.method === 'GET'),
    'B13: a grown-up profile is shown the add-on field and it reads the account value');

  // Every Save below leaves the note reading "Saved on your account.", so the
  // note cannot tell the second press from the first and waiting on it is a
  // race — the same race the PATCH comment at the PIN pad further down
  // describes. Wait on the request list instead: the route handler pushes into
  // `secrets` before it fulfils, so a PUT is in this array strictly before the
  // browser's own promise can resolve.
  const untilPuts = async (count) => {
    for (let tick = 0; tick < 160; tick += 1) {
      if (secrets.filter((entry) => entry.method === 'PUT').length >= count) return;
      await page.waitForTimeout(50);
    }
  };

  /* ── Finding 1, READ half: the account value has to arrive WHOLE ───────── */
  // The barrier above this line is load-bearing. renderAddonForm sets the note
  // to "Loading the add-on for your account…" synchronously during render, and
  // only the GET's .then puts "follows your account" back (settings.js:551-557),
  // so the waitForFunction cannot fall through before the answer landed.
  //
  // This is the assertion that goes red the moment profile.js:3922 is put back
  // through text(): a 913-character list would read as 160 characters here,
  // with the whole second add-on gone, while every other row on this screen
  // stayed green.
  const loadedAddon = await page.locator('#settings-addon-url').inputValue();
  ok(loadedAddon === STORED_ADDONS,
    'B13: the account\'s two-entry add-on list reaches the field WHOLE, not capped at a display name\'s 160',
    `(${loadedAddon.length} of ${STORED_ADDONS.length} chars, ${loadedAddon.split(',').length} of 2 entries)`);

  /* ── Finding 1, WRITE-BACK half: and Save puts the same list back ──────── */
  // Press Save WITHOUT touching the field. That is the read-modify-write the
  // defect destroyed a household on: settings.js:551 loads the value into the
  // field, :578 reads that field back through normalizeUrl and :586 PUTs it to
  // /account/secret/stremio_addon_url — the record settings.js's own note calls
  // the one that "follows your account on every approved device". A shortened
  // value passes normalizeUrl, so only the string length proves it.
  await page.locator('#settings-addon-save').click();
  await untilPuts(1);
  const roundTrip = secrets.filter((entry) => entry.method === 'PUT')[0];
  const roundTripValue = roundTrip ? JSON.parse(roundTrip.body).value : '';
  ok(Boolean(roundTrip) && roundTripValue === STORED_ADDONS,
    'and pressing Save without editing PUTs that list back unchanged — the household keeps both add-ons',
    `(${roundTripValue.length} of ${STORED_ADDONS.length} chars)`);
  await page.waitForFunction(() => (document.getElementById('settings-addon-note')?.textContent || '').includes('Saved on your account'), null, { timeout: 8000 });

  await page.locator('#settings-addon-url').fill('https://addon.example.test/manifest.json');
  await page.locator('#settings-addon-save').click();
  await untilPuts(2);
  const put = secrets.filter((entry) => entry.method === 'PUT')[1];
  ok(Boolean(put) && JSON.parse(put.body).value === 'https://addon.example.test/manifest.json',
    'Save and sync PUTs the account secret every client reads', put ? put.body : 'no PUT');

  await page.locator('#settings-addon-url').fill('http://insecure.example.test/manifest.json');
  await page.locator('#settings-addon-save').click();
  await page.waitForTimeout(200);
  ok((await page.locator('#settings-addon-note').innerText()).includes('valid HTTPS'),
    'an http:// add-on is refused before it is sent', await page.locator('#settings-addon-note').innerText());
  ok(secrets.filter((entry) => entry.method === 'PUT').length === 2,
    'and nothing left the browser for it', `(${secrets.filter((entry) => entry.method === 'PUT').length} PUTs, both of them deliberate)`);

  // A Live TV playlist is the OTHER way to change where content comes from,
  // and it is behind the same gate.
  // The link is 202 characters on purpose — see LIVE_PLAYLIST at the top. The
  // 37-character literal this used to fill could not show the cut either.
  await page.locator('#settings-live-url').fill(LIVE_PLAYLIST);
  await page.locator('#settings-live-add').click();
  await page.waitForFunction(() => (document.getElementById('settings-live-note')?.textContent || '').includes('Playlist added'), null, { timeout: 8000 });
  const live = secrets.find((entry) => entry.method === 'LIVE');
  const liveBody = live ? JSON.parse(live.body) : {};
  ok(Boolean(live) && liveBody.kind === 'm3u', 'Add playlist POSTs the household playlist', live ? live.body : 'no POST');
  // Finding 1, Live TV half — the guard on profile.js:3948. A link cut at 160
  // lands inside the token, so the POST would carry a playlist that can never
  // resolve while the note said "Playlist added — it will appear in Live TV
  // shortly." (settings.js:691). Nothing else on this screen would go red.
  ok(liveBody.url === LIVE_PLAYLIST,
    'and the playlist URL survives the POST WHOLE — a token cut in half is a source that silently never loads',
    `(${String(liveBody.url || '').length} of ${LIVE_PLAYLIST.length} chars)`);

  /* ── B28 / B3 / B1: the parental sheet ─────────────────────────────────── */
  // Reached from Settings, which is the route the row promises. It opens the
  // gate on the ACTIVE profile's own controls rather than on the rail.
  await page.locator('#settings-parental').click();
  await page.waitForSelector('#bp-parental:not([hidden])', { timeout: 8000 });
  ok((await page.locator('#bp-heading').innerText()).trim() === 'Alex',
    'Settings → Parental controls opens the gate on the profile that is watching',
    await page.locator('#bp-heading').innerText());
  await page.locator('#bp-parental-back').click();
  await page.getByRole('button', { name: 'Edit Sam', exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Edit Sam', exact: true }).click();
  await page.waitForSelector('#bp-parental:not([hidden]) #bp-parental-kids', { timeout: 8000 });
  ok(true, 'B28: the pencil opens parental controls, not just a picture grid');

  // A RAISE needs the PIN. Sam is capped at teen; 'mature' is up the ladder.
  await page.locator('#bp-parental-ratings button', { hasText: 'mature' }).click();
  await page.waitForSelector('.bp-pin:not([hidden])', { timeout: 8000 });
  ok((await page.locator('.bp-pin strong').innerText()).includes('Sam'),
    'B28: raising the rating limit asks for that profile\'s PIN first');
  for (const digit of ['1', '2', '3', '4']) await page.locator(`.bp-digit[data-digit="${digit}"]`).click();
  await page.locator('.bp-pin .bp-verify').click();
  // WAIT FOR THE LABEL, not for the sheet. The sheet comes back the instant the
  // PIN is accepted; the PATCH goes out after that, and its echo is what
  // redraws the row. Checking the request list on the sheet alone is a race —
  // it read as "no PATCH was sent" on about one run in three.
  await page.waitForFunction(
    () => document.querySelector('#bp-parental-ratings button[aria-pressed="true"]')?.textContent === 'mature',
    null, { timeout: 8000 },
  );
  const raise = patches.find((entry) => entry.body.maxRating === 'mature');
  ok(Boolean(raise) && raise.unlockToken === 'unlock-1' && raise.id === 'p-sam',
    'and the PATCH carries the unlock token the verify handed back', JSON.stringify(raise));
  ok(verifies.length === 1 && verifies[0].id === 'p-sam', 'exactly one /verify was posted, for that profile');

  // B1: adult content, off by default, on only behind a fresh PIN check.
  await page.locator('#bp-parental-adult').click();
  await page.waitForSelector('.bp-pin:not([hidden])', { timeout: 8000 });
  for (const digit of ['1', '2', '3', '4']) await page.locator(`.bp-digit[data-digit="${digit}"]`).click();
  await page.locator('.bp-pin .bp-verify').click();
  await page.waitForFunction(
    () => (document.getElementById('bp-parental-adult')?.textContent || '').includes('ON'),
    null, { timeout: 8000 },
  );
  const adult = patches.find((entry) => entry.body.allowAdult === true);
  ok(Boolean(adult) && adult.unlockToken === 'unlock-1',
    'B1: "Allow adult content" can finally be turned on from a browser, behind the PIN', JSON.stringify(adult));

  // B3: Change PIN — verify the old one, then collect four new digits. The
  // second pad must NOT post another /verify: those digits are the new PIN.
  const verifiesBefore = verifies.length;
  await page.locator('#bp-parental-pin').click();
  await page.waitForSelector('.bp-pin:not([hidden])', { timeout: 8000 });
  for (const digit of ['1', '2', '3', '4']) await page.locator(`.bp-digit[data-digit="${digit}"]`).click();
  // SAME RACE AS THE PATCH ABOVE, and the same fix. `waitForSelector` on
  // `.bp-pin strong` is not a barrier here: that element is ALREADY on screen
  // saying "Sam" when Verify is pressed, so the wait returns at once and the
  // read below can land before the POST /verify round trip has swapped the pad
  // to its newpin stage (profile.js:1537 sets the heading, :1547 the button
  // label). MEASURED 12 Sep 2026: identical code in this block passed on one
  // run and read "Sam" on the next.
  //
  // So wait for the heading to CHANGE, and then assert what it changed TO. The
  // wait names no expected text, so it cannot pass the assertion for free — a
  // pad that advanced to the wrong stage still goes red here.
  const firstPadHeading = await page.locator('.bp-pin strong').innerText();
  await page.locator('.bp-pin .bp-verify').click();
  await page.waitForFunction(
    (before) => {
      const node = document.querySelector('.bp-pin:not([hidden]) strong');
      return Boolean(node) && node.textContent.trim() !== before;
    },
    firstPadHeading.trim(), { timeout: 8000 },
  );
  ok((await page.locator('.bp-pin strong').innerText()).includes('New PIN'),
    'B3: the second pad asks for the NEW PIN and says so', await page.locator('.bp-pin strong').innerText());
  ok((await page.locator('.bp-pin .bp-verify').innerText()).trim() === 'Save', 'and its button says Save, not Verify');
  for (const digit of ['9', '8', '7', '6'] ) await page.locator(`.bp-digit[data-digit="${digit}"]`).click();
  await page.locator('.bp-pin .bp-verify').click();
  await page.waitForFunction(
    () => (document.getElementById('bp-parental-note')?.textContent || '') === 'Saved.',
    null, { timeout: 8000 },
  );
  const setPin = patches.find((entry) => entry.body.pin === '9876');
  ok(Boolean(setPin) && setPin.unlockToken === 'unlock-1', 'B3: the new PIN is PATCHed with the unlock token', JSON.stringify(setPin));
  ok(verifies.length === verifiesBefore + 1, 'and the new digits were never posted to /verify', `(${verifies.length - verifiesBefore})`);

  // B3: Remove PIN — the wire contract is pin:null, not a "clearPin" field.
  await page.locator('#bp-parental-pin-remove').click();
  await page.waitForSelector('.bp-pin:not([hidden])', { timeout: 8000 });
  for (const digit of ['9', '8', '7', '6']) await page.locator(`.bp-digit[data-digit="${digit}"]`).click();
  await page.locator('.bp-pin .bp-verify').click();
  await page.waitForFunction(
    () => (document.getElementById('bp-parental-pin')?.textContent || '').trim() === 'Set PIN',
    null, { timeout: 8000 },
  );
  const cleared = patches.find((entry) => 'pin' in entry.body && entry.body.pin === null);
  ok(Boolean(cleared), 'B3: Remove PIN sends {"pin":null}, the shape every TV sends', JSON.stringify(cleared));
  ok(await page.locator('#bp-parental-pin-remove').isDisabled(),
    'and Remove PIN goes dead, because the row re-read itself from the server echo');

  /* ── B15: Delete, twice, and never on the last profile ─────────────────── */
  ok(await page.locator('#bp-parental-delete').count() === 1, 'B15: Delete profile is offered on a two-profile household');
  await page.locator('#bp-parental-delete').click();
  await page.waitForFunction(() => (document.getElementById('bp-parental-delete')?.textContent || '').includes('Press again'), null, { timeout: 8000 });
  ok(deletes.length === 0, 'B15: one press deletes nothing — it arms the second');
  await page.locator('#bp-parental-delete').click();
  // The rail is re-listed from the server after a delete, so the profile going
  // is the thing to wait for — not a slot count, which also counts "Add profile".
  await page.getByRole('button', { name: 'Choose Sam', exact: true }).waitFor({ state: 'detached', timeout: 8000 });
  ok(deletes.length === 1 && deletes[0].id === 'p-sam', 'B15: the second press DELETEs that profile', JSON.stringify(deletes));

  await page.getByRole('button', { name: 'Edit Alex', exact: true }).click();
  await page.waitForSelector('#bp-parental:not([hidden]) #bp-parental-kids', { timeout: 8000 });
  ok(await page.locator('#bp-parental-delete').count() === 0,
    'B15: and it is not drawn at all on the last profile in the house');

  // The Kids interlock, on the wire: one request, cap and adult together.
  await page.locator('#bp-parental-kids').click();
  await page.waitForFunction(() => (document.getElementById('bp-parental-kids')?.textContent || '').includes('ON'), null, { timeout: 8000 });
  const kids = patches.find((entry) => entry.body.isKids === true);
  ok(Boolean(kids) && kids.body.maxRating === 'general' && kids.body.allowAdult === false,
    'B28: the Kids interlock pins the cap and clears adult IN THE SAME request', JSON.stringify(kids && kids.body));

  /* ── B13 again, from the other side: a Kids profile may not touch sources ─ */
  await page.locator('#bp-parental-done').click();
  await page.getByRole('button', { name: 'Choose Alex', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.bp-layer')?.hidden === true, null, { timeout: 8000 });
  await page.evaluate(() => document.querySelector('[data-view="settings"]').click());
  await page.waitForSelector('#settings-view:not([hidden]) #settings-sources-gate', { timeout: 8000 });
  ok(await page.locator('#settings-addon-url').count() === 0,
    'B13: a Kids profile is not offered the add-on field at all');
  const refused = await page.evaluate(() => window.BlazingProfile.accountSecret('stremio_addon_url', { method: 'GET' }));
  ok(refused.ok === false && /rating limit/.test(refused.error || ''),
    'B13: and the call behind it refuses too, so the screen cannot be walked round', JSON.stringify(refused));

  ok(faults.length === 0, 'no page threw on the way through', faults.join(' | '));
} finally {
  await browser?.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
