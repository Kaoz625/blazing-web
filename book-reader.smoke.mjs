import { prepareProfile, selectProfile } from './scripts/profile-fixture.mjs';
/**
 * THE BOOK READER, AND CONTINUOUS TOP-TO-BOTTOM READING.
 *
 * Two features, one suite, because they share tv-reading-mode.js.
 *
 * What is proved here, all of it against intercepted routes so nothing real is
 * contacted:
 *
 * THE FIXTURES BELOW ARE MEASURED, NOT IMAGINED. Read this before changing one.
 *
 * On 7 Sep 2026 this suite passed 58/58 while NOT ONE BOOK on the live server
 * could be opened in the browser. It described a contract the server does not
 * implement, the client was written to match the fixture, and the two agreed
 * with each other all the way to green. Two shapes were wrong:
 *
 *   - A READABLE ROW'S URL. The fixture said every openable row is
 *     `/usenet/<48 hex>`. The live `/search/book?q=dune` returned six rows and
 *     every single one was `/book/ref/<48 hex>` — an Anna's Archive reference,
 *     which the server learned to mint and this client had never heard of. All
 *     six were refused with "points somewhere other than our own server".
 *   - A PAGE. The fixture said `pages: ['some words']`. The server sends
 *     `pages: [{ n: 1, text: 'some words' }]`, so the client's
 *     `typeof pages[0] !== 'string'` guard refused every real book with "This
 *     book could not be read."
 *
 * Both shapes below were taken from `curl` against addon.lyreosai.com on that
 * date. A fixture is a CLAIM ABOUT THE SERVER; when it stops being measured it
 * stops being a test and becomes a second copy of the bug.
 *
 *  1. The books row calls /search/book and draws every result.
 *  2. ONLY a row carrying one of OUR OWN references gets a Read button — an
 *     Anna's `/book/ref/` reference and a Usenet `/usenet/` reference both
 *     count, and both are exercised. An Anna's download page, a Usenet row with
 *     no reference, and a `direct:true` row pointing off our origin each get a
 *     SENTENCE saying why instead — the "dead button" failure this feature
 *     exists to stop. Proved by counting buttons, not by reading one row.
 *  3. Read opens the reader, asks /book/pages/<token>?page=1&chars=…, and puts
 *     real text and a "Page 1 of N" indicator on screen.
 *  4. Arrow keys turn pages, and the request that goes out is for the page the
 *     indicator claims.
 *  5. The font control changes BOTH the rendered type size and `chars=` on the
 *     wire, and it keeps the reader's place rather than throwing them back to
 *     page one.
 *  6. Every refusal the route can answer is said out loud: a PDF (415), a book
 *     Usenet is still fetching (202), and a reference the route rejects (400).
 *     None of them leaves an empty reader.
 *  7. A fixed-layout book (mode:'image') draws through the comics page rail,
 *     and its page URLs stay on our own origin.
 *  8. CONTINUOUS SCROLL: the strip stacks every page, a D-pad press GLIDES
 *     rather than jumping a whole page, paged mode still works, and the choice
 *     is remembered.
 *  9. The manga reader has the same switch, which is where the viewer asked
 *     for it.
 * 10. AND MANGA OPENS ON THE STRIP WITHOUT BEING ASKED, while books and comics
 *     still open paged — one shared localStorage key, a different fallback per
 *     surface. A stored choice beats the fallback in both directions, and
 *     opening on the strip writes nothing, so "has the reader chosen?" stays
 *     answerable.
 */
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (value, label, extra = '') => {
  value ? pass++ : fail++;
  console.log(`${value ? 'ok  ' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};
const is = (got, want, label) => ok(String(got) === String(want), label,
  String(got) === String(want) ? '' : `(got ${JSON.stringify(String(got))}, want ${JSON.stringify(String(want))})`);

const hex = (seed) => seed.repeat(48).slice(0, 48);
const EPUB = hex('a1');
/** An Anna's Archive reference — `/book/ref/<48 hex>`. This is the shape EVERY
 *  live result carried on 7 Sep 2026, so it is the one a reader really meets. */
const ANNAS = hex('f6');
const PDF = hex('b2');
const SLOW = hex('c3');
const GONE = hex('d4');
const FIXED = hex('e5');

/** Three pages of real prose, long enough that a page turn is visible. */
const PAGES = [
  'It is a truth universally acknowledged that a reader on a sofa three metres from the screen deserves type they can actually see.',
  'The second page proves the reader asked for page two and got page two, rather than redrawing the same words with a different number beside them.',
  'The third page is the last, so the Next button must switch itself off here and paging past it must be a quiet no-op.',
];

const PAGE_IMAGE = await readFile(join(ROOT, 'icon-192.png'));

/**
 * Anna's rows first, then Usenet — the live ordering, because Anna's is the
 * broadest library and the owner's ranking puts it first. The FIRST row is a
 * readable Anna's reference on purpose: it is what a real search returns and
 * it is the row that was silently refused for a whole day.
 */
const ROWS = [
  {
    source: 'annas', provider: "Anna's Archive", title: 'Dune 1 · Frank Herbert - Le cycle de Dune - 1',
    format: 'EPUB', size: 0, url: `https://addon.lyreosai.com/book/ref/${ANNAS}`,
    direct: true, playable: true, tier: 5,
  },
  {
    source: 'annas', provider: "Anna's Archive", title: 'Dune — Frank Herbert', format: 'EPUB',
    size: 0, url: 'https://annas-archive.gl/md5/deadbeef', direct: false, playable: true, tier: 5,
  },
  {
    // `direct:true` and yet the link is not ours. The one shape that would mean
    // a client had been handed a provider link, so it must be refused and named
    // as its own fault rather than lumped in with "this is only a page".
    source: 'annas', provider: "Anna's Archive", title: 'Dune — a link that is not ours', format: 'EPUB',
    size: 0, url: 'https://libgen.example/get/deadbeef.epub', direct: true, playable: true, tier: 5,
  },
  {
    source: 'usenet', provider: 'Usenet', title: 'Dune (1965) [EPUB]', format: 'EPUB',
    size: 1_400_000, url: `https://addon.lyreosai.com/usenet/${EPUB}`, direct: true, playable: true, tier: 5,
  },
  {
    source: 'usenet', provider: 'Usenet', title: 'Dune Messiah [EPUB]', format: 'EPUB',
    size: 900_000, url: null, direct: false, playable: false, tier: 5, sizeSuspect: true,
  },
];

