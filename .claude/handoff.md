# blazing-web handoff

Working on: the smoke suite. Five red or silently-vacuous checks across four
files — every one of them the TEST being wrong, not the app.
Last action: `9b3794a` and `17650aa`, both pushed. origin/main 0 ahead.
Next step: `cd ~/Desktop/blazing-web && for f in *.smoke.mjs; do echo "== $f"; node "$f" || echo FAILED; sleep 2; done`
Key files: `rowhero.smoke.mjs`, `pinpad.smoke.mjs`, `search.smoke.mjs`,
`manga.smoke.mjs`, `games.smoke.mjs`. NO app file is changed by either commit.
Blockers: none.

## There is no `npm test` here

No `package.json` in this repo. The suite is 12 loose `*.smoke.mjs` files, each
run with `node <file>`, each starting its own simulator on its own fixed port.
Run them ONE AT A TIME with a small pause: two files at once collide on a port,
and a file that exits without releasing its port can redden the NEXT one. That
is what a single stray `home.smoke.mjs rc=1` in a back-to-back sweep was —
`home.smoke.mjs` passes 8 times out of 8 on its own.

## `9b3794a` — three files red about themselves

**pinpad + search: stale against a deliberate product change.** `boot()` in
`profile.js` no longer auto-registers a device. With no stored credentials it
draws the welcome screen and waits for a person (`profile.js:1181`). Both files
were written for the old auto-register and never got past that screen. A prior
handoff had recorded this as "a separate, real, pre-existing gap" in the
product. It was not. Both now seed the device identity into `localStorage`
under the key `profile.js:6` reads, in an init script that runs before the
first navigation — which is what a returning viewer actually has.

pinpad also gained the OTHER branch, because a seeded test can no longer see
it: a fresh context must show the welcome screen and must NOT call
`/agent/register`. The rule the seed depends on is now tested, not assumed.

**rowhero: a flaky wait, about 1 run in 3.**

    FAIL  a phone expands the card too, not just a desktop  (118px -> 118px)

118px is the RESTING width, so it reads as "the hero expand is switched off on
phones" — the exact bug the check exists for. It is not. A width trace every
150ms after the pointer lands:

    H118px H118px H118px H118px H280px H280px H280px H280px

Hovered (H) at the resting width for ~600ms, then a jump straight to the final
280px with no in-between values. Headless Chromium was not painting: a CSS
transition only advances on a frame, and while the test sits in a
`waitForTimeout` nothing asks for one, so the transition stays at 0% and snaps
to 100% when a frame finally arrives. `waitForTimeout(700)` was a coin toss
against that stall.

`hoverHot()` now waits for the THING: hover, confirm the browser agrees the
card is `:hover`, then wait for the computed width to leave its resting value
AND hold still for two polls. Both halves are needed — "not resting any more"
alone caught a card in flight and measured 176px of a 158→316px grow. Both
waits use `polling: 100`, NOT the default `raf`: no frames is the very
condition being waited out, so an rAF poll would sleep exactly as long as the
thing it watches for.

## `17650aa` — a wait its own placeholder satisfied, and a check that could not tell

    FAIL  the server's own reason is shown, not a generic failure — Loading chapters…

`#manga-chapters-status` is written twice per open: "Loading chapters…" when
the request goes out (`manga.js:308`), the answer when it lands
(`manga.js:327`). The test waited for `textContent.length > 0`, which the
PLACEHOLDER already satisfies, so it returned at once. Three more waits had the
same shape (`#manga-status` ×2, `#games-status`). All four now call
`settledStatus()`, which refuses a line that is empty, starts Loading/Searching,
or ends in an ellipsis.

The check itself was worse. It asked `status.includes('licensed')` — and the
app's own fallback sentence is "No English chapters are available. This often
means the title is officially **licensed** and removed from this source." So it
passed whether the server's reason survived or was thrown away, which is the
one thing it exists to tell apart. Proven by swallowing `why` in `manga.js`:
the check stayed GREEN. It now names a phrase only the fixture's reason carries
and refuses the fallback outright.

## Negative controls actually run, and restored

- `<=640px` rule pinned back to 118px → phone check reddens (118px -> 118px).
- desktop expand switched off → three checks redden (158px wide).
- `why` swallowed in `manga.js` → the reason check reddens on the fallback text.

`styles.css` and `manga.js` were each restored and verified identical to HEAD
(`git diff --stat` empty) before the final clean runs.

## State of the suite

12 files, all green run individually. rowhero 15/15 six times running; manga
28/28 and games all-green three times each; home 8/8 runs; pinpad 9/9;
search 24/24.

## Still open on this repo (not started here)

- Nothing in `blazing-web` alone reaches the live product. The site is built
  from `blazing-site` and Cloudflare Pages is NOT built from git — committing
  here ships nothing. See the memory note `the-product-is-one-domain-built-from-blazing-site`.
