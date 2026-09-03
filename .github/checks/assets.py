#!/usr/bin/env python3
"""Nothing the app loads has gone missing, and nothing that ships drops it.

Run it by hand exactly as CI does, from the repo root:

    python3 .github/checks/assets.py

Standard library only, plus `git ls-files`. No network, no dependency.

WHY THIS EXISTS. blazing-web has no bundler and no build step, so there is no
tool anywhere that resolves a reference. index.html names eleven scripts as
plain strings; sw.js names fifteen shell files as plain strings; the PWA
manifest names four icons as plain strings; and build-tvs.sh decides, by an
rsync exclude list, which of them reach a television. Rename or delete a file
and every one of those strings goes on looking perfectly correct.

Each of the four checks below is a failure that has actually happened here:

  1. sw.js's own comment records emby.js sitting outside the SHELL list while
     index.html loaded it, reaching devices "through the HTTP cache alone".
  2. build-tvs.sh's header records two releases that packaged the wrong set of
     files, because the exclude list and reality had drifted.
  3. GitHub Pages serves this directory verbatim, so a reference to a file
     that does not exist is a plain 404 in production.
  4. admin.js is dead code — build-tvs.sh strips it because it imports a
     `getConfig` that locker.js does not export. If index.html ever loaded it,
     the site would work and every TV package would not.
"""
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

failures: list[str] = []
warnings: list[str] = []


def bad(msg: str) -> None:
    failures.append(msg)
    print(f'FAIL {msg}')


def ok(msg: str) -> None:
    print(f'ok   {msg}')


def warn(msg: str, where: str) -> None:
    warnings.append(msg)
    print(f'WARN {msg}')
    print(f'::warning file={where}::{msg}')


tracked = set(
    subprocess.run(['git', 'ls-files'], capture_output=True, text=True, check=True)
    .stdout.split()
)
print(f'INFO {len(tracked)} tracked files')

html = Path('index.html').read_text()
# Every relative src/href in index.html. Absolute URLs are deliberately out of
# scope: reaching a production host from CI is banned here.
refs = sorted({m.group(1).split('?')[0]
               for m in re.finditer(r'(?:src|href)="\./([^"]+)"', html)})
scripts = sorted({m.group(1).split('?')[0]
                  for m in re.finditer(r'<script[^>]*src="\./([^"]+)"', html)})
print(f'INFO index.html: {len(refs)} relative refs, {len(scripts)} scripts')
if len(refs) < 10:
    bad(f'only {len(refs)} relative refs found in index.html — the regex has '
        f'stopped matching, so this whole check has quietly become a no-op')
# The SCRIPT count needs its own floor, and it is not covered by the one above.
# `refs` matches any src= or href=, so it stays healthy even when every
# <script> tag is gone; `scripts` is what check 3 compares against sw.js's
# SHELL. With scripts empty, `missing` is empty, and check 3 would then report
# all four pinned names as "fixed, delete the pin" — red, but for a reason
# that sends the reader to the wrong file. Measured 2 Sep 2026: index.html
# holds 11.
if len(scripts) < 8:
    bad(f'only {len(scripts)} <script src="./..."> tags found in index.html — '
        f'the regex has stopped matching, so the precache check below is '
        f'comparing against nothing')

# ── 1. index.html references a file that exists ─────────────────────────────
for ref in refs:
    if ref in tracked:
        ok(f'index.html -> {ref}')
    else:
        bad(f'index.html loads ./{ref}, which is NOT a tracked file — a 404 on the live site')

# ── 2. sw.js's SHELL list references files that exist ───────────────────────
sw = Path('sw.js').read_text()
block = re.search(r'const SHELL = \[(.*?)\];', sw, re.S)
shell: list[str] = []
if not block:
    bad('sw.js has no `const SHELL = [...]` block — it was renamed, and this '
        'check has become a no-op')
else:
    shell = [e for e in re.findall(r"'\./([^']*)'", block.group(1)) if e]
    ok(f'sw.js SHELL parsed: {len(shell)} named files (plus \'./\')')
    if len(shell) < 10:
        bad(f'only {len(shell)} entries parsed out of sw.js SHELL — the regex '
            f'has stopped matching')

