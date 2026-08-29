// Headless smoke test for the 4K Upscale button and for the proxy resolver
// being a PLAYBACK FALLBACK rather than the default path (app.js).
//
// Nothing real is contacted. Every upscale/addon/fleet call is intercepted, so
// no row is written to the production AI queue.
//
// What is proved here:
//   1. the host is https://upscale.lyreosai.com for BOTH routes, and no http://
//      URL is ever requested (this page ships over https; mixed content is
//      blocked outright and has broken this repo once already);
//   2. the status request carries the real title, not the string "undefined";
//   3. count > 0 on open  -> "Requested N times" + the pressed/spent state;
//      count 0 or a 404   -> the normal label and the normal look;
//   4. the POST body is exactly {title, media_type, video_url} — no imdb_id;
//   5. a successful press pops a SEPARATE popup (not the button label) carrying
//      the backend message, and only then does the button flip to spent;
//   6. the deployed response shape (status "queued", NO "count" field, a message
//      that does not say "Requested N times") still yields a usable count of 1;
//   7. HONESTY RULE: 200 + {"status":"error"} is a FAILURE — error popup, button
//      left exactly as it was, pressable again;
//   8. once spent the button is still focusable, but a second press sends NO
//      second POST;
//   9. PLAYBACK: the server URL is played first and /proxy/resolve is NOT called;
//  10. PLAYBACK: only when that URL fails does /proxy/resolve run, and its URL
//      is then played;
//  11. PLAYBACK: a resolver that never answers ends in a visible error, not a
//      permanent spinner.
import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = '/Users/markususche/Desktop/blazing-web';
const CHROME = '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const TITLE = 'Dune 2';
const META = { id: 'tt0000001', type: 'movie', name: TITLE, year: '2026', poster: 'https://img.example.test/p.jpg' };
const STREAM_URL = 'https://stream.example.test/e/abc123';
const RESOLVED_URL = 'https://cdn.example.test/direct/abc123.mp4';

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

const browser = await chromium.launch({ executablePath: CHROME });

async function openApp({ statusReply, requestReply, resolveReply, streams } = {}) {
  const ctx = await browser.newContext();
  const seen = { status: [], request: [], resolve: [], all: [] };

  await ctx.route('**://**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(base)) return route.continue();
    seen.all.push(url);

    // --- upscale service --------------------------------------------------
    if (url.includes('/api/upscale/status')) {
      seen.status.push(url);
      const reply = statusReply || { status: 404, body: { detail: 'Not Found' } };
      return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    }
    if (url.includes('/api/upscale/request')) {
      seen.request.push({ url, method: req.method(), body: req.postData(), type: req.headers()['content-type'] || '' });
      const reply = requestReply || { status: 200, body: { status: 'queued', message: `'${TITLE}' has been added to the AI Queue and is awaiting Admin approval.` } };
      if (reply.hang) return; // never fulfilled: proves the client's own timeout
      return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    }

    // --- add-on -----------------------------------------------------------
    if (url.includes('/proxy/resolve')) {
      seen.resolve.push(url);
      const reply = resolveReply || { status: 404, body: { error: 'Not found' } };
      if (reply.hang) return;
      return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    }
    if (url.includes('/stream/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ streams: streams || [{ name: '1080p', title: 'test', url: STREAM_URL }] }) });
    }
    if (url.includes('/manifest.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [] }) });
    }
    if (url.includes('/discover/filter/in-theaters')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [META] }) });
    }

    // Everything else the app pokes on boot stays quiet.
    if (url.includes('/party/active')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], metas: [], profiles: [] }) });
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  // ratingAllowed() defaults state.profileCap to 'general' until a profile is
  // actually picked, and refuses this fixture's unrated META — same gate
  // rowhero/home/locker already hit. Without it the card stays a permanent
  // <div class="card skeleton">, never visible, so the click below times out.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('blazing-profile-selected', {
      detail: { id: 'p1', name: 'Mark', maxRating: 'adult', isKids: false },
    }));
    document.querySelectorAll('.bp-layer').forEach((n) => n.remove());
  });
  await page.waitForSelector('.row-track .card:not(.skeleton)', { timeout: 10000 });
  await page.click('.row-track .card');
  await page.waitForSelector('#detail-dialog[open]', { timeout: 5000 });
  return { ctx, page, seen };
}

const readButton = (page) => page.evaluate(() => {
  const b = document.querySelector('#detail-upscale');
  return {
    label: b.textContent.trim(),
    spent: b.classList.contains('is-spent'),
    disabled: b.disabled,
    pressed: b.getAttribute('aria-pressed'),
    focusable: !b.disabled && b.tabIndex > -1,
  };
});

const readToasts = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => ({
  text: t.textContent.trim(),
  error: t.classList.contains('toast-error'),
  // A popup must be its OWN element, outside the button.
  insideButton: Boolean(t.closest('#detail-upscale')),
  // showModal() puts the dialog in the top layer, so the popup has to live
  // inside it or it draws underneath and nobody ever sees it.
  inTopLayer: Boolean(t.closest('dialog[open]')),
  visible: t.getBoundingClientRect().height > 0,
})));

