# blazing-web handoff — 11 Sep 2026

Working on: DebridStream 3.7 item 12, director filmography, on all four
clients. This file covers the web half.

Last action: committed and pushed `ed22ea2`. The web detail dialog had NO
crew at all — no director, no cast, no companies. It now shows
"Directed by <name>" as a real `<button>`, and pressing it opens a
filmography dialog over the sheet. 36/36 smoke suites pass.

Next step:
```bash
cd /Users/markususche/Desktop/blazing-web && node director-filmography.smoke.mjs
```
Then deploy to **Cloudflare Pages** (never Vercel) and open a film in a real
browser to confirm the dialog stacks correctly on a phone width.

Key files:
- `app.js` — `renderCrew`, `openPerson`, `personCard`, `openResolvedTitle`, `closePerson`
- `index.html` — `#detail-crew`, and the `#person-dialog` block
- `styles.css` — `.detail-crew`, `.detail-crew-name`, `.person-card-slot`
- `director-filmography.smoke.mjs` (new), `scripts/run-smokes.mjs` floor 32 → 33

## Traps

- **`role=director` is load-bearing.** TMDB splits `combined_credits` into
  `cast` and `crew`; a director's own films are ONLY in `crew`. The smoke test
  is negative-controlled on exactly this: drop the role and it reddens with
  `actual: '', expected: 'director'`.
- **The person payload keys a title's kind as `mediaType`, not `type`.**
  Reading `type` files every credit as a movie.
- **`personCard` wraps the card on purpose.** `buildCard` attaches its own
  click handler to the card, and a capture listener added to that SAME element
  does not reliably run first — at the target phase capture and bubble
  listeners fire in registration order. A listener on an ANCESTOR always wins
  the capture phase. That wrapper is what makes the tmdb: interception correct
  rather than usually correct.
- **The credits carry `tmdb:` ids and nothing downstream can open one.** The
  fleet sends them deliberately (`blazing-fleet/richmeta.js` measured it), so
  the resolve is on the click, one call for the card that was picked.

## What web still does NOT have that the televisions do

Named here because it is the real remaining parity gap and it is bigger than
this item: the detail dialog still has **no cast row, no production
companies, no reviews, and no "More like this"**. Fire TV and the Roku have
all four from `GET /meta/rich`, which this client now calls for the crew and
throws the rest of away.

Blockers: none.