const browser = await launchBrowser();
const errors = [];
const seen = [];

async function openApp({ profile = { isKids: false, maxRating: 'adult' }, book, readingMode = null, progress = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // `null` means the reader has chosen NOTHING, which is the state section 8
  // exists to pin — so it is the default here rather than a mode, and any
  // section that asserts a particular mode seeds it out loud.
  if (readingMode) {
    await ctx.addInitScript((mode) => {
      try { localStorage.setItem('blazing-reading-mode-v1', mode); } catch { /* a private store is not a choice */ }
    }, readingMode);
  }
  // A reading position left over from a previous session, written exactly the
  // way tv-book-reader.js writes it.
  if (progress) {
    await ctx.addInitScript((seed) => {
      try {
        localStorage.setItem(`blazing-book-progress-v1:${encodeURIComponent(seed.profileId)}`,
          JSON.stringify({ [seed.token]: { page: seed.page, count: seed.count || seed.page, title: 'Dune', mode: 'text' } }));
      } catch { /* a private store loses the place, which is not this test */ }
    }, progress);
  }
  await ctx.route('https://addon.lyreosai.com/**', (route) => {
    const url = route.request().url();
    seen.push(url);
    const j = (body, status = 200, headers = {}) => route.fulfill({
      status, contentType: 'application/json', headers, body: JSON.stringify(body),
    });
    if (route.request().resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PAGE_IMAGE });
    }
    if (url.includes('/book/pages/')) {
      const token = new URL(url).pathname.split('/').pop();
      const query = new URL(url).searchParams;
      const chars = Number(query.get('chars')) || 1800;
      if (token === PDF) {
        return j({ error: 'unsupported-format', format: 'pdf', mode: 'unsupported',
          message: 'A PDF is fixed layout and cannot be reflowed to text.' }, 415);
      }
      if (token === SLOW) {
        return j({ state: 'downloading', reason: '', retryAfter: 5,
          message: 'Usenet is fetching this book. Try again shortly.' }, 202, { 'retry-after': '5' });
      }
      if (token === GONE) {
        return j({ error: 'invalid-reference', message: 'That is not a book reference from /search/book.' }, 400);
      }
      if (token === FIXED) {
        return j({ mode: 'image', token, format: 'pdf', chapters: 1, charsPerPage: chars, count: 3, page: 1,
          title: 'A Fixed Layout Book',
          pages: ['/book/image/e5/1.png', '/book/image/e5/2.png', 'https://addon.lyreosai.com/book/image/e5/3.png'] });
      }
      // The real text route. `chars` really does change the pagination, so the
      // count moves with the font control exactly as the server's would.
      //
      // `pages` IS AN ARRAY OF `{ n, text }` OBJECTS, not of strings. That is
      // what server.js sends and it is the shape this fixture used to get
      // wrong. Do not "simplify" it back to a string: the client's guard reads
      // this shape, and a fixture that hands it a string proves nothing about
      // the server it is standing in for.
      const count = chars >= 3000 ? 2 : chars >= 1500 ? 3 : 6;
      const requested = Number(query.get('page'));
      if (requested < 1 || requested > count) {
        return j({ error: 'no-such-page', count, message: `This book has ${count} pages.` }, 404);
      }
      return j({ mode: 'text', token, format: 'epub', chapters: 24, charsPerPage: chars, count,
        page: requested, title: 'Dune',
        pages: [{ n: requested, text: `[${chars}] ${PAGES[(requested - 1) % PAGES.length]}` }] });
    }
    if (url.includes('/search/book')) {
      return j({ query: 'dune', count: ROWS.length, results: ROWS,
        sources: ["Anna's Archive", 'Usenet'], usenetEnabled: true, unavailable: null });
    }
    if (url.includes('/api/ui/home-config')) return j({}, 404);
    if (url.includes('/manifest.json')) return j({ catalogs: [] });
    return j({ metas: [], items: [], streams: [], profiles: [] });
  });
  await ctx.route('https://fleet.lyreosai.com/**', (route) => {
    const url = route.request().url();
    if (route.request().resourceType() === 'image') {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PAGE_IMAGE });
    }
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    if (url.includes('/manga/discover') || url.includes('/manga/search')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ popular: [MANGA], latest: [] }) });
    }
    if (url.includes('/chapters')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ chapters: [{ id: 'c1', chapter: '1', volume: '1', title: 'One', pages: 3, readable: true }] }) });
    }
    if (url.includes('/pages')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ pages: ['/manga/image?ch=c1&p=1', '/manga/image?ch=c1&p=2', '/manga/image?ch=c1&p=3'] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], metas: [] }) });
  });
  await ctx.route('https://anime-kitsu.strem.fun/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metas: [] }) }));
  await prepareProfile(ctx, profile);
  const page = await ctx.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await selectProfile(page);
  if (book) await page.evaluate(() => document.querySelector('.topnav [data-view="books"]').click());
  return { ctx, page };
}

