# CI for blazing-web

The first CI this repo has had. Added 2 Sep 2026, on top of HEAD `fdad8b7`.

**Updated 3 Sep 2026, on top of HEAD `bb376cf`,** with `pages.yml` — the lane
that puts a gate in front of the live site and takes the deploy away from the
branch. That change closes two entries that used to sit in "Deliberately not
here" below: the 18 `*.smoke.mjs` harnesses, which can now run on a runner,
and a Pages deploy step, which now exists because there is finally something
in front of it. Both entries have been rewritten rather than deleted, because
what they said about the old arrangement is still the reason the new one is
shaped the way it is.

This branch also changes one file that is not CI: `build-tvs.sh`. Adding a
`.github/` directory to this repo broke that script, and the fix belongs with
the change that broke it. See trap 1 below.

blazing-web is the web app — the PWA that GitHub Pages serves, that
blazing-site copies to `blazingstream.lyreosai.com/app/`, and that
`build-tvs.sh` packages for LG webOS and Samsung Tizen. It has no bundler and
no build step, and until 2 Sep 2026 nothing read a file before a browser or a
television did. These six lanes are that reader.

It does now have a `package.json`, added 3 Sep 2026 — but only so the smoke
harnesses have a real playwright dependency. There is still no bundler, no
transpile and no build step; `index.html` still loads plain `<script>` tags
off the disk that Pages serves.

## This repo is PUBLIC, and four things follow

Verified 2 Sep 2026 with `gh repo view Kaoz625/blazing-web --json visibility`:
`"visibility": "PUBLIC"`. The other Blazing repos are private. This one is
not, and every file in this directory is written for that.

1. **Actions minutes on `ubuntu-latest` are free.** Every lane except
   `pages.yml` has a `paths:` filter, but the reason is no longer money. A run
   that cannot
   change its answer is noise: a queue slot taken from a run that can, a log
   nobody reads, a superseded run cancelled for nothing, and a green tick that
   says less each time it appears for a change it did not look at.

   `pages.yml` is the exception and it is deliberate: that lane **publishes
   the site**, so a push that touched only a `.md` still has to reach Pages or
   the live site silently falls behind `main`.
2. **Every CI log is world-readable.** Not "anyone signed in to the org" —
   anyone with the URL. So no step in this directory may ever print an
   environment, list a `HOME`, run `curl` with headers, dump a config, or echo
   anything that could carry a credential. There is no such step today; the
   rule is here so there is never one tomorrow. What each lane prints is
   written in its own `permissions:` comment.
3. **A pull request from a fork runs with a read-only token and no secrets.**
   Nothing here references `secrets.*`, so nothing here notices.
4. **GitHub Pages is live on this repo.** `build_type: legacy`, source branch
   `main`, path `/`, serving <https://kaoz625.github.io/blazing-web/> — still
   `legacy` when re-checked on 3 Sep 2026 with
   `gh api repos/Kaoz625/blazing-web/pages`. **Every push to `main`
   republishes that site, and until the switch below is thrown it does so with
   no check in front of it.**

   That is what `pages.yml` is for, and it is why the rule that used to be
   here — *"there is no deploy step and no Pages step anywhere in this CI"* —
   no longer holds. It was the right rule while the branch was the deploy: a
   second publisher would have been a second way to ship the wrong thing. It
   is the wrong rule once you want a gate, because a gate that cannot stop the
   deploy is a notification. The five check lanes are still
   `permissions: contents: read` and still answer yes or no and stop. One job
   in one lane — `pages.yml`'s `deploy` — holds `pages: write` and
   `id-token: write`, and it cannot start unless `gate` finished green.

   **`pages.yml` is inert until Pages is switched to Actions.** The setting is
   not in this repo and no workflow can change it:

   ```
   gh api -X PUT repos/Kaoz625/blazing-web/pages -f build_type=workflow
   ```

   Land the file first, watch the gate go green, then throw the switch. In
   that order — thrown first, the site would have no publisher at all until
   the file existed. Until then the legacy publisher is still live and still
   ships every push unchecked, and `pages.yml`'s deploy job fails on
   `actions/configure-pages` because the source is not Actions.

   The other live copy, `blazingstream.lyreosai.com/app/`, is not touched by
   anything here either. It is assembled by the blazing-site repo's `build.sh`
   (which rsyncs this repo into its `dist/app/`) and deployed by hand with
   wrangler. A push here does not reach it.

## One file per lane, on purpose

