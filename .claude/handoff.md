# blazing-web handoff — 11 Sep 2026, ~00:20

Working on: BLZ-0016. Bring the web app onto DESIGN-V2 §2.6, the focus law the
Roku already follows, and ship it. Then two things found on the way.

## Shipped and pushed

| commit | what |
|---|---|
| `62dd800` | locker.js — kid-gate parity. Web gated on `isKids` alone; Roku gates on not-kids AND cap-reaches-mature. A Teen non-kids profile was refused on the TV and shown un-rated personal uploads in the browser. Now uses the same predicate as `media-library.js:8-9` / `books.js:89-90`. |
| `ae32d3c` | styles.css — the focus law. Three-tier ramp (1.00 / 0.65 / 0.45), 0.93 scale, 250ms outCubic, 6px accent bar replacing the forbidden 2px ring. 103 font sizes → 5 tokens, 17 radii → 5, 14 stray greys → the palette. |
| `d35a1ec` | app.js — clicking your own profile could blank the whole app. See below. |
| `5013584` | upscale.smoke.mjs case 11 was racing itself — waited for any message, but "Finding a direct link…" IS the spinner's message, so it sampled mid-flight then asserted the spinner had stopped. |
| `2e8999e` | styles.css — the YouTube rows are a SECOND card type (16:9, built by youtube.js, not buildCard) and the first pass missed them. They kept the forbidden 2px ring and had no focus law. Now identical to `.card`. |

## DEPLOYED — and a push is only half of it

    ~/.claude-team/bin/deploy-web.sh

`git push` updates GitHub Pages ONLY. `blazingstream.lyreosai.com/app/` — the
URL Markus actually opens — is a separate Cloudflare Pages copy that must be
deployed by hand. The repo README records this happening before, in August,
with two finished fixes that never reached the living room. It had happened
again tonight; caught by comparing bytes, not commits.

Two gotchas the README does not carry:

1. It needs a token in a non-interactive shell, or wrangler aborts:
   `set -a; . ~/.credentials/api-keys.env; set +a; export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_PAGES_TOKEN"`
2. **Its verification compares `app.js` only.** A CSS-only commit prints
   "blazingstream is current" having proved nothing. Check the changed file
   yourself, cache-busted.

All three md5s now agree: `d98ad282171f98e3c09a7a7125806f84`.

The YouTube focus law measured in a real browser against the shipped
stylesheet — focused 1.00 / scale 1.00, sibling 0.65 / 0.93, cold 0.45 / 0.93,
6px bar on the focused tile only, nothing dimmed at rest.

## The blank-screen bug (d35a1ec) — read this before touching app.js

`data-view` is not app.js's attribute alone. profile.js sets it on its OWN
overlay (`ui.layer.dataset.view = view`, profile.js:1156, on the
`<section class="bp-layer">` at profile.js:2736) purely for CSS. app.js bound
navigation to every `[data-view]`, so a click on the profile overlay ran
`showRoute('profiles')` — not a route — and showRoute hides every view it does
not recognise. Whole app blank, nothing in the console.

`updateNavigation()` had the same selector and toggled `.active` on that
section — and `.bp-layer.active` is profile.js's own "gate is showing" class.

Intermittent because `$$` runs once at load: the overlay is only bound if
profile.js built it first. A script-order race.

Both are now `button[data-view]`. Every real destination is a `<button>`; the
only non-button holder anywhere is that overlay.

## STILL OPEN — one more cause in stream-controls.smoke.mjs

The fix nearly doubled the pass rate but did not clear it. Interleaved A/B,
12 pairs, chromium harness matching CI:

    with the fix     9 PASS / 3 FAIL
    without it       5 PASS / 7 FAIL

Next step — catch a failing run with the fix in and read the DOM state:

    SC=<scratch>/cirepro
    cd "$SC" && /usr/local/bin/node stream-controls.smoke.mjs

The scratch copy already has the CI browser forced and a `[PROBE] STATE` dump
in `openTitle()`. Rebuild it with:

    git archive HEAD | tar -x -C "$SC"
    ln -s /Users/markususche/Desktop/blazing-web/node_modules "$SC/node_modules"
    # comet.mjs:130 `if (true) {`, and the inner darwin throw `if (false) {`

The failing state to look for: `#home-view` hidden with cards present but 0×0.

## Two traps that cost hours tonight

1. **CI runs chromium, this machine runs Comet** (`comet.mjs:130`). A suite can
   pass every time here and fail every time there. That is not flakiness.
2. **These harnesses are load-sensitive, so small samples lie.** I drew opposite
   conclusions from two batches of three. Interleave A and B pair by pair.

Also: `npm test` spawns a Comet per suite and they accumulate until the box
stalls. Run serially with a per-suite cap and reap between.

## Not mine, and on the record

`stream-controls.smoke.mjs` was failing in CI *before* this work. 8 runs a side:
HEAD 5 PASS/3 FAIL, `4394068` 3 PASS/5 FAIL. It fails MORE without the change.
An earlier single-run conclusion that styles.css caused it was a flake and is
withdrawn.

Key files: styles.css (`:root`, the `.card` focus block), locker.js
(`profileAllowed`), app.js (the `button[data-view]` binding at the foot of the
file, and `updateNavigation`).

Blockers: none. Both production URLs are current and verified.

The `pages` gate went green on `5013584` and again on `2e8999e`. The two fixes
that got it there were a real app bug and a real test race, not retries.