const MANGA = {
  id: 'm1', title: 'Long Strip', description: 'A webtoon.', year: '2020', status: 'ongoing',
  originalLanguage: 'ko', lastChapter: '3', cover: '/manga/image?id=m1', source: 'MangaDex',
};

/* ── 1. The books row ─────────────────────────────────────────────────────── */
{
  const { ctx, page } = await openApp({ book: true });
  await page.waitForSelector('#book-search-input', { timeout: 10000 });
  ok(await page.locator('#book-search-host').isVisible(), 'the books route shows the real book shelf');

  await page.fill('#book-search-input', 'dune');
  await page.locator('#book-search-host form button[type="submit"]').click();
  await page.waitForSelector('.book-row', { timeout: 10000 });

  is(await page.locator('.book-row').count(), 5, 'every result is drawn, openable or not');
  is(await page.locator('.book-open').count(), 2, 'ONLY the rows carrying one of OUR references offer Read');
  is(await page.locator('.book-row-why').count(), 3, 'the other three say why, in words');

  // THE REGRESSION, PINNED. Row 0 is an Anna's `/book/ref/` reference, which is
  // what every live result actually is. It got no Read button for a whole day
  // because the client matched `/usenet/` alone, so the shelf looked full and
  // nothing in it opened. Asserted on row 0 by index, not by "some row has a
  // button", because "some row" was already true and still meant a dead shelf.
  ok(await page.locator('.book-row').nth(0).locator('.book-open').isVisible(),
    "an Anna's /book/ref/ reference is readable — the live shape, and the one that was refused");
  ok(await page.locator('.book-row').nth(3).locator('.book-open').isVisible(),
    'a Usenet /usenet/ reference is still readable too');

  const annas = (await page.locator('.book-row').nth(1).locator('.book-row-why').textContent()) || '';
  ok(/download page/i.test(annas), "the Anna's page-only row explains it is a page, not a file", annas.slice(0, 80));
  const foreign = (await page.locator('.book-row').nth(2).locator('.book-row-why').textContent()) || '';
  ok(/other than our own server/i.test(foreign),
    'a direct row pointing off our origin is refused and NAMED as that fault', foreign.slice(0, 80));
  const noRef = (await page.locator('.book-row').nth(4).locator('.book-row-why').textContent()) || '';
  ok(/reference/i.test(noRef), 'the reference-less Usenet row explains itself', noRef.slice(0, 80));
  ok(seen.some((u) => u.includes('/search/book?q=dune')), 'the row really called /search/book');
  ok(!seen.some((u) => u.includes('libgen.example')), 'the foreign link was never followed');
  const status = (await page.locator('.book-search-status').textContent()) || '';
  ok(status.includes('5 results') && status.includes('2 can be opened'),
    'the status counts what can actually be opened', status);

  /* ── 2. Reading it ─────────────────────────────────────────────────────── */
  // .first() is row 0, the Anna's reference — the path a real reader takes.
  await page.locator('.book-open').first().click();
  await page.waitForFunction(() => !document.getElementById('book-reader').hidden, null, { timeout: 10000 });
  await page.waitForFunction(() => (document.querySelector('#book-reader .book-page').textContent || '').length > 20,
    null, { timeout: 10000 });

  is(await page.locator('#book-reader .comic-counter').textContent(), 'Page 1 of 3', 'the page indicator is on screen');
  is(await page.locator('#book-reader .comic-label').textContent(), 'Dune', 'the reader is titled with the book');
  const first = (await page.locator('#book-reader .book-page').textContent()) || '';
  ok(first.includes('[1800]'), 'page one asked for the default 1800 characters', first.slice(0, 20));
  // THE SECOND REGRESSION, PINNED. The fixture returns `[{ n, text }]`, which
  // is what the server sends. Words on screen prove the client read the object
  // rather than refusing it as "not a string" — the failure that put "This book
  // could not be read" on top of every real book.
  ok(/truth universally acknowledged/.test(first),
    'a { n, text } page renders its WORDS, not a refusal', first.slice(0, 60));
  ok(!/\[object Object\]/.test(first), 'and not the object itself');
  ok(seen.some((u) => u.includes(`/book/pages/${ANNAS}?page=1&chars=1800`)),
    "the reader asked for ONE page, by the Anna's token the row carried");
  ok(!seen.some((u) => u.includes('annas-archive')), 'no client request ever touched an upstream book source');

  const size = await page.evaluate(() => getComputedStyle(document.querySelector('#book-reader .book-page')).fontSize);
  is(size, '34px', 'text opens at the ten-foot default size');

  await page.locator('#book-reader .book-page').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#book-reader .comic-counter').textContent === 'Page 2 of 3',
    null, { timeout: 5000 });
  const second = (await page.locator('#book-reader .book-page').textContent()) || '';
  ok(second !== first && second.includes('page two'), 'the arrow key really turned the page', second.slice(0, 40));

  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('#book-reader .comic-counter').textContent === 'Page 1 of 3',
    null, { timeout: 5000 });
  is(await page.locator('#book-reader .book-page').textContent(), first, 'going back shows the same page one');

  /* ── 3. The font control is the point of reflowable text ───────────────── */
  await page.locator('#book-reader .book-bigger').click();
  await page.waitForFunction(() => (document.querySelector('#book-reader .book-page').textContent || '').includes('[1300]'),
    null, { timeout: 5000 });
  is(await page.evaluate(() => getComputedStyle(document.querySelector('#book-reader .book-page')).fontSize),
    '42px', 'bigger type is really bigger');
  ok(seen.some((u) => u.includes(`chars=1300`)), 'a bigger face asks the server for FEWER characters a page');
  is(await page.locator('#book-reader .comic-counter').textContent(), 'Page 1 of 6',
    'the total repaginates with the type size');

  await page.locator('#book-reader .book-smaller').click();
  await page.locator('#book-reader .book-smaller').click();
  await page.waitForFunction(() => (document.querySelector('#book-reader .book-page').textContent || '').includes('[2400]'),
    null, { timeout: 5000 });
  is(await page.evaluate(() => localStorage.getItem('blazing-book-text-size-v1')), '1',
    'the chosen size is remembered on this device');

  /* ── 3b. THE TOOLBAR IS REACHABLE WITH ARROWS ALONE ────────────────────── */
  /**
   * A television remote has four arrows, OK and Back. No Tab, no `+`. Every
   * arrow used to turn a page whatever was focused, so A− and A+ — the whole
   * point of reflowable text — could not be reached on the one device this app
   * is built for. Proved here with arrows only: no Tab press, no click.
   */
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.className || el.tagName}`.split(' ').find((c) => c.startsWith('book-') || c.startsWith('comic-')) || el.tagName : 'none';
  });
  await page.locator('#book-reader .book-page').focus();
  is(await focused(), 'book-page', 'the reader starts on the words');
  await page.keyboard.press('ArrowUp');
  const onBar = await focused();
  ok(onBar.startsWith('book-') || onBar.startsWith('comic-'),
    'UP off the words lands on the toolbar, not on the previous page', onBar);
  const before = await page.locator('#book-reader .comic-counter').textContent();

  // Walk the row with RIGHT until the type control is reached, pressing nothing
  // else. If the row cannot be walked this loop simply never finds it.
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    if (await focused() === 'book-bigger') { reached = true; break; }
    await page.keyboard.press('ArrowRight');
  }
  ok(reached, 'RIGHT walks the toolbar and reaches the A+ control');
  is(await page.locator('#book-reader .comic-counter').textContent(), before,
    'and walking the toolbar never turned a page behind it');

  await page.keyboard.press('ArrowUp');
  is(await focused(), 'book-bigger', 'UP on the top row does nothing — it does not turn a page either');
  is(await page.locator('#book-reader .comic-counter').textContent(), before, 'still the same page');

  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('#book-reader .book-page').textContent || '').includes('[1800]'),
    null, { timeout: 5000 });
  is(await page.evaluate(() => getComputedStyle(document.querySelector('#book-reader .book-page')).fontSize),
    '34px', 'OK on A+ really changes the type size, from a remote alone');

  await page.keyboard.press('ArrowDown');
  is(await focused(), 'book-page', 'DOWN comes back to the words');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /Page 2 of/.test(document.querySelector('#book-reader .comic-counter').textContent || ''),
    null, { timeout: 5000 });
  ok(true, 'and the arrows turn pages again once you are back on them');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('book-reader').hidden === true, null, { timeout: 5000 });
  ok(true, 'Escape closes the reader');
  await ctx.close();
}

/* ── 4. Every refusal is said out loud ────────────────────────────────────── */
{
  const { ctx, page } = await openApp({ book: true });
  await page.waitForSelector('#book-search-input', { timeout: 10000 });

  /**
   * Wait for the status to say its ANSWER, not its placeholder.
   *
   * loadPage() writes "Opening the book…" the moment the request goes out, so
   * a wait for "the status has text" is satisfied instantly and the assertion
   * that follows reads the placeholder — the exact trap manga.smoke.mjs
   * documents at length. The wait is therefore for the words this case is
   * about, and a status that never gets there times out on its own account.
   */
  const openAndRead = async (token, expect) => {
    await page.evaluate((t) => window.BlazingBookReader.open({ token: t, title: 'Test', profileId: 'p1' }), token);
    await page.waitForFunction((pattern) => {
      const s = document.querySelector('#book-reader .book-status');
      return Boolean(s) && !s.hidden && new RegExp(pattern, 'i').test(s.textContent || '');
    }, expect.source, { timeout: 15000 });
    return (await page.locator('#book-reader .book-status').textContent()) || '';
  };

  const pdf = await openAndRead(PDF, /another copy/);
  ok(/PDF/.test(pdf), 'a PDF says it is a PDF and what to do', pdf.slice(0, 110));
  is(await page.locator('#book-reader .book-page').textContent(), '', 'a refused book leaves no half-drawn page');

  const slow = await openAndRead(SLOW, /checking again in/);
  ok(/fetching/i.test(slow) && /\d+s/.test(slow), 'a book still downloading says so, with the wait', slow.slice(0, 110));

  const gone = await openAndRead(GONE, /reference/);
  ok(/reference/i.test(gone), 'a rejected reference is explained, not swallowed', gone.slice(0, 110));

  is(await page.evaluate(() => window.BlazingBookReader.open({ token: 'not-a-token' })), 'false',
    'a malformed reference never opens the reader at all');
  await ctx.close();
}

/* ── 4b. A page that is past the end BOUNCES, it does not dead-end ────────── */
{
  /**
   * A saved reading position can outlive the pagination that produced it: the
   * page count depends on `chars`, and `chars` is the reader's own type-size
   * choice. Come back at a bigger face and page 40 of 412 may be past the end.
   * The route answers 404 AND says the real count in the same breath, so the
   * reader must land on the nearest page that exists rather than showing "this
   * book has 3 pages" beside a Try again button that asks for page 40 for ever.
   */
  const { ctx, page } = await openApp({ book: true, progress: { profileId: 'p1', token: EPUB, page: 40, count: 412 } });
  await page.waitForSelector('#book-search-input', { timeout: 10000 });
  await page.evaluate((t) => window.BlazingBookReader.open({ token: t, title: 'Dune', profileId: 'p1' }), EPUB);
  await page.waitForFunction(() => (document.querySelector('#book-reader .book-page').textContent || '').length > 20,
    null, { timeout: 15000 });
  is(await page.locator('#book-reader .comic-counter').textContent(), 'Page 3 of 3',
    'a saved page past the end lands on the last real page, not on a dead end');
  ok(await page.locator('#book-reader .book-status').isHidden(),
    'and it is words on screen, not an error the reader has to clear');
  ok(seen.some((u) => u.includes(`/book/pages/${EPUB}?page=40`)), 'it really did ask for the impossible page first');

  /* ── 5. A fixed-layout book uses the comics page rail ───────────────────── */
  await page.evaluate((t) => window.BlazingBookReader.open({ token: t, title: 'Fixed', profileId: 'p1' }), FIXED);
  await page.waitForSelector('#book-reader .book-image[src]', { timeout: 10000 });
  const src = await page.locator('#book-reader .book-image').getAttribute('src');
  ok(src.startsWith('https://addon.lyreosai.com/book/image/'),
    'a relative page path is joined onto OUR origin, never an upstream one', src);
  is(await page.locator('#book-reader .comic-counter').textContent(), 'Page 1 of 3',
    'a fixed-layout book counts pages too');
  ok(await page.locator('#book-reader .book-page').isHidden(), 'the text surface is put away for an image book');
  ok(await page.locator('#book-reader .book-mode').isVisible(),
    'the mode switch appears only for an image book, where a strip means something');

  /* ── 6. Continuous top-to-bottom reading ───────────────────────────────── */
  await page.locator('#book-reader .book-mode').click();
  await page.waitForSelector('#book-reader .book-strip .comic-strip-page', { timeout: 10000 });
  is(await page.locator('#book-reader .book-strip .comic-strip-page').count(), 3,
    'the strip stacks every page in one column');
  is(await page.evaluate(() => localStorage.getItem('blazing-reading-mode-v1')), 'strip',
    'the reading mode is remembered');
  ok(await page.locator('#book-reader .book-image').isHidden(), 'the single-page image is put away in strip mode');
  ok(await page.locator('#book-reader .book-previous').isHidden(),
    'a page-turn button is hidden in a strip, not left there doing nothing');

  await page.waitForFunction(() => {
    const el = document.querySelector('#book-reader .book-strip');
    return el.scrollHeight > el.clientHeight + 200;
  }, null, { timeout: 10000 });
  is(await page.evaluate(() => document.querySelector('#book-reader .book-strip').scrollTop), '0',
    'page one of the strip is the TOP of the strip, not one toolbar height down');
  const glide = await page.evaluate(async () => {
    const el = document.querySelector('#book-reader .book-strip');
    el.focus();
    const press = () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const settle = () => new Promise((r) => setTimeout(r, 700));
    const before = el.scrollTop;
    press();
    await settle();
    const one = el.scrollTop;
    // Three in quick succession, the way a held D-pad repeats.
    press(); press(); press();
    await settle();
    return { before, one, three: el.scrollTop, screen: el.clientHeight };
  });
  ok(glide.one > glide.before, 'a D-pad press scrolls the strip', `${glide.before} -> ${Math.round(glide.one)}`);
  ok(glide.one - glide.before < glide.screen,
    'it GLIDES a fraction of the screen instead of jumping a whole page',
    `moved ${Math.round(glide.one - glide.before)}px of a ${glide.screen}px screen`);
  ok(glide.three - glide.one > (glide.one - glide.before) * 2,
    'three quick presses travel about three times as far — a held D-pad keeps moving',
    `one press ${Math.round(glide.one - glide.before)}px, next three ${Math.round(glide.three - glide.one)}px`);

  await page.locator('#book-reader .book-mode').click();
  await page.waitForSelector('#book-reader .book-image[src]', { timeout: 5000 });
  ok(await page.locator('#book-reader .book-strip').isHidden(), 'paged reading is still there and still works');
  is(await page.evaluate(() => localStorage.getItem('blazing-reading-mode-v1')), 'paged',
    'switching back is remembered too');
  await ctx.close();
}

/* ── 7. The manga reader has the same switch — where the viewer asked ─────── */
{
  // Seeded paged ON PURPOSE. Manga's own fallback is the strip now (section 8),
  // and this case is about the SWITCH still working in both directions, not
  // about which way the reader opens. Inheriting the default here would have
  // made this block quietly test the same thing as section 8.
  const { ctx, page } = await openApp({ readingMode: 'paged' });
  await page.evaluate(() => document.querySelector('[data-view="manga"]').click());
  await page.waitForSelector('#manga-rows .card', { timeout: 15000 });
  await page.locator('#manga-rows .card').first().click();
  await page.waitForSelector('#manga-chapters-dialog[open] .stream-row', { timeout: 15000 });
  await page.locator('#manga-chapters-dialog .stream-row').first().click();
  await page.waitForFunction(() => !document.getElementById('manga-reader').hidden, null, { timeout: 10000 });
  await page.waitForSelector('#manga-reader .comic-page[src]', { timeout: 15000 });
  is(await page.locator('#manga-reader .comic-counter').textContent(), '1 / 3', 'the manga reader still pages');

  await page.locator('#manga-reader .comic-mode').click();
  await page.waitForSelector('#manga-reader .comic-strip .comic-strip-page', { timeout: 10000 });
  is(await page.locator('#manga-reader .comic-strip .comic-strip-page').count(), 3,
    'the whole chapter becomes one continuous strip');
  await page.waitForFunction(() => {
    const el = document.querySelector('#manga-reader .comic-strip');
    return el.scrollHeight > el.clientHeight + 200;
  }, null, { timeout: 10000 });
  const moved = await page.evaluate(async () => {
    const el = document.querySelector('#manga-reader .comic-strip');
    el.focus();
    const before = el.scrollTop;
    for (let i = 0; i < 3; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: el.scrollTop, screen: el.clientHeight, step: Math.round(el.clientHeight * 0.33) };
  });
  ok(moved.before === 0, 'the manga strip opens at the top of page one', String(moved.before));
  ok(moved.after > moved.step * 2, 'holding down the D-pad keeps the strip moving, press after press',
    `${moved.before} -> ${Math.round(moved.after)} (one press would be ~${moved.step}px)`);
  ok(moved.after < moved.screen * 2, 'and it is still a glide, not a leap through the chapter',
    `${Math.round(moved.after)}px of a ${moved.screen}px screen`);

  await page.locator('#manga-reader .comic-mode').click();
  await page.waitForSelector('#manga-reader .comic-page[src]', { timeout: 5000 });
  ok(await page.locator('#manga-reader .comic-strip').isHidden(), 'manga paged reading survives the new mode');
  await ctx.close();
}

/* ── 8. WHAT EACH SURFACE DOES WHEN THE READER HAS CHOSEN NOTHING ───────────
 * Built-but-off-by-default is not delivered. The viewer asked for the
 * top-to-bottom read — "it makes it feel more like a movie" — and with a paged
 * default he opens a chapter, sees page-by-page, and has to go and find a
 * button. So MANGA opens on the strip. Comics and books do not: plenty of them
 * really are drawn as facing pages.
 *
 * ONE localStorage KEY IS SHARED BY ALL THREE, which is why the default cannot
 * live in the store — it is an argument to tv-reading-mode.js's get(fallback),
 * decided per surface at the call.
 *
 * Three things must hold at once, and the third is the one that breaks
 * quietly: a stored choice has to beat the fallback in BOTH directions, or the
 * app overrules a reader who just told it what they wanted.
 *
 * THE TRAP THIS ALSO GUARDS. A "default" implemented by WRITING strip on first
 * open is not a default — it is a silent choice made for the reader, it makes
 * "has this reader chosen?" unanswerable for ever after, and because the key is
 * shared it would flip comics and books too. So the key must still be EMPTY
 * after manga has opened on the strip. That is the assertion below that looks
 * least important and is worth the most. */
const openMangaChapter = async (page) => {
  await page.evaluate(() => document.querySelector('[data-view="manga"]').click());
  await page.waitForSelector('#manga-rows .card', { timeout: 15000 });
  await page.locator('#manga-rows .card').first().click();
  await page.waitForSelector('#manga-chapters-dialog[open] .stream-row', { timeout: 15000 });
  await page.locator('#manga-chapters-dialog .stream-row').first().click();
  await page.waitForFunction(() => !document.getElementById('manga-reader').hidden, null, { timeout: 10000 });
};

/* 8a. Nothing stored + MANGA = the strip. */
{
  const { ctx, page } = await openApp();
  await openMangaChapter(page);
  await page.waitForSelector('#manga-reader .comic-strip .comic-strip-page', { timeout: 15000 });
  is(await page.locator('#manga-reader .comic-strip .comic-strip-page').count(), 3,
    'nothing stored + MANGA opens on the continuous strip, with no button to go and find');
  ok(await page.locator('#manga-reader .comic-page').isHidden(),
    'the paged image is put away, so the strip is what is really on screen');
  is(await page.evaluate(() => localStorage.getItem('blazing-reading-mode-v1')), 'null',
    'a default is NOT a choice: opening the strip wrote nothing to the shared key');
  is(await page.locator('#manga-reader .comic-mode').textContent(), 'Page by page',
    'the switch offers the way OUT of the mode it opened in, not back into it');
  await page.locator('#manga-reader .comic-mode').click();
  await page.waitForSelector('#manga-reader .comic-page[src]', { timeout: 10000 });
  ok(await page.locator('#manga-reader .comic-strip').isHidden(),
    'one press really leaves the strip — the button is not a no-op on its first use');
  is(await page.evaluate(() => localStorage.getItem('blazing-reading-mode-v1')), 'paged',
    'and THAT is a choice, so it is written down');
  await ctx.close();
}

/* 8b. Nothing stored + a BOOK (and so comics, same bare call) = paged. */
{
  const { ctx, page } = await openApp({ book: true });
  await page.waitForSelector('#book-search-input', { timeout: 10000 });
  await page.evaluate((t) => window.BlazingBookReader.open({ token: t, title: 'Fixed', profileId: 'p1' }), FIXED);
  await page.waitForSelector('#book-reader .book-image[src]', { timeout: 10000 });
  ok(await page.locator('#book-reader .book-strip').isHidden(),
    'nothing stored + a BOOK still opens paged — manga’s default did not leak through the shared key');
  is(await page.locator('#book-reader .book-mode').textContent(), 'Continuous scroll',
    'and its switch offers the strip, which is the way out of paged');
  await ctx.close();
}

/* 8c. A stored choice beats the fallback, in BOTH directions. */
{
  // The direction that is easiest to get wrong: a reader who deliberately put
  // MANGA back to paged must not be shoved onto the strip again next time.
  const { ctx, page } = await openApp({ readingMode: 'paged' });
  await openMangaChapter(page);
  await page.waitForSelector('#manga-reader .comic-page[src]', { timeout: 15000 });
  is(await page.locator('#manga-reader .comic-counter').textContent(), '1 / 3',
    'a stored "paged" beats manga’s strip fallback — the app does not fight the reader');
  ok(await page.locator('#manga-reader .comic-strip').isHidden(), 'and the strip really is put away');
  await ctx.close();
}
{
  // The other direction, on the surface whose fallback is paged.
  const { ctx, page } = await openApp({ book: true, readingMode: 'strip' });
  await page.waitForSelector('#book-search-input', { timeout: 10000 });
  await page.evaluate((t) => window.BlazingBookReader.open({ token: t, title: 'Fixed', profileId: 'p1' }), FIXED);
  await page.waitForSelector('#book-reader .book-strip .comic-strip-page', { timeout: 15000 });
  is(await page.locator('#book-reader .book-strip .comic-strip-page').count(), 3,
    'a stored "strip" beats the book’s paged fallback, so a choice carries across surfaces');
  await ctx.close();
}

ok(errors.length === 0, 'no page errors', errors[0] || '');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
