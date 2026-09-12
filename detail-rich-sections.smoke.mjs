// THE DETAIL SHEET IS THE WHOLE DETAIL SHEET, ON THE WEB TOO.
//
// AUDIT B26. On a browser — and on every webOS and Tizen television running
// this same client — the title page was a poster, a synopsis, one "Directed by"
// line and a stream list. Who is in it, what studio made it, what people said
// and what else to watch were all absent, while the Roku has had four sections
// since DetailsScreen.xml:332-390 and Fire TV since DetailActivity.kt:846-902.
//
// Markus's standing rule: "roku, web, and firstick should all feel like im
// using the same app no matter what."
//
// ------------------------------------------------------ WHAT IS ACTUALLY PINNED
// Six things, and each one reddens on a different real mistake:
//
//   1. ONE /meta/rich CALL FILLS ALL FOUR SECTIONS. richmeta.js exists because
//      a detail page must not cost five round trips; a second fetch per section
//      would pass every visual check and quietly undo that. The request count
//      is asserted, not the pixels.
//
//   2. THE CAST IS CAPPED AT 12 AND EVERY FACE IS A BUTTON. 12 is the Roku's
//      CapTo12. A <div> would look identical and be unreachable — dpad.js walks
//      real focusable elements. Asserted by ROLE, not by class.
//
//   3. role=cast REACHES THE FLEET. richmeta.js treats 'cast' as a NARROWING
//      filter (shapePersonCredits): without it an actor's page also lists
//      everything they ever produced or wrote.
//
//   4. A COMPANY OPENS ITS CATALOGUE. The audit's specific complaint is a
//      control that is drawn and does nothing, so the company card is followed
//      all the way to /meta/company/<id>/catalog and the dialog it fills.
//
//   5. REVIEWS ARE CAPPED AT 2 AND CARRY THEIR SOURCE. Two is Roku's
//      buildReviews. The source is not decoration: these are TMDB users'
//      opinions and an unattributed verdict reads as the app's own.
//
//   6. MORE LIKE THIS IS `recommended` ONLY. The fixture poisons `similar` with
//      the exact failure Markus saw on the Roku — Star Wars offering Momo — and
//      the assertion is that those titles are NOT on the row. Fire TV merges
//      the two lists; that is the defect, not the reference.
//
// Everything is mocked at the network boundary. This is about THIS CLIENT.
//
//   node detail-rich-sections.smoke.mjs
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
const LEAD = 'Ada Kestrel';
const STUDIO = { id: 3172, name: 'Blumhouse Productions', logo: 'https://img.example.test/bh.png', originCountry: 'US' };
// The recommended title the row opens, and the IMDb id /meta/resolve turns its
// tmdb: id into. Both are needed: the assertion is that the SHEET holds the
// resolved one, because nothing downstream can open a tmdb: id.
const REC_TMDB = 'tmdb:120467';
const REC_IMDB = 'tt2278388';
const REC_NAME = 'The Second Runner';

const title = {
  id: ID, type: 'movie', name: 'The Runner', releaseInfo: '2026',
  contentRating: 'mature',
  description: 'A courier with one night to cross a city that wants him gone.',
  poster: 'https://img.example.test/runner-poster.jpg',
};

// FOURTEEN, so a cap of 12 is a visible difference rather than a coincidence.
const cast = Array.from({ length: 14 }, (unused, i) => ({
  name: i === 0 ? LEAD : `Player ${i}`,
  character: i === 0 ? 'The Runner' : `Role ${i}`,
  photo: `https://img.example.test/face-${i}.jpg`,
}));

// THREE reviews, so a cap of 2 is visible. The middle one has no score at all —
// TMDB allows a review without one and "0/10" would be a lie about the opinion.
const reviews = [
  { author: 'ScreenGoblin', score: '8/10', source: 'TMDB', text: 'Relentless, and it never once stops to explain itself.' },
  { author: 'Anonymous', score: null, source: 'TMDB', text: 'Watched it twice in a row.' },
  { author: 'ThirdWheel', score: '3/10', source: 'TMDB', text: 'This one must not be drawn — the cap is two.' },
];

const recommended = [
  { id: REC_TMDB, type: 'movie', name: REC_NAME, poster: 'https://img.example.test/rec1.jpg', year: '2024' },
  { id: 'tmdb:1396', type: 'series', name: 'The Night Shift', poster: 'https://img.example.test/rec2.jpg', year: '2022' },
];

// The Momo problem, in fixture form. TMDB's `similar` is a genre sweep walked in
// catalogue order; if either of these reaches the row, the client is merging the
// two lists the way Fire TV does and the audit's claim 11 is live again.
const similar = [
  { id: 'tmdb:8392', type: 'movie', name: 'Momo', poster: 'https://img.example.test/momo.jpg', year: '1986' },
  { id: 'tmdb:2277', type: 'movie', name: 'Bicentennial Man', poster: 'https://img.example.test/bm.jpg', year: '1999' },
];

