/* Kids age groups on the web (BLZ-0055), tested without a browser.
 *
 * Markus, 18 Oct 2026: "Set the Kids profile to 7-9 (drop TV-PG shows) and make
 * the Fire TV app respect the age group first, then web and Roku". The rules live
 * twice here (profile.js, which reads the profile, and app.js, which filters every
 * row), so this pins BOTH to the same answers and to firetv KidsAgeBandTest.kt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const profileSource = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function loadProfileRules() {
  const node = () => ({
    append() {}, appendChild() {}, replaceChildren() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, style: {}, children: [], hidden: false, textContent: '',
  });
  const document = {
    readyState: 'complete', head: node(), body: node(), createElement: node,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  const window = {
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, location: { href: 'https://example.test/app/', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.runInNewContext(profileSource, {
    window, document, localStorage, sessionStorage: localStorage,
    CustomEvent, URL, console, fetch: async () => { throw new Error('no network in this test'); },
    AbortController, Intl, Date, encodeURIComponent, navigator: { userAgent: 'test' },
  });
  return window.BlazingProfile.rules;
}

/** app.js's copies, lifted out of the file so they run exactly as written. */
function loadAppRules() {
  const pick = (re) => {
    const m = appSource.match(re);
    assert.ok(m, `app.js still has ${re}`);
    return m[0];
  };
  const code = [
    pick(/const KIDS_AGE_BANDS = \[[^\]]*\];/),
    pick(/const DEFAULT_KIDS_AGE_BAND = '[a-z]+';/),
    pick(/const AGE_BAND_ORDER = \[[^\]]*\];/),
    pick(/function profileAgeBand\(isKids, raw\) \{[\s\S]*?\n\}/),
    pick(/function ageBandAllows\(ageBand, band\) \{[\s\S]*?\n\}/),
    'globalThis.rules = { profileAgeBand, ageBandAllows };',
  ].join('\n');
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.rules;
}

const profileRules = loadProfileRules();
const appRules = loadAppRules();

test('a profile reads its age group the way the fleet does', () => {
  for (const [effective, label] of [[profileRules.effectiveAgeBand, 'profile.js'], [appRules.profileAgeBand, 'app.js']]) {
    assert.equal(effective(false, 'kids'), null, `${label}: a grown-up profile has no age group`);
    assert.equal(effective(true, undefined), 'tween', `${label}: nothing stored is the fleet default 10-12`);
    assert.equal(effective(true, null), 'tween', label);
    assert.equal(effective(true, 'kids'), 'kids', label);
    assert.equal(effective(true, 'teen'), 'little', `${label}: not a kids band reads as the youngest`);
  }
});

test('7-9 drops TV-PG; 10-12 keeps what general always allowed; both files agree', () => {
  const cases = [
    // [profile band, title band, allowed]
    ['kids', 'tween', false],   // WWE Raw, Coronation Street: TV-PG
    ['kids', 'little', true],   // Chibi Maruko-chan: TV-G
    ['kids', 'kids', true],     // TV-Y7
    ['kids', 'teen', false],
    ['kids', '', false],        // no band under a younger group is refused
    ['tween', 'tween', true],
    ['tween', '', true],        // the default keeps the pre-band behaviour
    ['tween', 'teen', false],
    ['little', 'kids', false],
    ['little', 'little', true],
    [null, 'mature', true],     // grown-ups: the tier cap alone decides
  ];
  for (const [ageBand, band, want] of cases) {
    assert.equal(profileRules.bandAllowed(ageBand, band), want, `profile.js ${ageBand}/${band}`);
    assert.equal(appRules.ageBandAllows(ageBand, band), want, `app.js ${ageBand}/${band}`);
  }
});

test('every rating check in app.js passes the title band along', () => {
  const bare = appSource.match(/ratingAllowed\(\w+\.contentRating\)/g) || [];
  assert.deepEqual(bare, [], 'a check that drops the band lets TV-PG past a 7-9 profile');
  assert.match(appSource, /safeMeta[\s\S]{0,4000}ageBand: plainText\(raw\.ageBand\)/, 'safeMeta keeps the band');
});
