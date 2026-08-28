# DESIGN.md

Extracted from the live `styles.css` — these are the tokens already in
production across the site, not proposed ones.

## Color

```css
--bg: #0A0A0A;
--surface: #141416;
--surface-focus: #1c1c1f;
--surface-soft: #18181b;
--text: #f7f7f8;
--accent: #FF3D47;
--accent-strong: #E11D2B;
--accent-glow: rgba(255,61,71, 0.35);
```

Restrained strategy: near-black neutrals, one accent (red) used sparingly for
focus rings, primary buttons, and active nav state. This red is the ONE thing
that has to read identically across all five clients — Roku, Fire TV, and
Apple TV all reference it as "the accent," and a mismatch here was a real bug
fixed tonight. Do not introduce a second accent hue without a strong reason;
if the DebridStream brief calls for a second ground color (the search
screen's deep blue/teal), treat it as a deliberate second surface, not a
second brand color — accent stays red everywhere.

## Typography

`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe
UI", sans-serif`. No serif, no display face — this is a TV app, legibility at
distance wins over personality in the type choice itself; personality comes
from layout and motion instead.

## Shape and elevation

`--radius: 16px` on cards/panels. Focus state is a colored ring +
drop-shadow using `--accent-glow`, not a border-only outline — see
`.card:focus`. This already matches the DebridStream brief's "filled pill"
focus language in spirit (a filled/glowing state, not a thin outline) — keep
that continuity rather than introducing a different focus language for the
redesigned screens.

## Existing components worth reusing, not re-inventing

- `.primary-button` / `.secondary-button` — gradient-accent primary, ghost
  secondary. Already d-pad/keyboard focusable.
- `.spinner` — accent-colored ring spinner, already used app-wide for loading
  states.
- `.icon-button` — round icon-only button, used for search/menu.
- `buildCard()` in app.js — the existing poster-card builder. The hero-in-row
  home layout is a NEW composition of cards (focused = wide hero, neighbors =
  existing portrait card), not a replacement for the card component itself.

## What's explicitly changing in this pass

Per `~/Desktop/blazing-shots/REFERENCE-debridstream-v36.md`: home gets
hero-inside-the-row treatment and editorial row titles; search gets a
distinct ground color, mic button, removable query chip, and a genre facet
rail; profile creation/edit gets reduced to three fields with a full-bleed
art background on the picker. Nav is already down to 7 items from tonight's
earlier pass — this task does not reopen that count unless the brief
specifically calls for going to DebridStream's 4+search.
