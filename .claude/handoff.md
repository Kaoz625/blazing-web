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