for entry in shell:
    if entry in tracked:
        ok(f'sw.js SHELL -> {entry}')
    else:
        bad(f'sw.js precaches ./{entry}, which is NOT a tracked file — every '
            f'install() fetch for it 404s')

# ── 3. index.html's scripts are all precached ───────────────────────────────
# THE emby.js BUG, and it is currently live four times over.
#
# A script index.html loads but sw.js does not precache still works online.
# It breaks when the app is installed and offline, and — worse — it can be
# served from a DIFFERENT vintage than app.js, because it reaches the device
# through the browser's own HTTP cache instead of the versioned shell cache.
# That is the recorded blazingstream failure: a fresh index.html above a
# four-hour-old app.js, the app calling the wrong host.
#
# MEASURED 2 Sep 2026 on a clean `git archive HEAD` export: four of the eleven
# scripts index.html loads are absent from SHELL — dpad.js, games.js, manga.js
# and tv-comics-reader.js.
#
# So the repo is already in the state this check exists to catch, and a hard
# failure would land the lane RED on day one. The four are pinned below
# instead. THE POINT OF PINNING RATHER THAN WARNING: a FIFTH script added
# tomorrow and left out of SHELL is a HARD FAILURE, from day one, with no
# further work. The list can only shrink.
#
# To clear one: add './<name>' to SHELL in sw.js, bump the CACHE version — a
# shell file changing without a bump is the exact staleness sw.js's own header
# warns about — and delete the name here. This check fails if a name is still
# listed after it has been fixed, so the list cannot rot.
KNOWN_MISSING_FROM_SHELL = {
    'dpad.js',
    'games.js',
    'manga.js',
    'tv-comics-reader.js',
}

if shell:
    missing = {s for s in scripts if s not in shell}
    for name in sorted(missing - KNOWN_MISSING_FROM_SHELL):
        bad(f'index.html loads ./{name} and sw.js does not precache it. Add '
            f'\'./{name}\' to SHELL in sw.js and bump CACHE. This is the '
            f'emby.js bug: it works online and serves a stale copy to every '
            f'installed app.')
    for name in sorted(KNOWN_MISSING_FROM_SHELL - missing):
        bad(f'./{name} is pinned in KNOWN_MISSING_FROM_SHELL in this file but '
            f'is now in sw.js SHELL. Delete it from that set.')
    for name in sorted(KNOWN_MISSING_FROM_SHELL & missing):
        warn(f'./{name} is loaded by index.html and NOT precached by sw.js '
             f'(known gap, pinned in .github/checks/assets.py)', 'sw.js')
    if not missing:
        ok(f'all {len(scripts)} of index.html\'s scripts are in sw.js SHELL')
    else:
        ok(f'{len(scripts) - len(missing)} of {len(scripts)} scripts precached; '
           f'{len(missing)} known gaps, 0 new')

# ── 4. the PWA manifest's own references ────────────────────────────────────
pwa = json.loads(Path('manifest.webmanifest').read_text())
for icon in pwa.get('icons', []):
    src = icon['src'].removeprefix('./')
    if src in tracked:
        ok(f'manifest icon -> {src}')
    else:
        bad(f'manifest.webmanifest names icon ./{src}, which is NOT a tracked file')
start = pwa.get('start_url', '').removeprefix('./')
if start in tracked:
    ok(f'manifest start_url -> {start}')
else:
    bad(f'manifest.webmanifest start_url is ./{start}, which is NOT a tracked file')

# ── 5. build-tvs.sh still ships everything the app loads ────────────────────
# The dockerfile-copy-test of this repo. build-tvs.sh rsyncs a staged copy and
# names what to leave out; leave out something index.html loads and the .ipk
# and .wgt boot to a black screen with nothing in any log.
build = Path('build-tvs.sh').read_text()
# COMMENT LINES ARE STRIPPED FIRST, and that is not tidiness.
# build-tvs.sh's header discusses its own exclude list in prose, and it quotes
# the flag verbatim ("--exclude '.git' is an exact name and does NOT match
# .github"). Matching the raw file therefore counted `.git` twice on 2 Sep
# 2026 — harmless that day, but it means a check that a name is excluded could
# be satisfied by a SENTENCE ABOUT excluding it while the rsync itself does
# not, which is the one way this check could pass and be wrong. Only the code
# is parsed.
build_code = '\n'.join(line for line in build.splitlines()
                       if not line.lstrip().startswith('#'))
