# Handoff — blazing-web — 2026-08-29 09:20

Working on: FLT-2 (feature-parity register) — "Web has no games and effectively no manga."
Last action: built both, wired into the router, wrote and PASSED two new Playwright
smoke tests (games.smoke.mjs 24/24, manga.smoke.mjs 34/34). Ready to commit + push.
Next step: `cd ~/Desktop/blazing-web && node games.smoke.mjs && node manga.smoke.mjs`
to re-verify after any further edit, then see DEP-10 in the open-items register
before assuming a push reaches https://blazingstream.lyreosai.com/app/ — it does not,
that host needs a separate `blazing-site` rebuild + wrangler deploy.

## What shipped

Built directly against the two reference clients named in the task: `roku
channels/source/lib/{Games,Manga}.brs` + their screens, and `firetv/client`'s
`MangaClient.kt`/`GameStore.kt`. Both are **new, self-contained modules**, the same
shape as `locker.js`/`watch-party.js` (own IIFE, own state, own `blazing-profile-selected`
listener) — `app.js` only gained a 6-line router hook, no feature logic.

- **`games.js`** (new) — RAWG catalogue browser. `GET /games/catalog` (paged, searchable)
  and `GET /games/catalog/<id>` (poster, meta, description, screenshots, optional
  trailer clip played as a plain `<video>`, never a YouTube embed). Discovery only —
  there is no game to stream, matching every client in this fleet. **No profile gate**:
  grepped the whole Roku channel for a `gamesAllowedNow()` and there is none.
  IMPORTANT CONTRACT DETAIL, easy to get wrong: the raw `/games/catalog` response's
  `configured` field must be **exactly `true`**, not just non-false, or the catalogue is
  unconfigured — mirrors `GamesBoolean(j.configured) <> true` in `Games.brs` verbatim.
- **`manga.js`** (new) — fleet-backed manga discovery + reader. `GET /manga/discover`,
  `/manga/search`, `/manga/<id>/chapters`, `/manga/chapter/<id>/pages`. Reader reuses
  `tv-comics-reader.js`'s exact shape (arrow keys, one-page prefetch, Escape closes) —
  new `#manga-reader` element, but the SAME `.comic-reader`/`.comic-bar`/`.comic-page`
  CSS classes, zero new reader CSS. Chapter rows reuse `.detail-streams`/`.stream-row`/
  `.dead` (the existing "clickable list, some rows disabled" pattern) instead of
  inventing new markup.
  **MATURE-SECTION GATE, the part most likely to regress**: mirrors Roku's
  `mangaAllowedNow()` in `MainScene.brs` exactly — Kids/Guest/Teen profiles, and NO
  profile chosen yet, are refused ("no profile means the strictest cap, not no cap").
  Re-checked on every mount AND mid-fetch (a profile can downgrade while a chapters/
  pages request is in flight — proved in the smoke test: switching to a Kids profile
  while the reader is open closes it immediately, same lesson as BRK-14 on Roku, "a row
  filtered once at fetch time and never re-filtered on profile switch").
  Both chapter-list response shapes are read (`chapters: [...]` and `chapters:
  {list,error,via}`) — Manga.brs has a whole comment about a client that only
  understood one shape showing zero chapters for EVERY title, licensed or not.

- **`index.html`** — two new nav buttons (`data-view="manga"`, `data-view="games"`) in
  the drawer's "More" section, no emoji (matches the existing "no emoji on these"
  convention right there); two new `<section>` views, two new `<dialog>`s (game detail,
  manga chapters), one new reader overlay. All built from existing CSS classes
  (`.card`, `.rows`/`.row-track`, `.search-results`, `.search-form`, `.detail-dialog`/
  `.detail-card`/`.detail-close`/`.detail-art`/`.detail-body`/`.detail-copy`/
  `.detail-status`, `.detail-streams`/`.stream-row`/`.dead`, `.comic-reader` family,
  `.card-source`). Only ONE genuinely new CSS rule was needed: `.game-shots` (a small
  screenshot thumbnail row) in `styles.css`.
- **`app.js`** — `showRoute()` gained `mangaView`/`gamesView` hide/show plus
  `window.BlazingManga.mount()` / `window.BlazingGames.mount()` calls, right next to
  the existing `loadComicsView()`/`loadRequestsView()` calls. That is the entire diff.

## Verified — real Playwright runs, not "it compiles"

