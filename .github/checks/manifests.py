#!/usr/bin/env python3
"""The three shipping manifests are well formed and carry what their platform requires.

Run it by hand exactly as CI does, from the repo root:

    python3 .github/checks/manifests.py

Standard library only. No network, no dependency, no pip install.

  config.xml            Samsung Tizen widget config, packaged by build-tvs.sh
  appinfo.json          LG webOS app metadata, read by ares-package
  manifest.webmanifest  the PWA manifest index.html links

WHY. All three are hand-edited data files that no tool in this repo validates.
A malformed one does not fail loudly: `tizen build-web` and `ares-package` are
run by hand, on Markus's machine, minutes before an install onto a television,
and a missing key there reads as "the TV rejected the package" with no clue
which line did it.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

W = 'http://www.w3.org/ns/widgets'
T = 'http://tizen.org/ns/widgets'
NS = {'w': W, 't': T}

failures: list[str] = []
warnings: list[str] = []


def bad(msg: str) -> None:
    failures.append(msg)
    print(f'FAIL {msg}')


def ok(msg: str) -> None:
    print(f'ok   {msg}')


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f'WARN {msg}')
    # A GitHub Actions annotation, so the gap is visible on the run page and
    # not only in a log nobody opens.
    print(f'::warning file=config.xml::{msg}')


# ── config.xml — Samsung Tizen ──────────────────────────────────────────────
root = None
try:
    root = ET.parse('config.xml').getroot()
    ok('config.xml parses as XML')
except Exception as exc:                                  # noqa: BLE001
    bad(f'config.xml does not parse: {exc}')

if root is not None:
    if root.tag != f'{{{W}}}widget':
        bad(f'config.xml root is {root.tag}, expected the widgets:widget element')
    else:
        ok('config.xml root is widgets:widget')

    app = root.find('t:application', NS)
    if app is None:
        bad('config.xml has no <tizen:application> — the TV cannot install the package')
    else:
        for attr in ('id', 'package', 'required_version'):
            if not app.get(attr):
                bad(f'<tizen:application> is missing the {attr} attribute')
            else:
                ok(f'<tizen:application> {attr}={app.get(attr)}')

    content = root.find('w:content', NS)
    if content is None or not content.get('src'):
        bad('config.xml has no <content src="..."> — the TV has no entry point')
    elif content.get('src') != 'index.html':
        bad(f'<content src> is {content.get("src")!r}, expected index.html')
    else:
        ok('<content src>=index.html')

    profile = root.find('t:profile', NS)
    if profile is None or profile.get('name') != 'tv':
        bad('config.xml has no <tizen:profile name="tv"> — this is a TV app')
    else:
        ok('<tizen:profile name="tv">')

    features = {f.get('name') for f in root.findall('w:feature', NS)}
    if 'http://tizen.org/feature/screen.size.all' not in features:
        bad('config.xml is missing <feature name=".../screen.size.all">')
    else:
        ok('<feature screen.size.all>')

    privileges = {p.get('name') for p in root.findall('t:privilege', NS)}
    if 'http://tizen.org/privilege/internet' not in privileges:
        bad('config.xml is missing the internet privilege — no network at all on a Samsung TV')
    else:
        ok('<tizen:privilege internet>')

    # THE <access> TRAP. This is the one this whole file was worth writing for.
    #
    # On Tizen the internet privilege alone is not enough. A widget may only
    # reach an origin that a <access origin="..."/> element names, and a
    # request to an origin outside that list is REFUSED SILENTLY — no error,
    # no console message, an app that simply shows nothing. It is recorded in
    # this workspace as a fault that cost real time on the Samsung build, and
    # no browser and no simulator can reproduce it.
    #
    # MEASURED 2 Sep 2026: config.xml has ZERO <access> elements. So a .wgt
    # built from this repo today reaches nothing.
    #
    # This is a WARNING and not a failure ONLY because the repo is already in
    # that state and a CI that is red on arrival gets scrolled past. It is a
    # real defect, it is named in .github/workflows/README.md, and the fix is
    # one line in config.xml:
    #
    #     <access origin="*" subdomains="true"/>
    #
    # or, tighter and better, one element per origin the app actually calls.
    # MEASURED 2 Sep 2026 by grepping every https:// host out of the tracked
    # non-smoke .js files: fleet.lyreosai.com (12 mentions),
    # addon.lyreosai.com (5), upscale.lyreosai.com (3), plus one each of
    # v3-cinemeta.strem.io and api.qrserver.com. blazingstream.lyreosai.com is
    # where the app is SERVED from, not a host it calls, so it does not belong
    # in the list. Streams and posters come from wherever those hosts point,
    # which is the argument for "*".
    #
    # WHEN THAT LINE LANDS, promote this to bad() and delete this comment.
    access = root.findall('w:access', NS)
    if not access:
        warn('config.xml has NO <access> element — a Samsung .wgt built from '
             'this repo can reach no origin, and it fails silently. See '
             '.github/workflows/README.md.')
    else:
        ok(f'<access> origins declared: '
           f'{[a.get("origin") for a in access]}')

# ── appinfo.json — LG webOS ─────────────────────────────────────────────────
webos = None
try:
    webos = json.loads(Path('appinfo.json').read_text())
    ok('appinfo.json parses as JSON')
except Exception as exc:                                  # noqa: BLE001
    bad(f'appinfo.json does not parse: {exc}')

if webos is not None:
    # ares-package refuses a package that is missing any of these. The list is
    # webOS's own required set, not a preference.
    for key in ('id', 'version', 'vendor', 'type', 'main', 'title', 'icon'):
        if key not in webos:
            bad(f'appinfo.json is missing the required key "{key}" — ares-package will refuse it')
        else:
            ok(f'appinfo.json {key}={webos[key]!r}')
    if webos.get('type') != 'web':
        bad(f'appinfo.json type is {webos.get("type")!r}, expected "web"')
    if webos.get('main') != 'index.html':
        bad(f'appinfo.json main is {webos.get("main")!r}, expected index.html')

# ── manifest.webmanifest — the PWA ──────────────────────────────────────────
pwa = None
try:
    pwa = json.loads(Path('manifest.webmanifest').read_text())
    ok('manifest.webmanifest parses as JSON')
except Exception as exc:                                  # noqa: BLE001
    bad(f'manifest.webmanifest does not parse: {exc}')

if pwa is not None:
    # The set a browser needs before it will offer to install the app at all.
    for key in ('name', 'short_name', 'start_url', 'scope', 'display', 'icons'):
        if key not in pwa:
            bad(f'manifest.webmanifest is missing the required key "{key}"')
        else:
            ok(f'manifest.webmanifest {key} present')
    if not pwa.get('icons'):
        bad('manifest.webmanifest has an empty icons array')
    for icon in pwa.get('icons', []):
        for key in ('src', 'sizes', 'type'):
            if key not in icon:
                bad(f'manifest.webmanifest icon {icon} is missing "{key}"')
    # A maskable icon is what stops Android and Chrome OS cropping the logo
    # into a circle. It is present today; keep it that way.
    if not any('maskable' in (i.get('purpose') or '') for i in pwa.get('icons', [])):
        bad('manifest.webmanifest has no icon with purpose "maskable"')
    else:
        ok('manifest.webmanifest has a maskable icon')

print()
print(f'{len(failures)} failure(s), {len(warnings)} warning(s)')
sys.exit(1 if failures else 0)
