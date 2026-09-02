# CI for blazing-web

The first CI this repo has had. Added 2 Sep 2026, on top of HEAD `fdad8b7`.

This branch also changes one file that is not CI: `build-tvs.sh`. Adding a
`.github/` directory to this repo broke that script, and the fix belongs with
the change that broke it. See trap 1 below.

blazing-web is the web app — the PWA that GitHub Pages serves, that
blazing-site copies to `blazingstream.lyreosai.com/app/`, and that
`build-tvs.sh` packages for LG webOS and Samsung Tizen. It has no bundler, no
`package.json`, no build step and, until today, nothing that read a file
before a browser or a television did. These five lanes are that reader.

## This repo is PUBLIC, and four things follow

Verified 2 Sep 2026 with `gh repo view Kaoz625/blazing-web --json visibility`:
`"visibility": "PUBLIC"`. The other Blazing repos are private. This one is
not, and every file in this directory is written for that.

1. **Actions minutes on `ubuntu-latest` are free.** Every lane still has a
   `paths:` filter, but the reason is no longer money. A run that cannot
   change its answer is noise: a queue slot taken from a run that can, a log
   nobody reads, a superseded run cancelled for nothing, and a green tick that
   says less each time it appears for a change it did not look at.
2. **Every CI log is world-readable.** Not "anyone signed in to the org" —
   anyone with the URL. So no step in this directory may ever print an
   environment, list a `HOME`, run `curl` with headers, dump a config, or echo
   anything that could carry a credential. There is no such step today; the
   rule is here so there is never one tomorrow. What each lane prints is
   written in its own `permissions:` comment.
3. **A pull request from a fork runs with a read-only token and no secrets.**
   Nothing here references `secrets.*`, so nothing here notices.
4. **GitHub Pages is live on this repo.** `build_type: legacy`, source branch
   `main`, path `/`, serving <https://kaoz625.github.io/blazing-web/> —
   verified 2 Sep 2026 with `gh api repos/Kaoz625/blazing-web/pages`. **Every
   push to `main` republishes that site.** So every workflow is
   `permissions: contents: read`, and there is no deploy step and no Pages
   step anywhere in this CI. The checks answer yes or no and stop.

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

## The lanes

| Workflow | Runs when | What it proves |
|---|---|---|
| `assets.yml` | any `.js`, `.png`, `.svg`, `.css`, `index.html`, `manifest.webmanifest`, `build-tvs.sh` | Every file index.html, sw.js and the PWA manifest name is a tracked file; every script index.html loads is precached by sw.js (4 known gaps pinned); build-tvs.sh's rsync excludes drop nothing the app loads, and still exclude `admin.js`, `.github` and `__pycache__`. 61 tracked files, 15 refs, 11 scripts, 15 SHELL entries, 15 rsync excludes, 0 failures, 4 warnings. |
| `manifests.yml` | `config.xml`, `appinfo.json`, `manifest.webmanifest` | The Tizen widget config, the webOS appinfo and the PWA manifest parse and carry every key their platform requires. 0 failures, 1 warning (the Tizen `<access>` gap, below). |
| `python.yml` | any `.py` | All 7 tracked python files compile: the 5 `patch_*.py` migrations and the 2 check scripts. `compile()`, never `py_compile`, so nothing writes `__pycache__`. |
| `shell.yml` | any `.sh` | shellcheck at `--severity=warning --exclude=SC2027` over `build-tvs.sh`, the TV release script. 0 findings. |
| `syntax.yml` | any `.js` or `.mjs` | `node --check` on all 32 tracked scripts, one process per file so the log names the broken one. |

Every number in that table was measured on a clean `git archive` export of
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
- **`permissions: contents: read`.** See "This repo is PUBLIC" above. Pages
  publishes from the branch; CI must never be a second publisher.
- **`concurrency` with `cancel-in-progress: true`.** So the tick on a PR is the
  tick for the commit that is there, not an older one that finished later.
- **`timeout-minutes: 5` on every job.** Every lane measures under 10 s; five
  minutes covers runner and image startup and stops a hung step from sitting
  on the 6-hour default.
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

## Deliberately not here

- **The 17 `*.smoke.mjs` browser harnesses.** They are the real test suite —
  the class of bug `node --check` cannot see, like a `textContent` write to an
  element `buildUi()` never created.

  **They cannot run on a GitHub runner, and the reason is structural, not a
  matter of minutes.** All 17 files were checked on 2 Sep 2026. Every one of
  them opens with

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
- **Running `build-tvs.sh`.** It needs `@webosose/ares-cli` and Tizen Studio's
  `tizen` binary, neither on a runner, and its output is a TV package that
  Markus installs by hand. The shell lane lints it; the assets lane guards its
  exclude list, which is where both of its recorded failures actually lived.
- **A GitHub Pages deploy step.** Pages already publishes `main` on its own.
  A second publisher in CI is a second way to ship the wrong thing, and it
  would need write permissions this CI refuses to hold.
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
   `61 tracked files`: 53 of them are the app, 8 are this directory. A future
   reader comparing against an older "53" is not looking at a regression.
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