`paths:` is a **per-workflow-file** filter in GitHub Actions, not a per-job
one. A single `ci.yml` holding every job would run all of them on any change
anywhere, or would need a third-party changed-files action to fake per-job
filtering. So each lane is its own file with its own `paths:` list, the same
list on `pull_request` and on `push`, and every file lists itself.

`pages.yml` breaks that pattern on purpose and it is the only one that does.
It holds **two** jobs, and they must be in one file: `needs:` only reaches
another job in the same workflow, so a deploy in its own file could not be
gated by a check in another. It also carries no `paths:` filter, for the
reason in point 1 above. And it duplicates the five checks rather than calling
them — a `workflow_call` refactor of all five would be a bigger, riskier
change than repeating five `run:` lines, and those five lanes still have to
work on pull requests, where `pages.yml` never runs. The cost is real and
worth naming: **the same command now lives in two files.** Change a check and
you change it in both, or the gate and the lane disagree.

## The lanes

| Workflow | Runs when | What it proves |
|---|---|---|
| `assets.yml` | any `.js`, `.png`, `.svg`, `.css`, `index.html`, `manifest.webmanifest`, `build-tvs.sh` | Every file index.html, sw.js and the PWA manifest name is a tracked file; every script index.html loads is precached by sw.js (4 known gaps pinned); build-tvs.sh's rsync excludes drop nothing the app loads, and still exclude `admin.js`, `.github`, `__pycache__`, `node_modules`, `package.json`, `package-lock.json` and `scripts`. 67 tracked files, 16 refs, 12 scripts, 16 SHELL entries, 18 rsync excludes, 0 failures, 4 warnings. |
| `manifests.yml` | `config.xml`, `appinfo.json`, `manifest.webmanifest` | The Tizen widget config, the webOS appinfo and the PWA manifest parse and carry every key their platform requires. 0 failures, 1 warning (the Tizen `<access>` gap, below). |
| `python.yml` | any `.py` | All 7 tracked python files compile: the 5 `patch_*.py` migrations and the 2 check scripts. `compile()`, never `py_compile`, so nothing writes `__pycache__`. |
| `shell.yml` | any `.sh` | shellcheck at `--severity=warning --exclude=SC2027` over `build-tvs.sh`, the TV release script. 0 findings. |
| `syntax.yml` | any `.js` or `.mjs` | `node --check` on all 35 tracked scripts, one process per file so the log names the broken one. |
| `pages.yml` | **every** push to `main` (no `paths:` filter), and `workflow_dispatch` | Job `gate`: all five checks above, plus `npm ci`, `npx playwright install --with-deps chromium` and `npm test` — the 18 `*.smoke.mjs` browser harnesses. Job `deploy`: `needs: gate`, so it is skipped unless the gate is green; `configure-pages` → `upload-pages-artifact` (`path: .`) → `deploy-pages`. The only job in this directory with write access to anything. **Inert until Pages is switched from `legacy` to `workflow`** — see point 4 above. |

**Those numbers moved on 3 Sep 2026 and not all of the movement is this
change's.** The table used to read 61 tracked files, 15 refs, 11 scripts, 15
SHELL entries and 15 rsync excludes, and the syntax row used to say 32
scripts. Commit `bb376cf` had already added `caps.js` and
`caps-hero.smoke.mjs` before anything here was touched — that is +1 ref, +1
script, +1 SHELL entry and +2 to the syntax count, and the README had drifted
behind it. This change adds `package.json`, `package-lock.json`,
`scripts/run-smokes.mjs` and `.github/workflows/pages.yml` (+4 tracked, +1 to
the syntax count) and three rsync excludes.

Every number in the table below was measured on a clean `git archive` export of
**this branch's tree** — the CI files and the `build-tvs.sh` fix included —
extracted to `/tmp/exp-blazing-web`, re-initialised as a git repo so
`git ls-files` answers the way `actions/checkout` makes it answer, and run
with the exact `run:` command from each workflow and a throwaway `HOME`. A
4-core Mac, 2 Sep 2026, with three browser harnesses running beside it.

| Lane | Wall clock | Exit |
|---|---|---|
| `assets.yml` | 0.36 s idle, 0.86 s under load | 0 |
| `manifests.yml` | 0.28 s | 0 |
| `python.yml` | 1.47 s | 0 |
| `shell.yml` | 0.30 s | 0 |
| `syntax.yml` | 6.92 s | 0 |