// === 1: the status lookup on open, and the URL it uses =====================
{
  const { ctx, page, seen } = await openApp({ statusReply: { status: 200, body: { count: 3 } } });
  await page.waitForFunction(() => document.querySelector('#detail-upscale').classList.contains('is-spent'), null, { timeout: 5000 });
  const b = await readButton(page);
  const url = seen.status[0] || '';
  check('status uses the upscale host over https', url.startsWith('https://upscale.lyreosai.com/api/upscale/status'), url);
  check('status sends the real title, not "undefined"', url.includes(`title=${encodeURIComponent(TITLE)}`), url);
  check('status sends no imdb_id', !url.includes('imdb'), url);
  check('count > 0 relabels the button', b.label === 'Requested 3 times', b.label);
  check('count > 0 draws the spent state', b.spent === true);
  check('the spent button is still focusable', b.focusable === true);
  check('the spent button reports aria-pressed', b.pressed === 'true');
  check('nothing was posted just by opening the page', seen.request.length === 0);
  await ctx.close();
}

// === 2: count 0 and a 404 both leave the button alone ======================
{
  const { ctx, page } = await openApp({ statusReply: { status: 200, body: { count: 0 } } });
  await page.waitForTimeout(400);
  const b = await readButton(page);
  check('count 0 keeps the normal label', b.label === '4K Upscale', b.label);
  check('count 0 keeps the normal look', b.spent === false);
  await ctx.close();
}
{
  // This is today's real world: GET /api/upscale/status -> 404 on the live host.
  const { ctx, page } = await openApp({ statusReply: { status: 404, body: { detail: 'Not Found' } } });
  await page.waitForTimeout(400);
  const b = await readButton(page);
  check('a 404 status route keeps the normal label', b.label === '4K Upscale', b.label);
  check('a 404 status route keeps the normal look', b.spent === false);
  check('a 404 status route leaves the button pressable', b.disabled === false);
  await ctx.close();
}

// === 3: a successful press — popup, then the spent state ==================
{
  const message = `'${TITLE}' has been added to the AI Queue and is awaiting Admin approval.`;
  const { ctx, page, seen } = await openApp({ requestReply: { status: 200, body: { status: 'queued', message } } });
  await page.click('#detail-upscale');
  await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 5000 });
  const toasts = await readToasts(page);
  const b = await readButton(page);
  const post = seen.request[0];
  const body = JSON.parse(post.body);

  check('the POST goes to the upscale host over https', post.url === 'https://upscale.lyreosai.com/api/upscale/request', post.url);
  check('the POST is a POST', post.method === 'POST', post.method);
  check('the POST body is exactly {title, media_type, video_url}',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['media_type', 'title', 'video_url']), Object.keys(body).join(','));
  check('the POST sends the real title', body.title === TITLE, String(body.title));
  check('the POST sends a contract media_type', body.media_type === 'movie', String(body.media_type));
  check('the POST sends the pending video_url', body.video_url === 'pending:no-stream-selected', String(body.video_url));
  check('the POST sends no imdb_id', !('imdb_id' in body));

  check('the message is a popup, one of them', toasts.length === 1, String(toasts.length));
  check('the popup carries the backend message', toasts[0].text === message, toasts[0].text);
  check('the popup is NOT inside the button', toasts[0].insideButton === false);
  check('the popup renders in the dialog top layer, so it is actually seen', toasts[0].inTopLayer === true);
  check('the popup has real height on screen', toasts[0].visible === true);

  // The deployed message says nothing about a count, and the response has no
  // "count" field, so the label must fall back to 1 rather than break.
  check('the button flips to the requested label', b.label === 'Requested 1 times', b.label);
  check('the button takes the spent state', b.spent === true);
  check('the spent button stays focusable', b.focusable === true);
  check('the button label is NOT the raw backend message', b.label !== message);

  // === 8: a second press must not fire a second request ===================
  await page.click('#detail-upscale');
  await page.waitForTimeout(500);
  check('a second press sends NO second POST', seen.request.length === 1, String(seen.request.length));
  const again = await readButton(page);
  check('a second press keeps the spent label', again.label === 'Requested 1 times', again.label);
  await ctx.close();
}

// === 4: "count" is honoured when the backend does send it =================
{
  const { ctx, page } = await openApp({ requestReply: { status: 200, body: { status: 'queued', message: 'Requested 7 times', count: 7 } } });
  await page.click('#detail-upscale');
  await page.waitForFunction(() => document.querySelector('#detail-upscale').classList.contains('is-spent'), null, { timeout: 5000 });
  const b = await readButton(page);
  check('a returned count is used verbatim', b.label === 'Requested 7 times', b.label);
  await ctx.close();
}
{
  // No "count", but the documented message. The number must come out of the
  // message and NOT out of the "2" in the title "Dune 2".
  const { ctx, page } = await openApp({ requestReply: { status: 200, body: { status: 'queued', message: 'Requested 4 times' } } });
  await page.click('#detail-upscale');
  await page.waitForFunction(() => document.querySelector('#detail-upscale').classList.contains('is-spent'), null, { timeout: 5000 });
  const b = await readButton(page);
  check('a missing count falls back to the number in the message', b.label === 'Requested 4 times', b.label);
  await ctx.close();
}

