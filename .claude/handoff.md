# blazing-web handoff — 13 Sep 2026

Working on: parity audit blocking tier — B2 (Stream Sources screen) plus the
  YouTube resolve path.
Last action: pushed 92704d2. Gate green, deployed, live files verified by sha256.
Next step: nothing is pending in this repo. The next parity work is the
  major/minor recheck, which Markus approved — see "Next" below.
Key files: sources.js, sources.smoke.mjs, youtube.js, youtube-play.smoke.mjs,
  scripts/run-smokes.mjs
Blockers: none in this repo. mac1 itself needs a reboot (load average 1003).

## What landed today

759a123  B2: a read-only Stream Sources screen in the browser
9690167  resolve() retries once — one dropped request used to end the play
92704d2  the resolver failure now says WHICH failure it was

All three are live. Verified by sha256 against https://kaoz625.github.io/blazing-web:
sources.js, youtube.js, index.html, styles.css, app.js all IDENTICAL to local.

Full suite 47/47. MIN_SUITES is 39 and 39 *.smoke.mjs exist.

## Why those 7 commits never deployed — CORRECTED 13 Sep 2026

They were never PUSHED. That is the whole reason.

This section used to say a hanging suite hung the gate. That was wrong, and it
was a guess written as a fact. `gh run list --workflow pages` shows the 11 Sep
run at 719183c succeeded and deployed. No CI run was ever killed by a hang.

The per-suite timeout added in cca1c58 is still worth having — a suite really
did hang for 47 minutes locally — but it fixed a risk, not this outage. The
commit message on cca1c58 carries the same false claim and cannot be edited now
that it is pushed; this note is the correction of record.

## The resolver, and what is still NOT known

Measured timeline:
  05:23  CI resolve OK
  07:18  CI resolve FAILED (1 attempt)
  10:10  CI resolve FAILED (2 attempts — the retry was already in)
  10:29  CI resolve OK, HTTP 200 after 3948ms

So it was a WINDOW of about three hours in which addon.lyreosai.com would not
answer the GitHub runner, while answering this machine in ~4s throughout (four
cold ids, 200, 178/180 rate-limit tokens left). The retry did NOT fix it; the
resolver coming back is what made the gate green. THE CAUSE IS STILL UNKNOWN.

Do not shorten this into "youtube-play is flaky". Next time it goes red the
harness prints the status and the timing of every resolve attempt, so a 403, a
429, a timeout and a TLS failure will look different. Read that first.

## Next — approved by Markus

Recheck the 106 major + 28 minor parity items before fixing any of them. The
blocking tier was 85% stale (17 of 20 already fixed), so the same is likely
here. Batch by client, not one agent per item: an agent that has loaded the Roku
tree can check ten Roku items nearly as cheaply as one. File:line evidence
required, or it does not count. Source list:
/Users/markususche/Desktop/blazing-shots/AUDIT-parity-2026-09-11.md and its
banner points at RECHECK-blocking-2026-09-13.md.
