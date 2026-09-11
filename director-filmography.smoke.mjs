// THE DIRECTOR'S NAME IS SOMEWHERE YOU CAN GO, ON THE WEB TOO.
//
// Markus's standing rule: "roku, web, and firstick should all feel like im
// using the same app now matter what." Fire TV has PersonActivity and the Roku
// has PersonScreen; this page had NO crew at all — no director, no filmography,
// nothing. DebridStream 3.7 item 12 is "director filmography in details", and
// this is the web half of it.
//
// ------------------------------------------------------ WHAT IS ACTUALLY PINNED
// Three things, and each one reddens on a different real mistake:
//
//   1. THE NAME IS A BUTTON. A <span> would look identical and be unreachable —
//      dpad.js walks real focusable elements, so a styled label is invisible to
//      a remote. Asserted by ROLE, not by class.
//
//   2. role=director REACHES THE FLEET. TMDB splits a person's combined_credits
//      into `cast` and `crew`, and a director's OWN films are only in `crew`.
//      Asking without the role returns their walk-on parts — measured live on
//      "Alex Timbers", who came back with two self-appearances and none of the
//      shows he directed. The request is recorded and the role is asserted.
//
//   3. A tmdb: ID IS RESOLVED ON THE CLICK, ONCE. The person payload carries
//      tmdb: ids on purpose (blazing-fleet/richmeta.js measured the trade: one
//      call for the card the viewer picks, instead of up to 40 per page). So the
//      card must NOT open the detail sheet with a tmdb: id — nothing downstream
//      can turn that into a stream. What the sheet ends up holding is asserted,
//      and so is the number of resolve calls: 1, not 3.
//
// Everything is mocked at the network boundary. This is about THIS CLIENT.
//
//   node director-filmography.smoke.mjs
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

const ID = 'tt9000001';
const DIRECTOR = 'Wes Anderson';
// The film the filmography card opens, and the IMDb id /meta/resolve turns its
// tmdb: id into. Both are needed: the assertion is that the SHEET holds the
// resolved one.
const CREDIT_TMDB = 'tmdb:120467';
const CREDIT_IMDB = 'tt2278388';

const title = {
  id: ID, type: 'movie', name: 'The Runner', releaseInfo: '2026',
  contentRating: 'general',
  description: 'A courier with one night to cross a city that wants him gone.',
  poster: 'https://img.example.test/runner-poster.jpg',
};

const rich = {
  ratings: [], cast: [], companies: [], reviews: [], genres: [],
  similar: [], recommended: [], runtime: 0,
  crew: { directors: [DIRECTOR], studios: [] },
};

// Two credits, one of each kind, so the "everything is a movie" bug — reading
// `type` where the payload writes `mediaType` — would be visible if it existed.
const person = {
  person: { id: 5655, name: DIRECTOR, photo: 'https://img.example.test/wes.jpg' },
  items: [
    {
      id: CREDIT_TMDB, mediaType: 'movie', name: 'The Grand Budapest Hotel',
      poster: 'https://img.example.test/gbh.jpg', year: '2014', character: '', job: 'Director',
    },
    {
      id: 'tmdb:1396', mediaType: 'series', name: 'A Series He Directed',
      poster: 'https://img.example.test/series.jpg', year: '2008', character: '', job: 'Director',
    },
  ],
};

const manifest = { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] };
const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function wire(ctx, seen) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();

    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname.startsWith('/meta/rich/')) return reply(route, rich);
      if (url.pathname === '/meta/person') {
        seen.person.push({
          name: url.searchParams.get('name') || '',
          role: url.searchParams.get('role') || '',
        });
        return reply(route, person);
      }
      if (url.pathname.startsWith('/meta/resolve/')) {
        seen.resolved.push(url.pathname);
        return reply(route, { id: CREDIT_IMDB });
      }
      return reply(route, { metas: [], items: [] });
    }

    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: [title] });
      if (url.pathname.startsWith('/catalog/')) return reply(route, { metas: [] });
      if (url.pathname === `/meta/movie/${CREDIT_IMDB}.json`) {
        return reply(route, {
          meta: {
            id: CREDIT_IMDB, type: 'movie', name: 'The Grand Budapest Hotel',
            releaseInfo: '2014', contentRating: 'general',
            poster: 'https://img.example.test/gbh.jpg',
            description: 'A concierge and a lobby boy.',
          },
        });
      }
      if (url.pathname.startsWith('/meta/')) return reply(route, { meta: title });
      if (url.pathname.startsWith('/stream/')) return reply(route, { streams: [] });
      return reply(route, { metas: [], streams: [] });
    }
    return reply(route, { metas: [], items: [], results: [] });
  });
}

