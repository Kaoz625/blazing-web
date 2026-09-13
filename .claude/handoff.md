# blazing-web handoff — 13 Sep 2026

Working on: finishing the 7 unpushed commits that could never deploy, plus the
5 confirmed defects an adversarial review found in them.

Last action: committed 5 changes (tree clean, 12 commits unpushed). NOT PUSHED —
a push to main publishes the live public site, and that needs Markus.

## STATE

| repo | sha | state |
|---|---|---|
| blazing-web | 47ed7cf | clean, 12 unpushed |
| roku channels | 7ae48ea | clean, pushed |
| firetv | 186b51d | clean, pushed |
| blazing-tvos | e337a47 | clean, pushed |
| printing-press | 893b69f | clean, pushed |
| 3d prints | 7fe60b7 | clean, pushed |

## Next step

```bash
cd /Users/markususche/Desktop/blazing-web && git push
```

ONLY after Markus says yes. pages.yml publishes https://kaoz625.github.io/blazing-web/
on every push to main. The switch IS thrown (build_type=workflow, verified via
gh api), so the 23-check gate runs FIRST and a red gate leaves the live site on
the last good commit. It is gated, but it is still a public deploy.

## Why those 7 commits never deployed

scripts/run-smokes.mjs had no per-suite timeout. One hanging suite hung the
whole gate; CI killed the job at 30 min with no tally and no name, `deploy`
needs `gate`, so the site silently stopped following main. Fixed in cca1c58.

## THE OPEN ONE — intermittent hang, root cause unknown

A random suite hangs in a full run. Different one each time. Every one of them
passes alone:

| run | conditions | hung |
|---|---|---|
| 1 | 26 agents running concurrently | youtube.smoke.mjs, 47 min |
| 2 | near-clean | none |
| 3 | clean, no agents | profile-flow.smoke.mjs, hit the 240s cap |

  youtube.smoke.mjs    alone: 42 passed 0 failed, 24.0s
  profile-flow         alone: 122 passed 0 failed, 43.8s
  youtube-play         alone: 15 passed 0 failed, real decoded bytes

NOT a leak. Sampled every 20s through a clean run: comets=0 at every sample,
free+inactive memory flat 9.7-10.5 GB. An earlier note of mine claiming leaked
browsers was wrong and is retracted in the team chat.

Heavy agent load makes it much likelier but is not the whole story, because run
3 was clean. DO NOT run the browser suite and a big agent fan-out together on
mac1 — that much is measured.

## Last full run

45/46. The one TIMEOUT was the intermittent hang above, not a defect. The two
failures in the run before it are both fixed: search.smoke.mjs (stale guard,
47ed7cf) and youtube-play (transient live resolver, passes now).

## Traps

- youtube-play.smoke.mjs is a LIVE test inside the deploy gate — it hits the
  real fleet and the real addon and decodes a real stream. It failed once
  tonight with "the resolver on the server did not answer" and passed on retry.
  It WILL flake the gate again.
- A guard must be watched going RED on broken code. Three separate tests
  written this session passed on the defective code and were caught only
  because a second agent rebuilt the broken tree and ran them.
- A guard must not CRASH when it fails. Two of them threw on a null element and
  ended the run with no tally, which reads as a much smaller failure than it is.
- GitHub runners are UTC. Any timezone fixture that only separates right from
  wrong outside UTC is decoration in CI.

Blockers: the push decision, and the Vender Resale question (research/ is
served on the public storefront — see ~/.claude-team/chat/vender-resale.md).