Both python checks were run on python 3.9.6, 3.11.15, 3.12.13 and 3.14.3 —
exit 0 on all four, so whichever python3 the ubuntu image carries will do.
`shellcheck` was 0.11.0 and node was 25.9.0.

**Confirmed on real runners.** PR #1, 2 Sep 2026, runner image 20260819.586:
all five lanes green on the first run, no retries. Wall clock including
checkout — `assets` 4 s, `manifests` 6 s, `syntax` 9 s, `python` 4 s, `shell`
5 s, so `timeout-minutes: 5` is roughly 30x the slowest. The assets lane
printed the same numbers there as here: 61 tracked files, 15 refs, 11 scripts,
15 rsync excludes, 0 failures and the same 4 warnings.

The assets lane was also proven **against mutations**, because a check that
has quietly stopped matching passes for free. Each of these turned exit 0 into
exit 1 with a named FAIL line, and reverting restored exit 0: a `<script>` tag
pointing at a file that does not exist; `./dpad.js` added to `sw.js`'s SHELL
while still pinned; `--exclude 'manga.js'` added to the rsync; `--exclude
'.github'` removed; `--exclude '__pycache__'` removed; and every `<script` tag
in `index.html` mangled, which the no-op floor catches by name.

The two check scripts, `.github/checks/assets.py` and
`.github/checks/manifests.py`, are standard library only and are run by the
same command a human types: `python3 .github/checks/assets.py` from the repo
root. There is no CI-only wrapper to drift away from what people actually run.

## Rules every lane follows

- **`ubuntu-latest` only.** On a public repo every OS is free, but macOS and
  Windows runners queue longer and boot slower, nothing here needs either,
  and in the private Blazing repos they bill at 10x and 2x — so it is one
  rule for all of them.
- **`permissions: contents: read`.** See "This repo is PUBLIC" above.
  `pages.yml` is the single exception, and it is scoped as narrowly as it can
  be: the workflow default is still `contents: read`, its `gate` job restates
  that, and only its `deploy` job adds `pages: write` and `id-token: write` —
  the two `actions/deploy-pages` cannot work without. **No job anywhere in
  this directory has `contents: write`.** Nothing here pushes a commit.
- **`concurrency` with `cancel-in-progress: true`.** So the tick on a PR is the
  tick for the commit that is there, not an older one that finished later.
  `pages.yml` sets it **`false`**, in group `pages`, for the opposite reason:
  cancelling a deploy midway can leave Pages holding a partial upload. Two
  pushes in quick succession queue and both publish, in order.
- **`timeout-minutes: 5` on every job.** Every static lane measures under 10 s;
  five minutes covers runner and image startup and stops a hung step from
  sitting on the 6-hour default. `pages.yml` needs more and says why: its
  `gate` is 30 minutes because the 18 browser harnesses take about 5 minutes
  between them locally, and its `deploy` is 10.
- **No secrets.** Nothing references `secrets.*`. A lane that would need one is
  a design question and it goes in "Deliberately not here" until answered.
- **Nothing touches real infrastructure.** No lane reaches a Roku, a Fire TV,
  an Apple TV, mac2, mac3, Cloudflare, Coolify, Neon, Emby, Real-Debrid,
  TorBox, Streamtape, or any production URL. `assets.py` deliberately skips
  absolute URLs in `index.html` for exactly this reason.
- **Discover, never list.** Every lane finds its files with
  `git ls-files '<glob>' | xargs -r`, so a new script is checked without
  anyone remembering to edit a workflow. And the silent no-op is guarded:
  `assets.py` fails if its regexes find fewer than 10 refs, fewer than 10
  SHELL entries or fewer than 8 rsync excludes, because a check that matches
  nothing must go red, not pass for free.
- **Green on arrival, measured not assumed.** The numbers above are the
  numbers seen. Where something could not be verified locally it says so, in
  an HONESTY NOTE, in the file.

## No longer "deliberately not here" — closed 3 Sep 2026

Two entries below used to live in the next section. Both are now shipped, in
`pages.yml`. The old text is kept because it is the record of what was wrong.

