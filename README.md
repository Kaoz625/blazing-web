# blazing-web

The Blazing Stream web app. Plain ES modules and CSS, no build step for the app
itself — `app.js` is what the browser runs.

## Deploying — READ THIS FIRST

**`git push` does NOT reach the site Markus uses.**

A push updates GitHub Pages (`kaoz625.github.io/blazing-web`) and nothing else.
The URL Markus actually opens —

    https://blazingstream.lyreosai.com/app/

— is a **separate Cloudflare Pages copy**, assembled by
`~/Desktop/blazing-site/build.sh` (which rsyncs this repo into `dist/app/`) and
deployed by hand. The two hosts drift silently. Measured 29 Aug 2026: a commit
verified live on GitHub Pages was still the **old file** on blazingstream, so
BRK-16's four restored shelves and UI-1's row-hover fix were both "done, pushed,
verified" and both **missing from the living room**.

One command does the whole thing and checks the bytes that actually shipped:

    ~/.claude-team/bin/deploy-web.sh              # build + deploy + verify
    ~/.claude-team/bin/deploy-web.sh --status     # is blazingstream stale?

It refuses to run while this repo is dirty or unpushed, then rebuilds
`blazing-site/dist`, runs `wrangler pages deploy dist --project-name
blazingstream --branch main`, and re-fetches `app.js` from the live URL until
its md5 matches this repo's. A deploy that "succeeded" while the site still
serves the old file is a failure and it is reported as one.

**A push is not the deploy. Finish with `deploy-web.sh`.**

## The service worker will hide your fix

`sw.js` is **network-first for code** (`app.js`, the HTML) and cache-first for
assets, so a code change reaches devices without a cache bump. But bump
`CACHE` (`sw.js:30`, currently `blazing-shell-v19`) whenever the *shell*
changes — it evicts the old entries. Testing locally, use a fresh port: an
installed service worker on a port you have used before will serve you the old
app and the fix will look like it did not work.

## Smoke tests

`*.smoke.mjs` run headless Chromium against a **localhost fixture** — no login,
no real site. This is the one exception to the house rule that browser work goes
through Comet; driving these through Comet would open test pages in Markus's own
browser and write to his profile.

A row test must say **who is watching**. `ratingAllowed()` defaults `profileCap`
to `general` while nobody has chosen, so a test that never dispatches
`blazing-profile-selected` gets an empty grid or a permanent skeleton and looks
like a timeout. That single cause accounted for five separate "broken" tests
(`home`, `rowhero`, `locker`, `upscale`, `watch-party`).

## TV packages

`build-tvs.sh` produces the signed Samsung `Blazing.wgt` and the LG
`com.lyreosai.blazing_1.0.0_all.ipk` into `dist/`. `blazing-site/build.sh` takes
the packages from there and **refuses to publish an unsigned `.wgt`** — an
unsigned widget fails on the TV rather than at build time, which is how an
uninstallable download stayed on the site for weeks.
