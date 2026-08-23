Working on: Watch-party chat, reactions, and voice/video call panel for the blazing-web PWA.

Last action: Built watch-party.js (new file, ~1050 lines, IIFE, no build step) wired to the live
party-realtime.js signaling relay on fleet.lyreosai.com. Verified in a headless Chrome smoke test
(chrome-devtools MCP) with stubbed fetch/WebSocket/getUserMedia: join-by-code flow, real
RTCPeerConnection offer/ICE generation, a real second RTCPeerConnection completing SDP negotiation
to `stable`, chat send/receive, reactions + toast, mic/cam mute, peer-left cleanup, Leave teardown
(tracks stopped, ws closed, storage cleared), and the 4410 "party ended" close code. Zero console
errors from the new code. NOT committed or pushed — see Blockers.

Next step:
  1. Read the diff: cd "/Users/markususche/Desktop/blazing-web" && git diff -- index.html sw.js && git status
  2. If it looks right, commit + push it yourself (I did not, on purpose — see Blockers), then
     Cloudflare Pages will redeploy blazing-web automatically on push.
  3. Real-device test: open the site on two phones/laptops, get a party CODE from wherever it's
     shown (Roku/FireTV `/party/start` flow — not part of this file), tap the "Party" button in the
     topbar on both, type the code in, allow camera+mic on at least one, confirm you see/hear each
     other, chat, and send reactions. This is the one thing that genuinely cannot be verified without
     real hardware and two humans.

Key files:
  - /Users/markususche/Desktop/blazing-web/watch-party.js (new)
  - /Users/markususche/Desktop/blazing-web/index.html (added one <script> tag before </body>)
  - /Users/markususche/Desktop/blazing-web/sw.js (added watch-party.js to the cached shell list, bumped CACHE to v6)
  - Server-side contract this codes against (already live, not touched): blazing-fleet repo,
    party-realtime.js (wss://fleet.lyreosai.com/party/<CODE>/signal) + party.js (GET /party/active,
    GET /party/:code/state) + server.js's route table.

Blockers: none technical. I did not commit/push myself because this is untested-with-real-hardware
WebRTC code going straight to a live, deployed PWA (Cloudflare Pages auto-deploys on push) — that's
an "ask first, reaches an audience" case per CLAUDE.md, not a "just do it" one. Everything is saved
on disk and ready; it just needs your (or the next session's) explicit go-ahead to commit and push.

Design notes worth knowing:
  - blazing-web has no "host a party" UI yet (nothing calls POST /party/start), so the only reliable
    entry point today is manually typing in the code shown on the TV — that's the primary path.
    GET /party/active?householdId=<this browser's own deviceId> is also wired (as asked) as a
    best-effort auto-discovery hint, but it only fires if this exact browser already registered a
    device via the existing profile.js panel, and only actually finds anything if this same browser
    happens to be the party's host (there's no household-invite UI in blazing-web to join someone
    else's household). Real fix for that gap is a separate feature (surfacing a code + a "start a
    party" button somewhere, or wiring the invite/redeem flow) — out of scope for what was asked here.
  - Chat/reaction messages carry only a peerId ("from") on the wire, never a display name — the
    server's contract has no name field for those. People are labeled "Guest-XXXX" (last 4 chars of
    their peerId). Fixable later via a small WebRTC data-channel handshake per connected peer, but I
    left that out to avoid adding untested surface for a cosmetic gain.

--- 2026-08-22, after the power outage (nyc-main) ---

Two more changes landed in watch-party.js. Still NOT committed, still for the
same reason: a push here auto-deploys the live public PWA, and two real people
have still never been on a call with it.

  1. PER-PERSON MUTE. Every remote tile has a 🔊/🔇 button. It sets
     <video>.muted on that one tile and sends nothing to anyone — muting a
     person for the whole room would be a moderation power the signaling
     contract does not have, and nobody asked for it. Survives that peer
     dropping and rejoining, and survives their stream arriving late.
  2. ICE COMES FROM THE SERVER. The hardcoded single STUN server is now only a
     fallback; the real list is fetched per call from GET /party/ice (new,
     already live on fleet.lyreosai.com — blazing-fleet ice.js @ 7568c50).
     That is what lets a TURN relay be switched on with env vars alone instead
     of reshipping this file. A 'failed' connection with no relay configured now
     explains itself in the call note.

     NOTE: no TURN server is actually running yet. /party/ice answers
     relay:false today, so calling still only works between people whose
     networks form a direct path. Standing one up is a Markus decision.

VERIFIED: watch-party.smoke.mjs (new file here) — 15/15 checks in real headless
Chrome with the real WebRTC stack and Chrome's fake camera. Run it:
  node /Users/markususche/Desktop/blazing-web/watch-party.smoke.mjs
It proves the TURN entry reaches RTCPeerConnection, that mute is per person and
local, that a second caller is unaffected, that STUN-only still meshes, and that
a dead /party/ice falls back instead of blocking. It cannot prove two humans can
hear each other.

