# Handoff — blazing-web — 2026-08-29 05:10

Working on: "only the first row pops out, all rows should do this, on all devices" (Markus).
Last action: pop-out now fills a synopsis and plays a trailer. 6acf3cc, deployed, verified live.
Next step: `cd ~/Desktop/blazing-web && node locker.smoke.mjs` — then fix it the same way (see DEP-11).

## STATE

| repo | sha | clean | pushed |
|---|---|---|---|
| blazing-web | 6acf3cc | yes | yes |
| blazing-site | b5036ae | yes | yes (dist/ is gitignored; deployed by wrangler) |

## What shipped

- `app.js` — `claimHeroRow()` lost the `heroRowClaimed` single-claim flag, so EVERY
  qualifying row expands, not the first one. The `background` check STAYS: a Live TV
  channel-logo row has no backdrop, so expanding one opens an empty black panel.
- `app.js` — `appendEmbyRow()` now calls `claimHeroRow()`. It never did. On a browser
  still waiting for fleet approval the three Emby shelves are the ONLY rows on screen.
- `styles.css` — expanded card capped at `clamp(240px, 24vw, 316px)`. With every row
  expanding, a card taller than its row would shove the page down on each pointer
  crossing. Measured: 197.5px inside a 282px row, the row below moves 0px.
- `styles.css` — the `<=640px` breakpoint no longer switches the treatment off on
  phones. `min(74vw, 280px)`. Measured at 390x844: 118px -> 280px, row 222.0 -> 222.0.
- `rowhero.smoke.mjs` — new, 9 assertions, all pass. PROVED to catch the bug:
  restoring `heroRowClaimed` takes it from 9/0 to 2/2.
- `home.smoke.mjs` — was failing, and it was NOT the pop-out. Fixed. Closes DEP-9.

## Then: the pop-out was empty (6acf3cc)

A CATALOG META CARRIES ALMOST NOTHING. Over the 300 live metas of
blazing-movies: description 129, imdbRating 39, runtime 0, certification 0,
**trailerUrl 0**. Nothing in this system has ever sent a `trailerUrl` - not the
catalog route, not `/meta/` - so `attachHoverTrailer` AND `startDetailTrailer`
both returned on their `!meta.trailerUrl` guard on every title. The detail
dialog's trailer had never played either.

`/meta/` carries `trailers: [{source: '<11-char YouTube id>'}]`. A bare id.
**A YouTube id cannot go in a `<video>`** - it needs a youtube-nocookie iframe,
muted, and looped via `playlist` or it plays once. `makeTrailerNode()` handles
both shapes. The card fetches `/meta/` on dwell: 550ms text, 1400ms video,
cached, only inside a `.row-hero`, skipped for Emby ids and anything not
`tt<digits>` (156 of 300 qualify).

REDDIT CANNOT BE FETCHED FROM THIS MACHINE. Every route hits "Prove your
humanity" - curl, .json, old.reddit, r.jina.ai, headless and HEADED real Chrome,
and a real logged-in cookie jar. Do not try again; ask Markus to paste it.

## THE TWO THINGS THAT COST THE MOST TIME

**1. A push does not reach the URL Markus uses.** `git push` updates GitHub Pages only.
`https://blazingstream.lyreosai.com/app/` is a SEPARATE Cloudflare Pages copy:

    cd ~/Desktop/blazing-site && ./build.sh
    npx wrangler pages deploy dist --project-name blazingstream --branch main

`build.sh` does `rm -rf dist` first, so check the four installers exist before running
it. Verify by CONTENT, never by status — that host 200s on any path. (DEP-10)

**2. A ROW TEST MUST CHOOSE WHO IS WATCHING.** `ratingAllowed()` defaults `profileCap`
to `'general'` while nobody has chosen a profile, and refuses an UNRATED title under a
kids cap. So a fixture whose metas carry no `contentRating` has every row emptied, every
loader removes its own section, and the page reads "Nothing is available right now."
with NO error thrown. That is the parental gate working exactly as written. Dispatch
`blazing-profile-selected` and remove the `.bp-layer` overlay (it swallows the pointer).

Two more fixture traps: `safeMeta()` runs art through `safeHttpsUrl()`, https ONLY, so a
`data:` URI arrives as `background` undefined and no row can qualify as a hero; and
`loadSDUIRow()` asks for `/catalog/tv/<slug>.json` for EVERY row whatever its real type.

## Key files
app.js (claimHeroRow ~line 228, loadSDUIRow, appendEmbyRow), styles.css (~line 319
`.row-hero`), rowhero.smoke.mjs, home.smoke.mjs

## Blockers
None for the pop-out. Pre-existing and untouched: locker.smoke.mjs, upscale.smoke.mjs
and watch-party.smoke.mjs all time out, and fail identically on a pristine HEAD
worktree — almost certainly the same two causes fixed above. (DEP-11)
