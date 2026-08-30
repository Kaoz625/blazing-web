# blazing-web handoff — 2026-08-30

Working on: poster/trailer parity, nav+section parity, and per-profile login art.
Last action: pushed bca0bc8 — login art now reads BOTH progress stores.
Next step: `cd /Users/markususche/Desktop/blazing-web && node profileart.smoke.mjs`
Key files: app.js, profile.js, index.html, styles.css, *.smoke.mjs (15 files)
Blockers: none in this repo. Two things need Markus, listed at the bottom.

## What shipped this session

| commit | what |
|---|---|
| 88c0de6 | Continue Watching never rendered for anyone; search posters never played |
| 6beb016 | FLT-10 — nav holds on all 15 tabs, three content gaps closed |
| dca8a5e | Login screen shows each profile's own last-watched art |
| bca0bc8 | That art reads BOTH progress stores, not just the fleet |

## The four defects behind "embry continue watching all the posters"

1. **The row never existed, for anybody.** `loadContinueWatching()` returns at
   its first line unless `localStorage.profileId` is set, and **profile.js never
   writes that key** — the only two writers are boot()'s legacy `#profile-picker`
   dialog, which the modern gate never opens. A new `blazing-profile-selected`
   listener takes the id off the event and persists it.
2. It never called `claimHeroRow()` — the one card-building path in app.js that
   skipped it, so its posters could not expand or play a trailer.
3. The resume bar never drew: `safeMeta()` is an allow list and `progress` is
   not on it, so `m.progress` was always undefined.
4. Search results played nothing: `attachHoverTrailer` refused anything outside
   `.row-hero`. It now admits `.search-results` too.

**Side effect worth knowing:** `#emby-results`, `#discover-results`,
`#games-results`, `#requests-results` and `#edu-results` all carry
`class="search-results"`, so five more grids gained hover previews for free on
any card built by `buildCard()`.

## Two testing traps, both cost real time — read before writing a smoke file

- **A Locator is not a valid `waitForFunction` argument.** It serialises to `{}`,
  the predicate throws on its first line, and the wait "finishes" in about a
  millisecond against an element the pointer never reached. Use
  `await locator.elementHandle()`.
- **`locator.hover()` fails its actionability check under the sticky top bar**,
  and a `.catch(() => {})` swallows it silently. Scroll the element into view,
  read its `boundingBox()`, and drive `page.mouse.move()` to its centre.
- (Still true from before: poll on a timer, `polling: 100`, never on `raf` —
  headless Chromium does not paint while the test sleeps.)

## Running the suite

15 loose `*.smoke.mjs`, no package.json. **One at a time, with a ~2s pause** —
several bind fixed ports and back-to-back runs redden the next file. Under heavy
CPU load (an Xcode build in parallel) `watch-party.smoke.mjs` can exit non-zero
with zero FAIL lines; it is timing, re-run it on a quiet machine.

```
cd /Users/markususche/Desktop/blazing-web
for f in *.smoke.mjs; do node "$f"; sleep 2; done
```

## Needs Markus

- **DEP-8**: none of this is live. Cloudflare Pages is NOT built from git here —
  committing blazing-web never ships it. The product is one domain built from
  blazing-site; deploying blazing-web alone never touches
  blazingstream.lyreosai.com/app/.
- **Two Apple TV codebases.** Recommendation: ship `blazing-tvos`, archive
  `firetv/apple`. blazing-tvos is older, 3x the code, and has PIN gate, Watch
  Party, Top Shelf, Search, Live TV and a real test target that firetv/apple has
  none of. Archiving a repo is not reversible, so it is waiting on a yes.

---

## TV packaging lane — 2026-08-30 12:37

Working on: rebuilding the stale Samsung `.wgt` and LG `.ipk`.
Last action: pushed `5c97791` — build-tvs.sh no longer stages `.claude/` or `.omc/`.
Next step: nothing blocking. To rebuild: `cd /Users/markususche/Desktop/blazing-web && ./build-tvs.sh`
Key files: `build-tvs.sh`, `dist/` (gitignored — packages are never committed).
Blockers: none.

Both packages were Aug 29 07:42 and contained none of today's five commits.
Rebuilt; both are now signed, 0.27 MiB, and `index.html`/`profile.js`/`app.js`
inside them are byte-identical md5 to the working tree.

**The thing worth remembering:** every TV package this repo ever shipped
contained `.claude/handoff.md` and `.omc/` — this file, on a television, and in
a public deploy. `build-tvs.sh` stages with an rsync exclude list and every
entry on it was a name you can see in `ls`, so the dotdirs walked straight past
it. Same bug the script's own header says it fixed on 27 Aug, one layer down.
No credential was in any of it (scanned: long quoted strings, `sk-`/`ghp_`/
`AKIA`/`xox`/`AIza`, PEM headers, key/secret/token/password assignments — zero
hits), so it was disclosure of internal notes, not a leak. Staged file count
went 43 -> 24.

**Unchecked, and outside this repo's script:** build-tvs.sh's own comment says
to keep its exclude list in step with what Cloudflare Pages is given. If Pages
is fed the repo root the same way, the live site is serving this file too.
Worth one look by whoever owns the Pages config.