- **The `*.smoke.mjs` browser harnesses — NOW IN CI.** There are 18 of them,
  not 17: `caps-hero.smoke.mjs` arrived with `bb376cf`. The remedy the old
  entry prescribed is exactly what was done, and one thing it did not mention
  had to be done too:

  1. `package.json` (`private`, `type: module`) with playwright as a real
     devDependency pinned to **1.59.1** — the version actually installed and
     working at `~/.hermes/hermes-agent/node_modules/playwright`, read from its
     own `package.json` so local and CI cannot disagree — plus a committed
     `package-lock.json` for `npm ci`.
  2. The absolute import replaced by `import { chromium } from 'playwright'`
     in all 18.
  3. `executablePath` deleted in all 17 that had it, so playwright picks its
     own browser. (`caps-hero.smoke.mjs` already launched bare.)
  4. **Not in the old plan, and it would have failed CI on its own:** `ROOT`
     was a hardcoded `/Users/markususche/Desktop/blazing-web` in all 18 — 7 of
     them with no override at all, 11 with a `BW_DIR` fallback. On a runner
     that path does not exist, so the fixture server would have answered 404
     for every file and all 18 would have failed with the browser working
     perfectly. It is now
     `process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url))`,
     which resolves to whatever directory the harness was checked out into and
     still honours `BW_DIR`.

  `npm test` runs `scripts/run-smokes.mjs`, which discovers every
  `*.smoke.mjs` with `readdir` (never a list — same rule as `git ls-files`
  elsewhere), runs each in its own process, **keeps going after a failure** so
  one broken suite cannot hide the state of the rest, prints a `PASS`/`FAIL`
  line and a tally, and exits 1 if any failed. It fails if it finds fewer than
  `MIN_SUITES` suites, so a rename that makes the glob match nothing goes red
  instead of passing for free. **That floor is 18 — the real count, not a
  round number under it.** A floor of 10 against 18 suites would let eight of
  them be renamed, moved or deleted and still report a green "10/10 passed",
  which is the same silent no-op the guard exists to stop. The check is `<`,
  so a 19th suite needs no edit here; removing one is meant to cost a
  deliberate edit in the same commit. Both behaviours were proven, not
  assumed: a temporary suite calling `process.exit(3)` produced `0/1 passed`,
  `FAILED: …` and a runner exit of 1.

  **`npx playwright install` is required on the runner and is easy to think it
  is not.** Locally `npm test` needs no install step, because the shared
  `~/Library/Caches/ms-playwright` already holds
  `chromium_headless_shell-1217` — the revision playwright 1.59.1 asks for
  (`playwright-core/browsers.json`) — left there by some other project. Note
  the full `chromium-1217` is **not** there; only the headless shell is, which
  is all a headless `chromium.launch()` needs. A runner's cache is empty, so
  the lane runs `npx playwright install --with-deps chromium`, which also
  brings the apt libraries a bare `playwright install` does not.

- **A GitHub Pages deploy step — NOW IN CI, and it is the point.** The old
  entry said a deploy step was a second publisher and a second way to ship the
  wrong thing. That was true while Pages published the branch. The trouble is
  what it left behind: with `build_type: legacy` the branch IS the deploy, so
  the five check lanes reported on commits that were already live. `pages.yml`
  replaces the branch publisher with a gated one — same site, same `path: .`,
  but it cannot start until `gate` is green. It stays inert until Pages is
  switched to `workflow`; see point 4 near the top.

## Deliberately not here

- **The old smoke-harness entry, kept verbatim as the record.** All 17 files
  as they stood were checked on 2 Sep 2026. Every one of
  them opened with

  ```
  import { chromium } from '/Users/markususche/.hermes/hermes-agent/node_modules/playwright/index.mjs';
  ```

  and every one launches with an explicit
  `executablePath: '/Users/markususche/Library/Caches/ms-playwright/chromium-1208/chrome-mac-x64/Google Chrome for Testing.app/…'`.
  Both are absolute paths on Markus's Mac, and the second is a **mac-x64**
  build. On ubuntu the import fails outright with `ERR_MODULE_NOT_FOUND`
  before a browser is ever asked for. There is also no `package.json` and no
  lockfile anywhere in the repo (`git ls-files | grep package.json` finds
  nothing), so there is nothing for `npm ci` to install.

  Shipping this lane would therefore mean editing all 17 harness files and
  adding a manifest and a lockfile — changing the tests Markus runs by hand,
  inside a change that is supposed to be only CI. That is a separate piece of
  work and it is not smuggled in here.

  The remedy, when someone takes it: add a `package.json` and a lockfile
  pinning playwright, replace the absolute import with
  `import { chromium } from 'playwright'`, delete the `executablePath` so
  playwright picks its own browser, and then a lane running
  `npx playwright install --with-deps chromium` becomes possible — and free,
  on a public repo.

  Until that lands they are run by hand before a push. **Measured here on
  2 Sep 2026 against this branch's tree, on the machine that can run them:**
  `gate` 88 checks in 90 s, `pinpad` 9 checks in 43 s, `navparity` 58 checks
  in 20 s — 0 failed, all exit 0. (The `gate` baseline recorded in older notes
  is 42; it is 88 as of commit `fdad8b7`, which added scenarios (h)–(m).) The
  other 14 harnesses were not run for this change.

  *(That entry is history as of 3 Sep 2026. All 18 now run in `pages.yml`;
  see the section above.)*
