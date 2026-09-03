# blazing-web handoff — 2026-09-03

Working on: letter C (device-aware source picking) and letter B (full-bleed
Continue Watching hero) — both landed, plus the row-hero harness that could not
hold a pointer.
Last action: committed on main. **NOT PUSHED — deliberately.**
Next step: nothing runs. Markus approves the public deploy, then:
`cd /Users/markususche/Desktop/blazing-web && git push origin main`
Key files: caps.js (new), caps-hero.smoke.mjs (new), app.js, index.html,
styles.css, sw.js, rowhero.smoke.mjs
Blockers: none technical. One gate: this repo is PUBLIC and GitHub Pages serves
the live site straight off main, so pushing republishes it. That needs Markus.

## WHY THIS IS SITTING UNPUSHED

Not an oversight, and not something for the next profile to "finish" by pushing.
`Kaoz625/blazing-web` is public and Pages builds from main, so `git push` IS the
public deploy. The house rule is that anything reaching an audience is asked
first. The work is committed so nothing can be lost; the push is Markus's call.

## What is in the commit

| what | where |
|---|---|
| C — probe what this browser can really decode, then filter AND rank | `caps.js` (new, `window.BlazingCaps`) |
| C — one ranking for both the list and Play | `app.js` `loadStreams()` + `playSelected()` |
| B — full-bleed Continue Watching band with resume bar and a fleet trailer | `index.html`, `styles.css`, `app.js` |
| the shell can actually serve the new file | `sw.js` — `caps.js` added to SHELL, CACHE v21 → v22 |
| 43-assertion harness for both | `caps-hero.smoke.mjs` (new) |
| a harness that can hold a pointer | `rowhero.smoke.mjs` |

**The trailer is a plain MP4 from our own fleet**, never a YouTube iframe:
`fleet.lyreosai.com/trailer/play/<yt>?muxed=1&c=mp4&h=<n>`. The tier comes from
the probe. `caps-hero.smoke.mjs` asserts there is no iframe anywhere and that
youtube.com is never contacted (0 requests). An iframe cannot run on Roku, Apple
TV, Fire TV, webOS, Tizen or VegaOS.

**The card-hover preview still goes through the addon's `/proxy/yt-resolve`.**
That is deliberate and `rowhero.smoke.mjs` asserts it. Only the new HERO uses the
fleet route. Do not "unify" these.

## The three bug shapes the other device lanes found — all three were already handled

1. **A 4K ceiling must come from DECODE, not screen size.** A real Apple TV 4K
   reports its screen as 1920x1080 (the UI plane, not the output mode). `ceiling()`
   in caps.js takes 2160 from `decodingInfo` at 3840x2160 only; the panel may
   raise 1080→1440 and may never cap a decoder.
2. **Language markers must be delimiter-anchored.** `/ita/` matches "DIGITAL",
   `/rus/` matches "Rust". `marker()` anchors on non-alphanumerics, so it also
   survives `Some_Film_2026_ITA` where `\b` finds nothing (`_` is a word char).
3. **`\b1080\b` never matches "1080p"** — "p" is a word character, so there is no
   boundary. Every row parsed as height 0 and the ceiling measured nothing. The
   patterns carry a trailing `[pi]?` and the harness has a regression test.

## The row-hero harness was failing 2 legs out of 2, and it was NOT the feature

Measured on this machine, 3 Sep 2026, four runs of the file exactly as the last
session left it:

| run | desktop | phone |
|---|---|---|
| suite | FAIL 158px | ok |
| 1 | ok 316px | FAIL 280→118 |
| 2 | FAIL 158px | FAIL 280→118 |
| 3 | ok 316px | FAIL 280→118 |

158px and 118px are the RESTING widths. Two different legs failing on alternate
runs of identical code is a harness fault, not a feature that half works. Three
causes, all fixed:

1. **`card.hover()` cannot be trusted under a sticky bar.** It scrolls with
   `scrollIntoViewIfNeeded`, which stops as soon as the element is technically
   visible — and the top bar is `position: sticky`, so that includes
   "underneath the bar". The hit-test then finds the bar, the actionability
   check fails, and a `.catch(() => {})` swallows it. `hoverHot` now scrolls the
   card to `block: 'center'`, reads `boundingBox()`, and drives
   `page.mouse.move()` to its centre — no actionability check involved. The new
   #home-hero band added 620px above these rows, which turned a rare failure
   into a common one.
2. **Agreeing once is not settled.** The phone leg polled until every card in the
   row had the same width and took the first agreement. Straight after
   `setViewportSize(390)` the row passes THROUGH a state where they all agree at
   280 (the desktop track, not yet re-laid out), so it latched 280 as the resting
   width, then measured the real 118 after the reflow and reported a working
   expand as a card that SHRANK. It now needs the same number three polls
   running, with nothing hovered.
3. **`hoverHot` returned whether the pointer landed and both callers threw it
   away**, so "the pointer never arrived" was reported as "the card did not
   expand". Both legs now assert it, and say which of the two happened.

After the fix: **19 passed, 0 failed, three runs running.**

## Two testing traps, still true, still cost real time

- **A Playwright Locator is not a valid `waitForFunction` argument.** It
  serialises to `{}` and the predicate throws on its first line, so the wait
  "finishes" in a millisecond against an element the pointer never reached. Use
  `await locator.elementHandle()` — or an `ElementHandle` from `page.$()`, which
  is what this file uses.
- **Poll on a timer (`polling: 100`), never on `raf`.** Headless Chromium does
  not paint while the test sleeps, so a CSS transition sits at 0% and then snaps
  to 100%. An rAF poll is asleep for exactly as long as the thing it waits for.

## Run the suite by hand — CI does not

CI (`.github/workflows/`) runs assets, manifests, python, shell and syntax. It
explicitly does NOT run the browser harnesses, and a `*.smoke.mjs` change starts
nothing. Run them ONE AT A TIME with a pause — the 15 loose files bind fixed
ports and a parallel run goes red for no reason:

```
cd /Users/markususche/Desktop/blazing-web
node caps-hero.smoke.mjs && node home.smoke.mjs && node rowhero.smoke.mjs \
  && node navparity.smoke.mjs && node posters.smoke.mjs \
  && python3 .github/checks/assets.py
```

`assets.py` baseline is **0 failure(s), 4 warning(s)** — the 4 are pinned
dpad/games/manga/tv-comics-reader SHELL gaps and are expected.

## Known, not fixed, and not worth blocking on

`buildFilterNote` renders "N of TOTAL sources play on this device" where TOTAL is
`raw.length`. Rows removed by the 1200-entry parse cap, and duplicate releases
removed by `dedupeKey`, are counted in neither N nor the "hidden" breakdown, so
those two numbers need not add up on a very long list. Cosmetic; the filter
itself is correct.
