Working on: Markus's nine-part failure report (6 Sep 2026 night). Four of the nine were ONE bug.
Last action: fixed the restore so it goes through profile.js's selectProfile(), which is the only
  thing that tells every other module who is watching. 7 suites re-run sequentially, all exit 0.
Next step: build the web Settings view, then the Adult gate (Adult must NOT get a nav chip
  until the gate exists). Everything Markus reported on 6 Sep is closed except the Apple TV.
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

## BOTH BLACK SCREENS: SOLVED, and they were two different things

YOUTUBE was never broken. The profile gate's BACKDROP was sitting open over the whole app (see
above), so navigating to any view showed the backdrop, not the view. Fixing the restore fixed it:
measured live, 540 videos across 15 shelves.

LIVE TV was a genuine second bug, and it is fleet-side, not web-side. /live/channels sorts by name,
'#'/'-'/'=' sort before letters, and the providers ship thousands of heading rows — so about 1,600
NON-TUNABLE rows sat in front of the first real channel. Measured, limit=200, healthy=1:

    skip 0     0 real      skip 1600    55 real
    skip 800   0 real      skip 3200   200 real

livetv.js filtered them client-side and drew an empty grid from a request that had SUCCEEDED. A
client-side sweep could not win: 8 pages of 60 is 480 rows. Fixed in blazing-fleet
(live.js isDecorationName, commit 2eab36a) so all five clients get it; total 38,899 -> 35,564.
livetv.js keeps its own sweep + isPlaceholder() as a safety net for an older fleet.

## VERIFIED LIVE after both fixes, blazingstream.lyreosai.com/app/, real approved device

    home                24 rows / 2391 cards, gate closed, header reads "Golden"
    The Runner          138 sources, 2 language selects, no error status
    Live TV             60 cards, "Showing 60 of 35,564 channels", tunes via /fleet/live/play/<ticket>
    YouTube             540 videos, 15 shelves
    search "baddies"    8 hits incl. Baddies USA Chapter Two; opens as an Emby title
    full smoke suite    32 suites, 0 failures, exit 0

## KNOWN AND NOT WORTH CHASING YET

upscale.lyreosai.com sends no access-control-allow-origin, so its status call is CORS-blocked from
the custom domain. app.js already catches it and keeps the normal button, so this is console noise,
not a broken feature. The origin is behind Cloudflare and is not one of mac2's containers.

The books library is PROJECT GUTENBERG — public domain only. "Men Are from Mars, Women Are from
Venus" (1992) is genuinely not in it, so "No matches in this library" is the honest answer, not a
bug. Podcasts returned 8 results for the same query, which proves the request path works.

Baddies USA (tt39031930) returns ZERO streams from the addon while its sister titles return 10-19.
A real, narrow coverage gap — not the scraper being down.

STILL MISSING from DESIGN.md's eleven: Settings (a real build) and Adult (needs a gate first).

---

Working on: BLZ-0019's last open item — blazing-web refused to even TRY playing the two scraped
  sites (MrWorldPremiere, BrokenSilenze), and could not find them either.
Last action: replaced isMwp() with a SOURCE_SITES table, deleted the four dead-end branches,
  wired the addon's search catalogs into runSearch(), plumbed stream request headers to the
  native shells, and taught this client to read the addon's `refused` array. New suite
  site-source.smoke.mjs (10 gates, 36 assertions); MIN_SUITES 29 -> 30; sw.js CACHE v31 -> v32.
Next step: nothing is blocked here. The remaining site-source gaps are in OTHER repos —
  Roku/Fire TV/tvOS/Tizen shells must now READ the `headers` field this file forwards, and
  the Tizen avplay branch still cannot send one (see the note in openPlayer).
  cd ~/Desktop/blazing-web && node site-source.smoke.mjs
Key files: app.js (SOURCE_SITES + sourceSite/sourceBadge/sourceFallbackUrl/revealSourceLink/
  showSourceFallback/describeRefused, isAdultCatalog, addonSearchCatalogs/searchSiteCatalogs,
  streamHeaders + needsForbiddenHeader + playFailureReason, openPlayer),
  site-source.smoke.mjs (new, 10 gates, 36 assertions), scripts/run-smokes.mjs, sw.js
Commit: f4adcb1 (pushed to origin/main).
Blockers: none.

## THE DEAD END, and the second one behind it

app.js held ONE predicate, `isMwp(meta)`, pinned to `^mwp:tv:[1-9]\d*$`, and five call sites read
it. Four of them refused to ask the addon anything:

    openDetail()    detailPlay.hidden = isMwp(meta)     — no Play button at all
    openDetail()    the website link shown immediately, with the status line
                    "Source page only. Open MrWorldPremiere in a web browser to watch."
    loadStreams()   `if (isMwp(meta)) return;`          — the ONE function that asks
                                                          /stream returned before asking
    playSelected()  "This source page has no verified direct stream for this device yet."

So the app could find Baddies USA S2E17, draw its poster, open it — and never once attempt it.

THE SECOND DEAD END, found while fixing the first and measured live 7 Sep 2026:

    GET fleet.lyreosai.com/search/movie?q=baddies&limit=20
        200, 4 rows: tt42418204 tt13124274 tt43669567 tt38605926 — NO mwp row
    GET addon.lyreosai.com/catalog/movie/mwp-search/search=baddies.json
        200, 20 rows: mwp:tv:14995 "Baddies USA Season 2 Episode 17", …