- **Running `build-tvs.sh`.** It needs `@webosose/ares-cli` and Tizen Studio's
  `tizen` binary, neither on a runner, and its output is a TV package that
  Markus installs by hand. The shell lane lints it; the assets lane guards its
  exclude list, which is where both of its recorded failures actually lived.
- **A GitHub Pages deploy step.** Pages already publishes `main` on its own.
  A second publisher in CI is a second way to ship the wrong thing, and it
  would need write permissions this CI refuses to hold.

  *(Also history as of 3 Sep 2026, and reversed on purpose: `pages.yml` is
  that deploy step. It is not a SECOND publisher — it REPLACES the branch
  publisher, once Pages is switched to `workflow`. Having two at once is the
  state to avoid, and it is why the switch and this file must land in the
  right order.)*
- **A live check of `kaoz625.github.io/blazing-web/` or
  `blazingstream.lyreosai.com/app/`.** Both are production URLs. A check that
  fetches one is a monitor of a live service wearing a code check's clothes,
  and on a pull request it would run against the site the PR has not touched.
- **Running the `patch_*.py` scripts.** They are one-shot migrations that
  rewrite `app.js`, `profile.js` and `index.html` in place and have already
  been applied. A lane that ran them would rewrite the site and then, on a
  repo where the branch is the deploy, be one write permission away from
  publishing it. The python lane compiles them and stops.
- **Anything with Docker.** There is no Dockerfile or compose file in this
  repo. And the house rule stands regardless: `docker compose config` expands
  an `env_file` to stdout, which on a public repo is a permanent, world-readable
  leak.

## Traps worth knowing about

1. **`--exclude '.git'` does not cover `.github`, and that shipped this CI to
   a television.** An rsync exclude with no slash matches a **basename**, and
   it matches it exactly. So the moment this directory existed, `build-tvs.sh`
   started copying all seven of its files into the staged app. Measured before
   the fix with `rsync -a --dry-run --itemize-changes` using the script's own
   exclude list: `.github/checks/assets.py`, `.github/checks/manifests.py` and
   all five `.github/workflows/*.yml` were copied in. `--exclude '*.md'`
   dropped this README, which is exactly how the leak looked half-clean.

   This is the same bug `build-tvs.sh`'s own header already records twice —
   once packaging `.` outright, once missing `.claude/` and `.omc/` and
   putting agent session state on a TV. Third time. The fix on this branch is
   `--exclude '.github' --exclude '__pycache__'` in the rsync, and
   `assets.py` now **asserts both names are in that list**, so it cannot come
   back quietly. `__pycache__` is in there for the same reason from the other
   side: it is gitignored now, so `git status` is silent about it, but
   `rsync -a` reads the working tree and not the index.

2. **The 4 pinned SHELL gaps are a real defect, not a CI quirk.** `dpad.js`,
   `games.js`, `manga.js` and `tv-comics-reader.js` are loaded by `index.html`
   and not precached by `sw.js` — the emby.js bug four times over, and the
   road that ended with "a fresh index.html above a four-hour-old app.js".
   `assets.py` pins them so the lane is green today and a fifth one is red
   tomorrow. To clear one: add `'./<name>'` to `SHELL` in `sw.js`, bump
   `CACHE`, and delete the name from `KNOWN_MISSING_FROM_SHELL`. The check
   fails if a fixed name is still pinned, so the list can only shrink.
3. **`config.xml` has no `<access>` element.** On Tizen the internet privilege
   alone is not enough; a widget may only reach an origin an `<access>` element
   names, and it refuses the rest silently. A `.wgt` built from this repo today
   reaches nothing. `manifests.py` warns rather than fails only because the
   repo is already in that state. The fix is one line
   (`<access origin="*" subdomains="true"/>`, or one element each for
   `fleet.lyreosai.com`, `addon.lyreosai.com`, `upscale.lyreosai.com` — the
   hosts the app actually calls, measured). When it lands, promote the warning
   to a failure.