excludes = re.findall(r"--exclude '([^']+)'", build_code)
print(f'INFO build-tvs.sh rsync excludes: {excludes}')
if len(excludes) < 8:
    bad(f'only {len(excludes)} rsync excludes parsed out of build-tvs.sh — the '
        f'regex has stopped matching, so this check has become a no-op')

dropped = [(path, pat)
           for path in sorted(set(refs) | set(shell))
           for pat in excludes
           if fnmatch.fnmatch(path, pat)]
for path, pat in dropped:
    bad(f'build-tvs.sh excludes "{pat}", which drops {path} — a file the app '
        f'loads. Every LG .ipk and Samsung .wgt built from this tree is broken.')
if not dropped:
    ok(f'none of the {len(set(refs) | set(shell))} files the app loads are '
       f'dropped by build-tvs.sh')

if 'admin.js' not in excludes:
    bad('build-tvs.sh no longer excludes admin.js. It is dead code that '
        'imports a getConfig locker.js does not export — a trap inside a TV '
        'package. Either keep excluding it or delete the file.')
else:
    ok('build-tvs.sh still excludes admin.js')

# ── 6. the non-app directories stay out of the TV packages ──────────────────
# The bug build-tvs.sh's header records twice, caught a third time on 2 Sep
# 2026 while this CI was being written.
#
# An rsync --exclude with no slash matches a BASENAME, and it matches it
# exactly. `--exclude '.git'` therefore does NOT match `.github`, so the day
# this repo gained a CI directory, `rsync -a --dry-run --itemize-changes` with
# the then-current list copied all seven of its files into the staged copy —
# and `--exclude '*.md'` dropped the workflows README, which is precisely how
# a leak like this looks half-clean and gets waved through.
#
# `__pycache__` is the same shape from the other direction: `git status` does
# not show it any more (it is gitignored), but `rsync -a` reads the working
# tree, not the index, so any `python -m py_compile` leaves bytecode that
# ships to a television.
#
# Neither directory is app code. Both are asserted here rather than trusted,
# because the two recorded failures were both someone trusting this list.
#
# The last four arrived with the package.json that let the *.smoke.mjs
# harnesses run on a runner. `node_modules` was already in the rsync list but
# was never ASSERTED, and it is the most expensive name here by far: a
# playwright install is over 100 MB before a browser is downloaded into it.
# `package.json`, `package-lock.json` and `scripts` are small, and they are on
# the list for the same reason `.github` is — none of them is app code, and a
# television has no use for a test runner.
for name, what in (
    ('.github', 'this CI directory — workflow yaml and check scripts'),
    ('__pycache__', 'python bytecode left in the working tree by py_compile'),
    ('node_modules', 'the npm dependency tree — playwright, over 100 MB'),
    ('package.json', 'the npm manifest, which exists only for the smoke tests'),
    ('package-lock.json', 'the npm lockfile'),
    ('scripts', 'the smoke-test runner'),
):
    if name not in excludes:
        bad(f'build-tvs.sh does not exclude "{name}" from its rsync, so '
            f'{what} is packaged into every LG .ipk and Samsung .wgt. Note '
            f'that "--exclude \'.git\'" does NOT cover ".github": an rsync '
            f'exclude with no slash matches the basename exactly.')
    else:
        ok(f'build-tvs.sh excludes {name}')
if 'admin.js' in refs:
    bad('index.html now loads ./admin.js, which build-tvs.sh strips from every '
        'TV package. The website would work and every television would not.')
else:
    ok('index.html does not load admin.js')

print()
print(f'{len(failures)} failure(s), {len(warnings)} warning(s)')
sys.exit(1 if failures else 0)
