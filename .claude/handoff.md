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