4. **The tracked-file count includes `.github/`.** `assets.py` prints
   `67 tracked files` as of 3 Sep 2026: 55 the app, 9 this directory, 3 the
   npm manifest, lockfile and smoke runner. A future reader comparing against
   an older "53", "61" or "63" is not looking at a regression.
5. **`__pycache__/` is now gitignored.** `python -m py_compile` and any
   `import patch` write it, `build-tvs.sh` does not exclude it, and it was
   sitting untracked in the working tree. The python lane uses `compile()` so
   CI never creates one.
6. **`.claude/handoff.md` is a tracked file in a public repo.** `build-tvs.sh`
   excludes `.claude/` from TV packages, and there is no `.nojekyll`, so the
   legacy Pages build is expected to skip the dot-directory (not checked
   against the live site — that would be a production fetch). Either way the
   file is world-readable on github.com. A grep on 2 Sep 2026 found prose only
   — no credential — but internal engineering notes are on the public
   internet. That is outside this CI's scope to change; it is written here so
   it is not forgotten.
7. **shellcheck's version differs between here and the runner.** The severity
   table in `shell.yml` was measured on 0.11.0; the runner image ships an
   older one (firetv's proven lane records 0.9.0). SC2027 exists in both, and
   the first real run confirmed it — 0 findings, exit 0. Kept here because the
   next person to change that `--severity`/`--exclude` pair should know the two
   versions are not the same.
8. **`"type": "module"` changed what `node --check` means, and it found a real
   break in `admin.js`.** With no `package.json`, node had to guess at a bare
   `.js`, and the sweep passed on all 32 files. With `"type": "module"` node
   reads every tracked `.js` as an ES module — which is honest, since
   `index.html` loads them as modules — and the sweep is stricter. It went red
   immediately on **`admin.js` line 139**: `return \`` and, at line 146,
   `` \`; `` — a template literal whose backticks carry a stray backslash each,
   left behind by a heredoc. That file had never been valid JavaScript in any
   mode; the ambiguous parse simply never reached line 139. Measured 3 Sep
   2026: sweep with no `package.json` 0 failures, with it exactly 1, and the
   one is real. Both backslashes are deleted on this branch and the sweep is
   green over 35 files.

   `admin.js` is dead code — `index.html` does not load it (checked), `sw.js`
   does not precache it, `build-tvs.sh` excludes it, and `assets.py` asserts
   all three. So the fix cannot change the site. Its OTHER defect is
   untouched and still real: line 1 imports a `getConfig` that `locker.js`
   does not export.
9. **`node_modules` now exists in the working tree, and `rsync -a` reads the
   working tree.** This is trap 1 wearing new clothes, and it would have been
   the fourth time. `build-tvs.sh` already excluded `node_modules` — that one
   was luck, and it was never asserted — but not `package.json`,
   `package-lock.json` or `scripts`. All four are in the rsync list now and
   all four are asserted by `.github/checks/assets.py`, so none can quietly
   fall out. A playwright install is over 100 MB before a browser lands in it;
   that is what nearly went onto a television.

   The Pages artifact is safe for a different reason, not an exclude:
   `deploy` is a separate job on a clean runner that checks out and never runs
   `npm ci`, so no `node_modules` exists there to upload.
10. **`upload-pages-artifact@v3` would publish `.claude/handoff.md`; `@v5`
    does not.** Read from each tag's own `action.yml` on 3 Sep 2026 rather
    than assumed. v3.0.1 tars with `--exclude=.git --exclude=.github` and
    nothing else, so every other dotfile is uploaded and served. v5.0.0 adds
    `--exclude=.[^/]*` whenever `include-hidden-files` is false, its default.
    This repo tracks `.claude/handoff.md` — 6.7 KB of internal engineering
    notes, trap 6 above — which under v3 would be served at
    `kaoz625.github.io/blazing-web/.claude/handoff.md`. That is why this lane
    pins v5 while GitHub's own starter workflow
    (`actions/starter-workflows`, `pages/static.yml`) pins v3, and it is the
    only pin here that departs from that starter. Nothing the app loads is a
    dotfile: `index.html` names 16 relative paths and not one starts with a
    dot.
11. **The five checks are now written in two places.** `pages.yml`'s `gate`
    repeats the `run:` lines from `assets.yml`, `manifests.yml`, `syntax.yml`,
    `python.yml` and `shell.yml` verbatim, because `needs:` cannot reach
    across workflow files and those five still have to run on pull requests
    where `pages.yml` does not. **Change a check and change it in both**, or
    the gate and the lane will disagree about what green means.