// === 5: HONESTY RULE — 200 with status "error" is a failure ===============
{
  const { ctx, page, seen } = await openApp({ requestReply: { status: 200, body: { status: 'error', message: 'The database rejected this request.' } } });
  await page.click('#detail-upscale');
  await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 5000 });
  const toasts = await readToasts(page);
  const b = await readButton(page);
  check('a 200 that is not "queued" pops an error', toasts[0] && toasts[0].error === true);
  check('the error popup states the backend reason plainly', toasts[0] && toasts[0].text === 'The database rejected this request.', toasts[0] && toasts[0].text);
  check('a failed request never shows a spent state', b.spent === false);
  check('a failed request restores the normal label', b.label === '4K Upscale', b.label);
  check('a failed request leaves the button pressable', b.disabled === false);
  // ...and pressable means it really does send again.
  await page.click('#detail-upscale');
  await page.waitForTimeout(400);
  check('the viewer can genuinely try again', seen.request.length === 2, String(seen.request.length));
  await ctx.close();
}

// === 6: a network failure is stated plainly, not swallowed ================
{
  const { ctx, page } = await openApp({ requestReply: { status: 502, body: { detail: 'bad gateway' } } });
  await page.click('#detail-upscale');
  await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 5000 });
  const toasts = await readToasts(page);
  const b = await readButton(page);
  check('a 502 pops an error popup', toasts[0] && toasts[0].error === true, toasts[0] && toasts[0].text);
  check('a 502 leaves the button alone', b.spent === false && b.label === '4K Upscale', b.label);
  await ctx.close();
}

// === 7: no plain-http call anywhere ======================================
{
  const { ctx, page, seen } = await openApp({ statusReply: { status: 200, body: { count: 2 } } });
  await page.waitForTimeout(600);
  const insecure = seen.all.filter((u) => u.startsWith('http://'));
  check('no http:// request is ever made (mixed content would be blocked)', insecure.length === 0, insecure.join(' '));
  await ctx.close();
}

// === 9: playback plays the server URL and does NOT pre-resolve ============
{
  const { ctx, page, seen } = await openApp({});
  await page.waitForSelector('.stream-row', { timeout: 8000 });
  await page.click('.stream-row');
  await page.waitForFunction(() => !document.querySelector('#player').hidden, null, { timeout: 5000 });
  const src = await page.evaluate(() => document.querySelector('#video').getAttribute('src'));
  check('the player is handed the URL the server gave', src === STREAM_URL, String(src));
  check('nothing is pre-resolved before playing', seen.resolve.length === 0, String(seen.resolve.length));
  await ctx.close();
}

// === 10: the resolver runs only as a fallback, after the URL fails ========
{
  // An embed-looking URL that a <video> genuinely cannot decode: the `error`
  // event fires, and only then may /proxy/resolve be asked.
  const { ctx, page, seen } = await openApp({ resolveReply: { status: 200, body: { url: RESOLVED_URL } } });
  await page.waitForSelector('.stream-row', { timeout: 8000 });
  await page.click('.stream-row');
  await page.waitForFunction(() => !document.querySelector('#player').hidden, null, { timeout: 5000 });
  await page.waitForFunction(
    (want) => document.querySelector('#video').getAttribute('src') === want,
    RESOLVED_URL,
    { timeout: 15000 }
  );
  check('a failed load falls back to /proxy/resolve', seen.resolve.length === 1, String(seen.resolve.length));
  check('the resolver is asked for the original URL', seen.resolve[0].includes(encodeURIComponent(STREAM_URL)), seen.resolve[0]);
  check('the resolved URL is what gets played', true);
  await ctx.close();
}

// === 11: a dead resolver ends in a visible error, never a stuck spinner ===
{
  const { ctx, page } = await openApp({ resolveReply: { status: 404, body: { error: 'Not found' } } });
  await page.waitForSelector('.stream-row', { timeout: 8000 });
  await page.click('.stream-row');
  await page.waitForFunction(() => {
    const m = document.querySelector('#player-msg');
    return !m.hidden && m.textContent.trim().length > 0;
  }, null, { timeout: 20000 });
  const state = await page.evaluate(() => ({
    msg: document.querySelector('#player-msg').textContent.trim(),
    spinning: !document.querySelector('#player-spinner').hidden,
  }));
  check('a dead resolver shows a visible failure', state.msg.length > 0, state.msg);
  check('the spinner is not left turning forever', state.spinning === false);
  await ctx.close();
}

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