const rich = {
  ratings: [], genres: [], runtime: 0,
  crew: { directors: ['Wes Anderson'], studios: [STUDIO.name] },
  cast,
  companies: [STUDIO],
  reviews,
  similar,
  recommended,
};

const companyCatalog = {
  company: STUDIO,
  movies: [
    { id: 'tmdb:4011', type: 'movie', name: 'Company Film One', poster: 'https://img.example.test/c1.jpg', year: '2019' },
    { id: 'tmdb:4012', type: 'movie', name: 'Company Film Two', poster: 'https://img.example.test/c2.jpg', year: '2021' },
  ],
  series: [
    { id: 'tmdb:4013', type: 'series', name: 'Company Show One', poster: 'https://img.example.test/c3.jpg', year: '2020' },
  ],
};

const person = {
  person: { id: 77, name: LEAD, photo: 'https://img.example.test/ada.jpg' },
  items: [{
    id: 'tmdb:5500', mediaType: 'movie', name: 'Her Other Film',
    poster: 'https://img.example.test/other.jpg', year: '2021', character: 'Herself', job: '',
  }],
};

const manifest = { catalogs: [{ id: 'fixture', type: 'movie', name: 'Test titles' }] };
const reply = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function wire(ctx, seen) {
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();

    if (url.hostname === 'fleet.lyreosai.com') {
      if (url.pathname.startsWith('/meta/rich/')) {
        seen.rich.push(url.pathname);
        return reply(route, rich);
      }
      if (url.pathname === '/meta/person') {
        seen.person.push({
          name: url.searchParams.get('name') || '',
          role: url.searchParams.get('role') || '',
        });
        return reply(route, person);
      }
      if (/^\/meta\/company\/[^/]+\/catalog$/.test(url.pathname)) {
        seen.company.push(url.pathname);
        return reply(route, companyCatalog);
      }
      if (url.pathname.startsWith('/meta/resolve/')) {
        seen.resolved.push(url.pathname);
        return reply(route, { id: REC_IMDB });
      }
      return reply(route, { metas: [], items: [] });
    }

    if (url.hostname === 'addon.lyreosai.com') {
      if (url.pathname === '/manifest.json') return reply(route, manifest);
      if (url.pathname === '/catalog/movie/fixture.json') return reply(route, { metas: [title] });
      if (url.pathname.startsWith('/catalog/')) return reply(route, { metas: [] });
      if (url.pathname === `/meta/movie/${REC_IMDB}.json`) {
        return reply(route, {
          meta: {
            id: REC_IMDB, type: 'movie', name: REC_NAME,
            releaseInfo: '2024', contentRating: 'mature',
            poster: 'https://img.example.test/rec1.jpg',
            description: 'The one the row opened.',
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
const text = (page, selector) => page.locator(selector).textContent();

let browser;
try {
  browser = await launchBrowser();
  const seen = { rich: [], person: [], company: [], resolved: [] };
  const faults = [];

  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await wire(ctx, seen);
  await prepareProfile(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => faults.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/index.html`);
  await selectProfile(page);

  await card(page, 'The Runner').waitFor({ timeout: 30000 });
  await card(page, 'The Runner').click();

  /* ===================================================================== 1
     ALL FOUR SECTIONS, OUT OF ONE /meta/rich CALL.
  */
  await page.locator('#detail-related:not([hidden])').waitFor({ timeout: 30000 });
  for (const id of ['#detail-cast', '#detail-companies', '#detail-reviews', '#detail-related']) {
    assert.equal(
      await page.locator(id).evaluate((n) => n.hasAttribute('hidden')), false,
      `${id} must be on the sheet — this is the whole of B26`,
    );
  }
  assert.equal(
    seen.rich.length, 1,
    `one rich call fills the whole sheet — saw ${seen.rich.length}`,
  );
  assert.deepEqual(
    await page.evaluate(() => ['#detail-cast', '#detail-companies', '#detail-reviews', '#detail-related']
      .map((id) => document.querySelector(`${id} .detail-section-label`)?.textContent)),
    ['Cast', 'Production companies', 'Reviews', 'More like this'],
    'the Roku\'s labels, in the Roku\'s order',
  );

  /* ===================================================================== 2
     TWELVE CAST MEMBERS, EACH A REAL BUTTON.
  */
  const faces = page.locator('#detail-cast .detail-person');
  assert.equal(await faces.count(), 12, 'the cast is capped at 12 — the Roku\'s CapTo12');
  assert.equal(
    await faces.first().evaluate((n) => n.tagName), 'BUTTON',
    'a cast member must be a real button — dpad.js cannot reach a styled label',
  );
  assert.equal(
    await page.locator('#detail-cast .detail-person-name').first().textContent(), LEAD,
    'the first tile carries the lead\'s name',
  );
  assert.equal(
    await page.locator('#detail-cast .detail-person-role').first().textContent(), 'The Runner',
    'and the character they play, the Roku CastTile\'s subtitle',
  );

  /* ===================================================================== 3
     PRESSING ONE ASKS FOR role=cast.
  */
  await faces.first().click();
  await page.locator('#person-dialog[open]').waitFor({ timeout: 30000 });
  await page.locator('#person-results .card').first().waitFor({ timeout: 30000 });
  assert.equal(seen.person.length, 1, 'exactly one person lookup');
  assert.equal(seen.person[0].name, LEAD, 'asked for the right person');
  assert.equal(
    seen.person[0].role, 'cast',
    'role=cast is required — richmeta.js treats it as a narrowing filter, and without it an actor\'s page lists their crew jobs too',
  );
  assert.equal(await text(page, '#person-role'), 'Films and series they appear in');
  await page.locator('#person-close').click();
  await page.waitForFunction(
    () => !document.querySelector('#person-dialog')?.hasAttribute('open'),
    undefined, { timeout: 30000 },
  );

  /* ===================================================================== 4
     A COMPANY IS A DOOR, NOT A LABEL.
  */
  const studio = page.locator('#detail-companies .detail-company').first();
  assert.equal(await studio.evaluate((n) => n.tagName), 'BUTTON', 'a company must be pressable');
  assert.equal(await page.locator('#detail-companies .detail-company-name').first().textContent(), STUDIO.name);
  await studio.click();
  await page.locator('#company-dialog[open]').waitFor({ timeout: 30000 });
  await page.locator('#company-results .card').first().waitFor({ timeout: 30000 });
  assert.deepEqual(
    seen.company, [`/meta/company/${STUDIO.id}/catalog`],
    'the fleet route the Roku and Fire TV already use, asked once',
  );
  assert.equal(await text(page, '#company-title'), STUDIO.name);
  assert.equal(
    await text(page, '#company-sub'), '2 movies   ·   1 series',
    'the counts summary is the Roku\'s CompanySummary, verbatim',
  );
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('#company-results .detail-section-label')].map((n) => n.textContent)),
    ['Movies', 'Series'],
    'both mediums, in the Roku\'s order',
  );
  await page.locator('#company-close').click();
  await page.waitForFunction(
    () => !document.querySelector('#company-dialog')?.hasAttribute('open'),
    undefined, { timeout: 30000 },
  );

  /* ===================================================================== 5
     TWO REVIEWS, EACH CARRYING THE SOURCE IT CAME FROM.
  */
  const reviewCards = page.locator('#detail-reviews .detail-review');
  assert.equal(await reviewCards.count(), 2, 'two reviews — Roku buildReviews\' `if shown > 2`');
  assert.equal(await page.locator('#detail-reviews .detail-review-author').first().textContent(), 'ScreenGoblin');
  assert.equal(
    await page.locator('#detail-reviews .detail-review-score').first().textContent(), '8/10  ·  TMDB',
    'score and source together — the score alone has no scale, the source alone has no line',
  );
  assert.equal(
    await page.locator('#detail-reviews .detail-review-score').nth(1).textContent(), 'TMDB',
    'a review TMDB holds no rating for prints the source alone — never "0/10", which would be a lie about the opinion',
  );
  assert.equal(
    await page.locator('#detail-reviews .detail-review-author').nth(1).textContent(), 'Anonymous',
    'and still names its author',
  );

  /* ===================================================================== 6
     MORE LIKE THIS IS `recommended`, AND ONLY `recommended`.
  */
  const related = await page.evaluate(() =>
    [...document.querySelectorAll('#detail-related .card-label')].map((n) => n.textContent.trim()));
  assert.deepEqual(
    related, [REC_NAME, 'The Night Shift'],
    'the recommended list, and the series with it — safeDiscoverMeta must not file everything as a movie',
  );
  for (const poison of similar) {
    assert.equal(
      related.includes(poison.name), false,
      `${poison.name} came from TMDB's \`similar\`, which is a genre sweep in catalogue order — merging it in is Fire TV's defect, not the reference`,
    );
  }

  /* ===================================================================== 7
     A RELATED CARD RESOLVES ONCE, ON THE CLICK, AND OPENS THE RESOLVED TITLE.
  */
  await page.locator('#detail-related .card').first().click();
  await page.waitForFunction(
    (name) => document.querySelector('#detail-title')?.textContent === name,
    REC_NAME, { timeout: 30000 },
  );
  assert.deepEqual(
    seen.resolved, ['/meta/resolve/movie/120467'],
    'exactly one resolve, for the card that was picked — a tmdb: id reaching the sheet would 404 the stream route for ever',
  );
  // The sheet clears its four sections the moment a new title opens, so waiting
  // for the cast to come BACK is waiting for the second payload to land. Without
  // that wait this reads the count mid-flight, because the title is written
  // synchronously and the rich fetch is not.
  await page.locator('#detail-cast:not([hidden])').waitFor({ timeout: 30000 });
  assert.equal(
    seen.rich.length, 2,
    'the new title fetches its own rich payload, once — the sections are not left holding the previous title\'s cast',
  );

  assert.deepEqual(faults, [], 'no page errors');
  console.log('detail rich sections: 7 sections passed');
  await ctx.close();
} finally {
  await browser?.close();
  server.close();
}