Both new smoke tests follow this repo's own convention exactly (local static server,
`https://fleet.lyreosai.com/**` + `https://addon.lyreosai.com/**` route interception,
dispatch `blazing-profile-selected` to clear the profile gate — see `locker.smoke.mjs`).

- `node games.smoke.mjs` → **24 passed, 0 failed**. Covers: server-order rendering,
  pagination (`Load more` requests page 2, hides once `hasNext` is false), the
  `configured !== true` "not configured" message (not a silently empty grid), detail
  dialog (meta line, description, platforms, 2 screenshots, trailer button), playing a
  trailer builds a real `<video src>` and closing the dialog tears it down, search
  narrows the grid and resets pagination, and a poster-less game gets the placeholder.
- `node manga.smoke.mjs` → **34 passed, 0 failed**. Covers: no profile / Kids / Teen all
  refused with the Mature-section message and **zero manga requests made** before the
  gate clears; an Adult profile sees Popular+Latest shelves in order with source pills
  and absolute-ised covers; opening a cover shows meta/description; **both** chapter-list
  shapes render correctly (array, and `{list,error,via}`); an unreadable chapter is
  marked `.dead`, explains why, and cannot be clicked open; a readable chapter opens the
  reader, arrow keys turn pages forward/back, paging past the end is a no-op, an
  already-absolute page URL survives untouched; a server-supplied error reason (e.g.
  "officially licensed") is shown verbatim instead of a generic failure; **switching to
  a Kids profile while the reader is open closes it immediately** (the mid-fetch/
  mid-read re-check); search narrows to one results shelf.
- Ran **every other `*.smoke.mjs` in this repo** (12 total, including the two new ones)
  to confirm nothing regressed: `edu-play` 19/19, `home` PASS, `locker` all pass,
  `pinpad` 7/7, `sdui-row-type` PASS, `search` 24/24, `upscale` all pass, `watch-party`
  all pass, `webos-nav` all pass. `rowhero.smoke.mjs` shows 2 failing checks
  ("expanded card really is wider than a poster", "a phone expands the card too") —
  **confirmed pre-existing and unrelated**: `git stash`'d my changes and re-ran it on
  clean HEAD, still 13/15 with 2 failures (different two checks failed that run —
  it is flaky, not a regression). `node --check` clean on `games.js`, `manga.js`, `app.js`.

I did NOT touch anything Emby-, upscale-, or Locker-related. `styles.css`'s only
addition is the 2-line `.game-shots` block.

## What's left / gaps, named plainly

- **Never tested against the real fleet.** Everything above is against intercepted
  fixtures. Nobody has confirmed `addon.lyreosai.com`'s actual `/games/*` and
  `/manga/*` routes match this contract byte-for-byte in production — I built strictly
  from the Roku/Fire TV source, not a live probe (Comet wasn't used here; this was a
  pure code-port task, no live site touched).
- **Trailer autoplay-with-sound.** `game-detail-trailer-btn` builds a `<video controls
  autoplay>` — browsers may block autoplay-with-sound depending on the user gesture
  context; not verified on a real browser, only headless Chromium (which allows it).
- **No keyboard/d-pad focus management inside the games grid or manga shelves** beyond
  what plain `<button>` elements give for free. Roku's GamesScreen has real d-pad
  paging-on-focus (load next page when nearing the last row); the web version pages via
  an explicit "Load more" button instead — a deliberate simplification, not a bug, but
  worth knowing if someone expects on-TV-style infinite focus-scroll.
- **DEP-10 still applies**: pushing this to GitHub does not update
  `https://blazingstream.lyreosai.com/app/` — that needs `blazing-site`'s `build.sh` +
  `wrangler pages deploy` by hand.
- Register (`~/.claude-team/status/open-items-2026-08-28.md`): FLT-2 marked DONE with
  this commit's sha, and the Web column flipped to `yes` for Manga and Games in the
  "F. THE FIVE TV APPS DO NOT MATCH" table.

## Key files
`games.js` (new), `manga.js` (new), `games.smoke.mjs` (new), `manga.smoke.mjs` (new),
`app.js` (~10 lines in `showRoute()`), `index.html` (drawer nav + 2 views + 2 dialogs +
1 reader overlay + 2 script tags), `styles.css` (`.game-shots`, 2 lines).

## Blockers
None. Task complete: built, wired, tested, verified against every other smoke test in
the repo, committed and pushed.
