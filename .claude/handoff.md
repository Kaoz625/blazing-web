# blazing-web — handoff, 25 Sep 2026 12:15 (claude-polish-slop, relay BLZ-0045)

Working on: the AI-slop pass, on branch `polish-slop` (NOT main; main is a public deploy and needs Markus's OK).
Last action: fixes 1-4 committed and pushed; full suite green (32 + 18 rerun = 50/50).
Next step: fixes 5-10 on the same branch. `cd /Users/markususche/Desktop/blazing-web && git checkout polish-slop && git pull`
Key files: styles.css, dpad.js, profile.js, watch-party.js
Blockers: none. The coordinator cut scope to fixes 1-4 because usage ran near its limit.

| commit | fix |
|---|---|
| 695f307 | 1. banned grey rgba(28,28,31) -> var(--surface) + var(--border); other cold greys too |
| 470ef2f | 2. Library / games grid focused card wins at (0,5,0): 1.00 / 1.00 |
| 0605caf | 3. deleted the 1.08 "magnetic focus engine" |
| c0800c1 | 4. dpad.js input guard: caret, select values, Escape/Back leaves a control |

Still to do (fixes 5-10): emoji headings + watch-party SVG icons; the 7 repeated
eyebrows and the two plumbing subtitles; Admin panels / Approve Device / kids gate
(use grownUp() at profile.js:170); developer copy (app.js ~5879, ~5926, youtube.js ~663,
settings.js ~493); quality badges #0066ee / #1a9e4a / #555 (styles.css ~2004);
one heading token + define --fs-meta + profile gate CSS tokens.

Found, not fixed (out of scope for 1-4): search-view ground is a stray blue #0a1620
(styles.css ~1180); edu card/badge use a second green rgba(40,200,100) / rgba(30,160,80);
.card-previewing scale(1.04) and .roadmap-card scale(1.01) pass the 1.00 ceiling; the
Library's OTHER section grid stays at 1.00 while one grid is engaged (dim is per grid).

Test trap: `samsunt tv/test/run-smokes.mjs` reaps every NEW blazing-smoke-comet- Comet
it sees during its suite, so a blazing-web run alongside it loses browsers
("Target page, context or browser has been closed"). Run one repo at a time.

---

# blazing-web — handoff, 13 Sep 2026 14:35

Working on: closing the two live access-control holes from the audit, and the
two-day YouTube "flaky test".

Last action: pushed 3 commits. Repo is clean, ahead=0.

| repo | sha | what |
|---|---|---|
| blazing-web | 3526c50 | a kids profile cannot approve a device |
| blazing-web | 94fde88 | YouTube 429 waits for the window |
| blazing-web | (latest) | parity recheck report |
| blazing-fleet | 82abc63 | /pair/approve refuses a kid, server side |

## What landed

1. **DEFECT 2 closed.** `maybeShowApprover()` asked only "is SOME profile
   active", and `selectProfile()` only asks for a PIN if the profile HAS one. A
   kids profile with no PIN was one tap from Approve, and approving puts a
   device on the WHOLE household. Fixed with the existing `grownUp()` helper
   (profile.js:170) so a teen is refused too. Proven red:
   `(f) a kids profile never sees the Approve sheet — {"approveShown":true,...}`
2. **YouTube 429.** resolve() reads Retry-After and waits up to 3s instead of
   retrying 700ms into the same 60-second bucket.
3. **Parity recheck.** docs/parity-recheck-2026-09-13.md — 134 items, 98 OPEN,
   28 PARTIAL, 8 CLOSED, 0 overturned.

## Next step

```bash
cd /Users/markususche/Desktop/blazing-web && node gate.smoke.mjs
```

Then pick up the trivial parity items from the report. M4 is the cheapest real
defect (firetv DetailActivity.kt:879-881).

## Key files
- profile.js:2246 (the guard), :2369 (profileId on the wire)
- gate.smoke.mjs (f) — the kids/teen cases
- youtube.js resolve()
- docs/parity-recheck-2026-09-13.md

## Blockers
- **The addon is NOT deployed.** blazing f6d89deb adds Retry-After to
  Access-Control-Expose-Headers. Until Coolify redeploys services/addon, the
  browser cannot read the header at all and the YouTube fix runs at half effect.
- **profile-flow.smoke.mjs failed once inside the 47-harness suite run.** It is
  green alone, three runs in a row (122/0). The runner's per-test detail was
  truncated so the reason is NOT known. Watch it on the next full run.

## Still open from the audit, NOT verified by me
- DEFECT 3 — Roku deep link may walk over the profile gate. I started reading
  `roku channels/components/MainScene.brs` onLaunchArgs (~line 305-760). The
  `action=details` branch at :679 calls `openDetails()` directly and its own
  comment says "No PIN bypass is offered here on purpose" — so it may already be
  handled. NOT CONFIRMED either way.
- DEFECT 4 — latent; firetv DetailActivity.kt:191 has no gate at its door.
- DEFECT 5 — structural; no server-side rating gate on the addon video routes.

---
## 10 Oct 2026 — claude-main-tvos-web, BLZ-0113: Live TV in the binged layout (branch livetv-binged ONLY)

Working on: web Live TV rebuilt to binged's layout (DESIGN-V2 §2.14): rail, LOGO-card rows, Guide, Sports, Teams, Favorites, Search, live player overlay.
Last action: pushed branch livetv-binged. NOT merged to main — main deploys GitHub Pages; Markus decides the merge.
Next step: Markus approves -> merge livetv-binged into main. Before that: `node --test *.test.mjs` and `node livetv.smoke.mjs` (73/73) on the branch.
Key files: livetv.js (rewritten; pure rules in window.BlazingLiveTv.rules), index.html (#livetv-view = rail + pane), styles.css (.lt-* block), sw.js (v51), livetv-board.test.mjs (new), livetv.smoke.mjs (rewritten).
Keys: livetv.js owns arrows/OK/Back inside #livetv-view and consumes what it handles; UP from the top row is left to dpad.js. Back = Escape/Back/GoBack/461/10009. Hold OK (600 ms) or Play/Pause = favourite. While #player shows, Live TV leaves every key to the player.
Fallbacks: /live/rows 404 -> /live/groups + /live/channels + /live/now; /live/sports 404 -> from Games Today; View All 404 -> /live/channels?group=. 404 only.
Blockers: (1) feed LEFT/RIGHT cannot work on the web: /live/ticket/:id always takes the first candidate — needs ?feed=N plus a feed count in the ticket answer. (2) The live overlay and channel up/down run only on the HTML5 #player; the native shells (Apple TV avplayer, Android bridge, Tizen avplay, BlazeOS) hand off and never show #player.
- 10 Oct, later: blocker (1) above is CLEARED. blazing-fleet 6d0c503 added /live/ticket/:id?feed=N -> { feed, feeds, label }; the web player's LEFT/RIGHT now step the feed ((feed ± 1 + feeds) % feeds), mint a new ticket, swap the source and show "Feed 2/5 · label" in the overlay. Unit 159/159, livetv.smoke 85/85. Still branch livetv-binged only. sw.js stays v51 (unreleased, so no second bump).

---

## 2026-10-13 — In-browser retro emulator (web-emu agent, Claude Opus 4.8)

Working on: play a retro ROM in the browser (phone/PC/TV), no install.
Last action: committed + pushed branch `blz-web-emulator` (commit a57fc8c). NOT
deployed, NOT merged (pages.yml deploys only on push to main).
Next step: run the suite — `cd blazing-web && npm install && node scripts/run-smokes.mjs emulator`
  (playwright is NOT installed here; the Comet harness was not run this session).

Key files:
- emulator.js (new) — window.BlazingEmulator.open/close/coreFor; EmulatorJS 4.2.3
  in a srcdoc iframe; cores from cdn.emulatorjs.org, lazy, only on launch.
- games.js — "Play in browser" button in openDialog (~1416), resolveForPlay (~1513);
  resolves via the existing /games/resolve, hands the link to the player.
- index.html — #emulator-overlay markup + deferred <script>.
- styles.css — .emulator-* overlay (house full-screen pattern, live tokens).
- sw.js — emulator.js in SHELL, CACHE v46 -> v47.
- emulator.smoke.mjs (new) + run-smokes floor 43 -> 44.

What I verified: node --check on every touched file; coreFor() mapping proven on
the real emulator.js in Node (all 20 cases pass, incl. retro/zip/disc -> picker).
What I did NOT run: the Comet/Playwright smoke suite (not installed; hub warns of
Comet reaper collisions). emulator.smoke.mjs is written but UNEXECUTED.

Blockers / needs Markus:
- CORS: in-browser play of a CATALOG ROM needs Access-Control-Allow-Origin on the
  add-on's /games/resolve link target (services/addon/lib/game-source-routes.js).
  Local-file play works regardless. Download/Send-to-PS5 unaffected (not fetch).
- Which systems/cores to feature, and DEPLOY approval (branch is undeployed).

---

## 2026-10-14 — BLZ-0120 web emulator, phase 1 done (claude-web-emu-0120, Claude Opus 5.5)

Working on: the in-browser retro emulator, moved onto main as branch `blz-0120-web-emulator`, all 27 EmulatorJS systems, wired to the add-on's play relay. NOT merged, NOT deployed (the coordinator merges and deploys).
Last action: full `npm test` on the final commit, failing suites compared against origin/main, branch pushed.
Next step: coordinator: `cd ~/NYCT/blazing-web && git fetch && git checkout main && git merge --ff-only origin/blz-0120-web-emulator && git push` (pages.yml gates and deploys main only).
Key files: emulator.js (detect/verdict, TOKENS + free-text RULES, BIOS/threads/.pkg refusals, `<url>#/<raw name>`, disc hint), games.js (playButton, isRetroRow, playUrl, headPlay, playFailureText, resolveForPlay), emulator.smoke.mjs (54 checks, hermetic), index.html (#emulator-overlay, #emulator-hint), styles.css (.emulator-*), sw.js (v52), scripts/run-smokes.mjs (floor 48).
Blockers: none for the merge.

Commits on the branch (from origin/main 4de93ea):
- 24b1b1d a57fc8c cherry-picked alone (f45253b and the old base NOT brought).
- 8d7dea3 the 13 Oct handoff section, appended.
- b88ce74 all 27 systems from the REAL catalog text (the old exact-token map matched 0 live rows), refusals, playPath, DESIGN-V2 overlay CSS.
- a2bed02 the add-on relay contract (blazing a25d7b3e): HEAD before the player opens; 413/503/502/504 in plain words; 404 token = one fresh resolve; resolve on every press; raw name fragment (EmulatorJS 4.2.3 never decodes %XX); disc-loading hint.
- d2382eb e057962 cherry-picked per Markus 14 Oct — EMPTY: main already has every line (29cf204 games.js byte-identical + games-hub case 11; 26b2805 case 7's picker press).
- 5df9a6b emulator.smoke hermetic: its first context was POSTing heartbeats to the PRODUCTION fleet with the fixture's fake token.

What cannot play here, by design, with one plain sentence in the UI (button disabled): PSP (needs SharedArrayBuffer = COOP/COEP headers; checked at run time), Sega CD, ColecoVision, 3DO, Famicom Disk System, PC Engine CD, Neo Geo (BIOS a public repo cannot ship), NoPayStation .pkg rows.

Tests (MacBook, headless Comet 154): `node scripts/run-smokes.mjs emulator` 1/1 (54 checks, 3 runs in a row; mutation-tested); `node scripts/run-smokes.mjs games` 2/2 (games-hub 107 checks incl. case 7's picker press and case 11 Usenet). Full `npm test` on 5df9a6b: 38/58 passed in 881.6s (10/10 unit files pass). The SAME run on origin/main 4de93ea right after, same machine: 34/57 passed in 945.5s. 14 suites fail in both; the 6 that failed only on the branch were re-run alone on both trees: edu-play, fleet-heartbeat, youtube-play and manga pass alone on the branch; locker and notice fail alone on main too.

Local test note: on this MacBook (headless Comet 154) several suites flake run to run ("Execution context was destroyed", page.goto ERR_ABORTED, timeouts), on main too; CI (Linux Chromium) is green on main. Measured: emulator.smoke's first context sent LIVE requests to the production fleet (fixed in 5df9a6b by stubbing, as games-hub does). The likely reload mechanism, inferred from the code and not observed directly: prepareProfile's addInitScript rewrites the device key in EVERY frame, so once live fleet answers changed the stored credentials, that rewrite fires a `storage` event and profile.js reloads the page. Suites without a fleet catch-all stub are exposed.