runSearch() asked the FLEET and only the fleet, and the fleet's index does not carry the scrapers'
pages. So these titles were unreachable from this app entirely. Fixing playback alone would have
left a door with nothing behind it.

## WHAT THE BRIEF GOT WRONG, and it matters

1. BrokenSilenze ships as `bs:`, TWO letters — `bs:223006`. The brief predicted `bsz:`. Writing
   the prediction down would have shipped a site with no badge, no "BrokenSilenze source" pill and
   no fallback link, while looking finished. Both spellings are in SOURCE_SITES now; `bsz` is a
   documented alias.
2. The mwp-search manifest row declares `extra: [{"name":"search","isRequired":true}]`, NOT the
   bare `extra: ['search']` a first read suggested. The first cut of the discovery code filtered
   the manifest through activeCatalogs(), which correctly DROPS required-extra rows (they are not
   home shelves) — so it found zero catalogs and made no request. Green against the fixture, dead
   against production. isAdultCatalog() is now split out and reused alone: Adult stays out of
   search, a search-only catalog stays in. The fixture now pins the real shape.

## HOW IT GENERALISES — one table row per site, not five branches

    const SOURCE_SITES = { mwp: {...}, bs: {...}, bsz: {...} }

plus `sourceSite(metaOrId)`, which matches the prefix loosely so `mwp:tv:14995`,
`mwp:tv:14995:2:17` and a bare `bs:223006` all resolve. Search discovery reads the addon's own
manifest for catalogs declaring a search extra — the live addon now declares TWO (mwp-search and
bs-search) and the second one needed no change to this file.

## HEADERS: FORWARDED, NOT DROPPED

Nothing in this repo had ever read `behaviorHints.proxyHeaders.request` or a flat `referrer`.
streamHeaders() reads both. Apple TV, Android and Roku get them (their players can set request
headers). A BROWSER CANNOT — `Referer` and `User-Agent` are forbidden header names, so
setRequestHeader is ignored per spec and hls.js hits the same ban. The browser therefore plays the
url as given and REMEMBERS the requirement, so playFailureReason() names it instead of saying
"this stream cannot play in this browser". Tizen's avplay branch cannot send one either and says
so out loud rather than pretending.

## THE `refused` ARRAY IS READ NOW

The relay note on BLZ-0019 said no client read it. Live on bs:223006:

    refused: [{host: 'voe.sx',      reason: 'resolver returns a jwplayer analytics pixel, not media'},
              {host: 'vidmoly.org', reason: 'media manifest answers 403 without headers a television cannot send'}]

An empty panel that says only "nothing came back" reads as our bug. It now says
"2 hosts had it (voe.sx and vidmoly.org) — resolver returns a jwplayer analytics pixel, not media."

## VERIFIED LIVE, local app.js against the REAL addon.lyreosai.com

    search "baddies"      30 cards — 20 MWP-badged, 10 BS-badged   (was 0 before this change)
    both catalogs hit     /catalog/movie/mwp-search/search=baddies.json  200
                          /catalog/movie/bs-search/search=baddies.json   200
    open mwp:tv:14995     /stream/movie/mwp:tv:14995.json 200 -> 2 stream rows rendered
                          "MrWorldPremiere source" pill, Play VISIBLE, status empty,
                          website link correctly DEMOTED (hidden) because streams exist
    pageerrors            none

Note the addon side landed in parallel today: /stream/movie/mwp:tv:14995.json answered
`{"streams":[]}` at the start of this session and answers 2 streams now.

## THE GATE

    node site-source.smoke.mjs        exit 0, 10 gates, 36 assertions
    npm test                          31/33 in one parallel run, 1710s
    manga.smoke.mjs alone             exit 0   "all checks passed"
    profile-restore.smoke.mjs alone   exit 0   19 passed, 0 failed

The two that failed in the parallel run are the documented CDP/load flake on a
4-core machine ("Comet did not answer CDP on 127.0.0.1:52154 within 30000ms",
and a localStorage read that raced the profile event). Both pass alone. Do not
chase them as regressions; re-run the suite alone first, every time.

## MUTATION-CHECKED, 17 mutations, 0 survivors

Every new behaviour was broken on purpose and site-source.smoke.mjs went RED for each one:
the isMwp early-return restored; the bs row and the bsz alias deleted; search discovery put back
through activeCatalogs; Adult no longer excluded from search; headers dropped from the shell
payload; the fallback link never revealed; the flat `referrer` ignored; Play hidden again;
`website` not merged from /meta; the fallback href set only in openDetail; `refused` not carried
out of resolveStreams; describeRefused forced to ''; the refused sentence emitted with no data;
revealSourceLink never revealing; and revealSourceLink never setting the href. All 17 red, then
reverted.

## ONE WORDING TRAP WORTH KNOWING

The "every row rejected by the device probe" branch does NOT go through showSourceFallback().
Its sentence is "no playable stream came back for this title yet", which would sit beside
"All 12 sources are above this screen's 1080p" and contradict it — the addon DID answer there.
That branch reveals the link with revealSourceLink() and writes its own line. If you ever unify
them, unify the WORDING too.
