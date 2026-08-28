# PRODUCT.md

register: product

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

- **Simplicity is the product.** The team's own words tonight, echoing the
  reference app's top review: fewer top-level destinations, not more. A
  15-tab nav is a bug, not a feature set.
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
Headline: 4 top-level destinations + search, hero-inside-the-row home layout,
a real search experience (mic, query chip, genre facet rail), and a
three-field edit-profile screen. Treat that file as the authoritative shape
brief for this task — it was written from the actual reference video, frame
by frame, specifically for this redesign.
