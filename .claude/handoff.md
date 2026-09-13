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
