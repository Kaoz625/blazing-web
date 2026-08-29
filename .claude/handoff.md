Working on: BRK-12 rating-gap sweep — Discover screen was showing every title unfiltered.
Last action: `0b9f7a2` (pushed). `openDiscover()` in `app.js` (~line 438) built
`cards` from `embyMetaSafe()` (which already decodes `contentRating`) but never
called `ratingAllowed()` on it — every OTHER row-building path in the file
does. One-line fix, same pattern as `appendEmbyRow`/etc. Verified: `node --check`
clean, ran all 11 `*.smoke.mjs` files, 2 pre-existing failures
(`pinpad.smoke.mjs` 3 failed, `search.smoke.mjs` TimeoutError) confirmed via
`git stash` to reproduce identically on the commit before this change — not
caused by it, not investigated further (out of scope for this task).
Next step: none required for this fix. The pinpad/search test failures are a
separate, real, pre-existing gap worth a look next session — not yet in the
register as their own item.
Key files: `app.js` (`openDiscover`, ~line 407-443).
Blockers: none.

## Earlier: self-service onboarding — "Request Access" and "Enter Invite Code" buttons on the web profile gate.
Last action: 5a571a8 (pushed). profile.js's gate no longer auto-registers a
browser the instant the page loads. A first-time visitor now sees a welcome
screen with two buttons: Request Access (same registration as before, but
behind a real click now) and I Have an Invite Code (POST /devices/join for
instant approval, no admin needed). Either path lands on the profile picker,
which now has an "Add profile" tile (POST /profiles) so a newly-approved
visitor can make their own profile without a TV. The pending-approval screen
also grew an "Enter Invite Code" button next to "I am the owner", so someone
waiting on admin approval isn't stuck if they actually have a code.
Next step: NOT YET DEPLOYED. Git push only updates GitHub Pages (DEP-10) — the
site Markus opens is a separate Cloudflare Pages copy. Run
`~/.claude-team/bin/deploy-web.sh` to ship this, or `--status` to see what's
live vs committed first.
Key files: profile.js (state.approved, showWelcome/showInvite/showCreateProfile/
hideAllScreens, redeemInviteCode, submitCreateProfile, the "+ Add profile" tile
in renderProfileList).
Blockers: none.

## What was verified

Headless Chromium against a local static server (`python3 -m http.server` +
`playwright-pp-cli --browser chromium run-flow`, not Comet — this is our own
static file, not a live site):
- Fresh load with no stored device identity shows the welcome screen, and
  confirms NO device key gets written to localStorage — the silent
  auto-registration this task was meant to remove really is gone.
- "I Have an Invite Code" → invite screen; Back → welcome screen again; both
  transitions confirmed by reading `.hidden` on each section plus the heading
  text, not just "it didn't throw."
- Submitting an empty/whitespace code shows "Enter the invite code first."
  and (confirmed via localStorage) makes NO network call — the guard fires
  before any fetch.

## What was NOT verified — do not assume these work end to end

- **The three real network paths — Request Access, Join with a real code,
  Create Profile — were never exercised.** Doing so would either burn the
  household's shared 20/hour device-registration budget on a test run, or
  (for Join) needed a real invite code, which needs an already-approved
  device to mint one first. The client-side contract for all three was
  cross-checked line-by-line against `firetv/server/server.js` and
  `household.js` (exact status codes: /devices/join → 404 unknown code / 409
  already used / 410 expired / 200 `{ok:true,...}`; POST /profiles → 200
  `{profile:{...}}` on success, 403 if the device isn't approved), but "matches
  the server source" is not the same as "tried against the live fleet."
- **No PIN on profiles created through this new form.** `submitCreateProfile()`
  sends only `{name, isKids}` — a PIN can still be added later on a TV. Not a
  bug, just unbuilt: adding a PIN field here was out of scope for this task.
- Placement: this lives in `blazing-web/profile.js` (the app's existing
  mandatory gate), not on the separate `blazing-site` marketing homepage.
  `blazing-site`'s homepage only ever links to `/app/` — it has no onboarding
  UI of its own and needs none; the gate visitors actually hit is this one.
