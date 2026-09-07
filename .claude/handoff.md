Working on: Markus's nine-part failure report (6 Sep 2026 night). Four of the nine were ONE bug.
Last action: fixed the restore so it goes through profile.js's selectProfile(), which is the only
  thing that tells every other module who is watching. 7 suites re-run sequentially, all exit 0.
Next step: verify the fix on the live site, then diagnose the Live TV / YouTube black screens.
  cd ~/Desktop/blazing-web && node scripts/run-smokes.mjs
Key files: profile.js (restoreRememberedProfile + applyProfileList's deferred call + clearActiveProfile),
  profile-restore.smoke.mjs (new, 19 checks), scripts/profile-fixture.mjs (selectProfile now tolerant)
Blockers: none.

## THE BUG, and why it produced four unrelated-looking symptoms

Earlier today I gave app.js its own restoreProfileSession(). It set app.js's own state.profileId
and told NOBODY. Measured on blazingstream.lyreosai.com/app/ as a returning adult viewer:

    rows drawn                                      22
    cards drawn                                   2263
    BlazingStreamPreferences.current().profileId  null
    BlazingStreamPreferences.query()                ""
    localStorage.profileId                        null
    the profile gate                              STILL OPEN, on top of content

A working home screen with nothing behind it knowing who was watching. Every module learns the
viewer from ONE event, 'blazing-profile-selected', and ONLY profile.js's selectProfile() sends it.
An assignment is not a selection. That single omission caused, all at once:

  - "no streams loaded" / "No compatible stream available." — resolveStreams() throws
    'Choose a profile first.' when preferences.profileId !== state.profileId. The addon was fine:
    Spider-Man: Brand New Day (tt22084616) answers with 229 streams in 1.96s.
  - "you cant click to toggle the audio" — stream-preferences.js mounts those selects and had no
    viewer to mount them for, so they were never drawn.
  - "the books search didn't populate anything" — mediaRequest() needs profile.js's
    state.activeProfile and state.credentials, so it threw 403 before sending a request.
  - the gate sitting open over a drawn home screen.

THE FIX: profile.js::restoreRememberedProfile(), called from applyProfileList() on a timeout.
The timeout is load-bearing — connectProfiles() holds state.busy across its whole body and
selectProfile() begins `if (state.busy ...) return;`, so a direct call would return silently and
the fix would read as shipped and be dead.

The SERVER's profile record decides, never the remembered copy: a profile that has since gained a
PIN, been disabled, or been deleted is refused. clearActiveProfile() now also drops the remembered
session, so "choose again" outlasts a reload.

## WHAT THE RE-RUN TAUGHT — 4 suites failed and 3 of them were RIGHT to

livetv, stream-controls, youtube and profile-flow all broke on the same stale expectation: they
clicked a profile button that no longer exists, because the gate now closes itself. That is the
fix working. Fixed centrally in scripts/profile-fixture.mjs (poll for EITHER the button or a
closed gate) and locally in the three suites with their own pickers. edu-play and episode-manga
were CDP timeouts at load average 550+, not code — both pass alone.

## MEASURED, NOT ASSUMED — the scraper is NOT down

Markus suspected the fetcher was down. It is not:

    tt22084616  Spider-Man: Brand New Day   229 streams   1.96s
    tt34564059  The Runner                  312 streams   0.54s
    Baddies USA Chapter Two S01E01           10 streams  10.4s
    Baddies (2026) S01E01                    19 streams  14.4s
    Baddies Gone Wild / Baddies East         16 streams each

REAL GAP: Baddies USA (tt39031930) S01E01 returns ZERO. Urban series coverage is real but thin
(10-19 vs 229 for a big film), and those queries take 10-15s — which the old 20s web timeout was
clipping. STREAM_SEARCH_TIMEOUT is 30s now.

NOTE THAT IS NOT A BUG: Markus's own profile has hasPin=true, so HIS browser still asks every
load. That is what a PIN is for. Golden (hasPin=false) restores instantly. If he wants the web to
remember him, the PIN comes off his profile — his call, do not remove it for him.

STILL OPEN: Live TV and YouTube both render a black screen for him. Backend and the /fleet proxy
are both healthy for both (/fleet/live/channels -> 200 with 41,341 channels, /fleet/youtube/home
-> 200 with shelves), livetv.js and youtube.js are both deployed and 200, sw is v30, and neither
module's mount() needs a profile. Not yet diagnosed — needs a browser measurement on the live site.

STILL MISSING from DESIGN.md's eleven: Settings (a real build) and Adult (needs a gate first).