const card = (page, name) => page.getByRole('button', { name: `View ${name}`, exact: true });

let browser;
try {
  browser = await launchBrowser();
  const seen = { person: [], resolved: [] };
  const faults = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx, seen);
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => faults.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  /* ===================================================================== 1
     THE DIRECTOR IS A BUTTON ON THE DETAIL SHEET.
  */
  await card(page, 'The Runner').waitFor({ timeout: 30000 });
  await card(page, 'The Runner').click();

  const crewName = page.getByRole('button', { name: `Everything ${DIRECTOR} directed` });
  await crewName.waitFor({ timeout: 30000 });
  assert.equal(await crewName.textContent(), DIRECTOR, 'the chip carries the name itself');
  // By ROLE. A <span> styled to look the same would fail this line and pass a
  // text query, which is the whole point of asserting the role.
  assert.equal(
    await crewName.evaluate((n) => n.tagName),
    'BUTTON',
    'the director name must be a real button — dpad.js cannot reach a styled label',
  );

  /* ===================================================================== 2
     PRESSING IT ASKS THE FLEET FOR THE DIRECTOR ROLE, NOT A BARE NAME.
  */
  await crewName.click();
  await page.locator('#person-dialog[open]').waitFor({ timeout: 30000 });
  await page.locator('#person-results .card').first().waitFor({ timeout: 30000 });

  assert.equal(seen.person.length, 1, 'exactly one person lookup');
  assert.equal(seen.person[0].name, DIRECTOR, 'asked for the right person');
  assert.equal(
    seen.person[0].role, 'director',
    'role=director is required — without it TMDB returns their acting credits and none of their films',
  );

  const shown = await page.evaluate(() =>
    [...document.querySelectorAll('#person-results .card-label')].map((n) => n.textContent.trim()));
  assert.deepEqual(
    shown, ['The Grand Budapest Hotel', 'A Series He Directed'],
    'both credits are drawn, the series included — the payload keys its kind as mediaType, not type',
  );
  assert.equal(
    await page.locator('#person-title').textContent(), DIRECTOR,
    'the filmography is headed with the person it belongs to',
  );

  /* ===================================================================== 3
     A tmdb: CARD RESOLVES ONCE, ON THE CLICK, AND OPENS THE RESOLVED TITLE.
  */
  await page.locator('#person-results .card').first().click();
  await page.locator('#detail-dialog[open]').waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('#detail-title')?.textContent === 'The Grand Budapest Hotel',
    undefined, { timeout: 30000 },
  );

  assert.equal(
    seen.resolved.length, 1,
    `exactly one resolve, for the card that was picked — saw ${seen.resolved.length}`,
  );
  assert.equal(seen.resolved[0], '/meta/resolve/movie/120467', 'resolved the numeric TMDB id');
  // The sheet is holding the RESOLVED title, which only /meta/movie/tt2278388
  // could have supplied — the fixture answers the tmdb: path with nothing. A
  // tmdb: id reaching the sheet is the failure this wrapper exists to stop:
  // the streams route would 404 for ever.
  assert.equal(
    await page.locator('#person-dialog').evaluate((n) => n.hasAttribute('open')),
    false,
    'the filmography closes behind the title it opened',
  );

  assert.deepEqual(faults, [], 'no page errors');
  console.log('director filmography: 3 sections passed');
  await ctx.close();
} finally {
  await browser?.close();
  server.close();
}
