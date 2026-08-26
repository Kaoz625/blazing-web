Working on: blazing-web (the live public PWA) — 4K Upscale button UX, the upscale host/contract, and the proxy resolver moved from the default play path to a fallback.

Last action: Edited app.js, styles.css, index.html, sw.js (CACHE v7 -> v8) and added upscale.smoke.mjs.
All three smoke tests green: locker 35/0, watch-party 15/0, upscale 50/0. NOT committed, NOT pushed —
the orchestrator owns git for this run.

Next step:
  1. Read the diff:  cd "/Users/markususche/Desktop/blazing-web" && git diff
  2. Re-run the checks: node upscale.smoke.mjs && node locker.smoke.mjs && node watch-party.smoke.mjs
  3. Commit + push (push auto-deploys GitHub Pages).

Key files:
  - /Users/markususche/Desktop/blazing-web/app.js       (upscale module ~L455-620, player fallback ~L690-800)
  - /Users/markususche/Desktop/blazing-web/styles.css   (.secondary-button.is-spent, .toast-host/.toast)
  - /Users/markususche/Desktop/blazing-web/index.html   (aria-pressed on #detail-upscale)
  - /Users/markususche/Desktop/blazing-web/sw.js        (CACHE = blazing-shell-v8)
  - /Users/markususche/Desktop/blazing-web/upscale.smoke.mjs  (new, 50 checks)

Blockers:
  1. THE WEB UPSCALE BUTTON CANNOT WORK UNTIL THE BACKEND SENDS CORS HEADERS.
     Measured 26 Aug 2026:
       OPTIONS https://upscale.lyreosai.com/api/upscale/request  -> 405, allow: POST, no access-control-* header
       POST    (same URL)                                        -> 200, still no access-control-allow-origin
     Content-Type: application/json forces a preflight, the preflight 405s, so the browser never
     sends the POST. Roku / tvOS / Fire TV are native and unaffected. Fix belongs in the upscale
     FastAPI service (CORSMiddleware, allow the Pages origin). The client is already correct and
     starts working the moment CORS lands.
  2. GET https://upscale.lyreosai.com/api/upscale/status -> 404. Not deployed. Handled gracefully
     (button keeps its normal label), but the "already requested" label will not appear until the
     route ships.
  3. GET https://addon.lyreosai.com/proxy/resolve -> 404 and /proxy/resolve/redirect -> 404.
     Neither is deployed. That is fine now: the resolver is only a fallback.

Facts worth keeping:
  - The deployed POST response has NO "count" field and its message reads
    "'<title>' has been added to the AI Queue and is awaiting Admin approval." — it does NOT say
    "Requested N times". The client falls back to a count of 1. The message is matched strictly
    (/requested\s+(\d+)\s+time/i) so a title like "Dune 2" cannot be misread as a count of 2.
  - `meta` has no `.title` — safeMeta() produces `.name`. The old status call sent the literal
    string "undefined".
  - #detail-dialog is opened with showModal(), so a body-level popup draws UNDER it at any
    z-index. The toast host is moved into the open dialog for exactly this reason.
  - FIXED A PRE-EXISTING LIVE BUG: `adminView` was read by showRoute() on every navigation but
    never declared, so under 'use strict' every route change threw ReferenceError before
    updateNavigation() and closeDrawer() could run. Proven on a pristine HEAD checkout with
    locker.smoke.mjs. One line: `const adminView = $('#admin-view');`
