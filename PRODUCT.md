# PRODUCT.md

register: product

> **NOT THE NAV AUTHORITY. `~/Desktop/roku channels/DESIGN.md` IS.**
>
> Settled by Markus on 6 Sep 2026. Every client is to build the canonical
> **11-item** nav at DESIGN.md line 74:
>
>     Movies · TV Shows · Anime · Roadmaps · Library · Live TV · YouTube ·
>     Games · Adult · Search · Settings
>
> WHY THIS BANNER EXISTS. This file used to be read as an equal authority, and
> its "4 top-level destinations" line below was followed literally: the web app
> shipped an 8-item hand-written bar and four contract destinations — Live TV,
> YouTube, Adult and Settings — were never built at all, while the Roku built
> all eleven from DESIGN.md. Measured 6 Sep 2026: Roku 39 home rows and 11 nav
> items, web 0 rows and 8 nav items. Markus, looking at the two side by side:
> *"i still dont understand how and why everything looks like their own app like
> there is not one device that has my app where the app is the same."*
>
> That was the cause. Two checked-in briefs, both being followed, disagreeing.
>
> What this file is still good for: the strategic principles and the anti-
> references below, which remain correct and are not in dispute. Read it for
> voice, restraint and honest-state rules. Do NOT read it for how many
> destinations the nav has, or which ones.

## What this is

Blazing Stream — a self-hosted media app that aggregates Real-Debrid/TorBox
streams plus a personal Emby library across five clients: this web app, Roku,
Fire TV, tvOS, and Samsung Tizen. One household account, multiple profiles
with PIN-gated rating caps. Not a public product — built for one family and
tuned entirely around how they actually watch.

## Users

Markus (owner, admin) and his household, on phones, laptops, and living-room
TVs. Non-technical family members are expected users, not just Markus — the
whole reason a home-grown app exists instead of scattered Stremio addons.
Sessions happen from a couch with a remote as often as from a browser.

## Strategic principles

- **Simplicity is the product** — WITHIN the canonical nav, not instead of
  it. Fewer *competing* ideas per screen, not fewer destinations than the
  contract names. The original 15-item flattened bar was the bug; the answer
  is DESIGN.md's 11 with the gated ones hidden when their gate is shut
  (Adult behind adultAllowedNow, Library behind mangaAllowedNow), which is
  exactly what the Roku already does — it renders 9 chips at cap=teen.
- **TV-first, browser-second.** Every screen has to work with a d-pad and be
  readable from six feet away, even in the browser build — the same person
  uses this app from a couch and from a laptop.
- **One brand across five clients.** Roku, Fire TV, Apple TV, Samsung, and web
  must not visibly disagree — same accent red, same nav order, same voice.
- **Never fake success.** A queued request, a failed resolve, an empty
  catalog — each gets its own honest state. Silent fallbacks and "probably
  worked" toasts have caused real production bugs here before.

## Anti-references

- **This app's own pre-redesign web nav** (15 top-level items: Trailers,
  Comics, Education, Requests, Admin, Stories, Studio, Family, all flattened
  into one bar). The exact shape of "more features" mistaken for "better."
- **Generic SaaS dashboard chrome** — card-grid homepages, gradient hero
  metrics, glassmorphism. This is a living-room media app, not an admin tool.

## Reference target (current task)

DebridStream v3.6 (Android TV/Fire TV, r/Debrid_Stream_App). Full brief
already written: `~/Desktop/blazing-shots/REFERENCE-debridstream-v36.md`.
Headline: hero-inside-the-row home layout,
a real search experience (mic, query chip, genre facet rail), and a
three-field edit-profile screen. Treat that file as the authoritative shape
brief for this task — it was written from the actual reference video, frame
by frame, specifically for this redesign. Take its LAYOUT and interaction
ideas. Do not take its destination count: DESIGN.md governs that, per the
banner at the top of this file.