Next step: unchanged — read the diff, get Markus's go-ahead, test with two real
devices, then commit and push.

--- same session, after Markus answered ---

PUSHED. Markus said push it now, so watch-party.js, the index.html script tag,
the sw.js v6 cache bump and watch-party.smoke.mjs are committed and on
origin/main @ 1bcd89c. .omc/ is now gitignored.

FACT CORRECTION for whoever reads the note above: this repo deploys to GITHUB
PAGES (https://kaoz625.github.io/blazing-web/), not Cloudflare Pages. The
earlier handoff said Cloudflare. Deploy is `gh api repos/Kaoz625/blazing-web/pages`
-> status, and it takes a minute or two after a push.

TURN RELAY: Markus said leave it off for now. So /party/ice keeps answering
relay:false and calling only works between people whose networks form a direct
path — it will often fail on phone data or across two different houses. The
server side is ready the moment he changes his mind: fill TURN_URLS plus either
TURN_SECRET or TURN_USERNAME/TURN_PASSWORD into ~/blazing-fleet/.env on mac2 and
`docker compose up -d`. No code change on either side.

Next step: two real people, two real devices, one party code off a TV. That is
the only thing left that has never been proven.

--- 2026-08-22, evening (nyc-main/web-agent) — MY LOCKER ---

Working on: "My Locker" — Markus's private Streamtape files, in the web PWA.

Last action: Built and shipped it. blazing-web @ 230749b, pushed, GitHub Pages
status "built", https://kaoz625.github.io/blazing-web/locker.js returns 200.

What it is: one more shelf on Home, built from the shelf/card markup that was
already in styles.css (.row / .row-track / .card). No new design system. Files
have no artwork, so the cards use the app's own .no-image "B" placeholder plus
a small size pill. Clicking a card resolves the file and hands the URL to
app.js's own openPlayer() — there is no second video path in this app.

Files:
  - locker.js (NEW, IIFE, no build step, same shape as profile.js/watch-party.js)
  - locker.smoke.mjs (NEW, 35 checks)
  - index.html (one <script src="./locker.js" defer> after watch-party)
  - sw.js (./locker.js added to SHELL, CACHE bumped v6 -> v7)
  watch-party.js was NOT touched. No other repo was touched. No TV, Roku, Fire
  Stick or Apple TV was touched.

Wire contract (already live on fleet.lyreosai.com, not written by me):
  GET /streamtape/list?deviceId=<id>          -> [{id,name,size,embed,...}]
  GET /streamtape/resolve/<fileId>?deviceId=<id> -> {id,name,size,url}
  Both need the X-Device-Token header AND the device to be admin-approved.

Three decisions worth knowing before anyone changes this:
  1. AUTH IS BORROWED, NOT MINTED. It reads the id+token profile.js already
     registered and stored in localStorage['blazing-web-profile-device-v1'].
     It never calls /agent/register itself. A second registration path would
     mean a second device sitting in the approval queue for one person.
  2. FAILURE IS SILENCE. No credentials, or 400/403/503 from the fleet, and the
     whole shelf is removed — no error box. Almost nobody who opens this public
     site has this feature; an error about it would be noise to all of them.
     Consequence: "not approved" and "CORS is blocking me" look identical from
     the outside. The browser console is what tells them apart.
  3. NO POLLING LOOP. Refresh happens on load, on window focus, and on
     visibilitychange->visible, with a 20s floor between calls. A file uploaded
     elsewhere shows up the next time the tab is looked at again.
  Also: the shelf carries no media type, so it is Home-only, the same rule
  app.js applies to its own untyped rows. It re-syncs after nav clicks.

VERIFIED: node /Users/markususche/Desktop/blazing-web/locker.smoke.mjs
  35/35 in real headless Chrome with the fleet stubbed by route interception —
  renders in server order, the deviceId and X-Device-Token reach both routes,
  an empty locker reads as empty and NOT as an error, 403/400/503 each remove
  the shelf silently, an unregistered browser never calls the routes at all,
  and a click resolves the file and reaches #player with the resolved URL.
  Re-ran watch-party.smoke.mjs too: 15/15, nothing regressed.

Next step (the one thing the tests cannot prove):
  Open https://kaoz625.github.io/blazing-web/ on Markus's approved browser and
  look for the "My Locker" shelf on Home.
  - Shelf shows his files -> done, nothing left.
  - Shelf missing -> open the browser console. If it says CORS, the fix is on
    the fleet, not here: /streamtape/* must send
    Access-Control-Allow-Origin for https://kaoz625.github.io and must allow
    the X-Device-Token request header on the preflight. That is a blazing-fleet
    change (mac2), NOT a locker.js change.

Blockers: none in this repo. The only open question is the live CORS check
above, which needs Markus's approved browser to answer.
