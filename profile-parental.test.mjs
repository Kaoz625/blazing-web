/* The parental rules in profile.js, tested without a browser.
 *
 * B1 / B3 / B15 / B28 put a rating cap, a Kids flag, an adult toggle, a PIN and
 * a Delete on the web for the first time. Every one of those is a decision, and
 * firetv keeps its copies in ProfileGateRules.kt precisely so they can be
 * reached by a test — its own header says why: "any rule left inline in
 * ProfileGateActivity is a rule with no test behind it. That is exactly how the
 * kids/adult interlock in the Add Profile form came to be wrong for weeks."
 *
 * profile.js is loaded in a vm with a document that has no .topbar, so buildUi()
 * returns false and boot() stops before it touches the network or the DOM —
 * window.BlazingProfile.rules is published either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./profile.js', import.meta.url), 'utf8');

function load() {
  const node = () => ({
    append() {}, appendChild() {}, replaceChildren() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, style: {}, children: [], hidden: false, textContent: '',
  });
  const document = {
    readyState: 'complete',
    head: node(),
    body: node(),
    createElement: node,
    getElementById: () => null,
    // No .topbar: buildUi() bails right after addStyle() and boot() returns.
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  const window = {
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, location: { href: 'https://example.test/app/', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  vm.runInNewContext(source, {
    window, document, localStorage, sessionStorage: localStorage,
    CustomEvent, URL, console, fetch: async () => { throw new Error('no network in this test'); },
    AbortController, Intl, Date, encodeURIComponent, navigator: { userAgent: 'test' },
  });
  return window.BlazingProfile.rules;
}

const rules = load();
/* The vm is a separate realm, so an object built in there has a different
   Object.prototype and deepStrictEqual refuses it on identity alone. Same
   round-trip stream-preferences.test.mjs uses for the same reason. */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the rating ladder is the fleet\'s, lowest first, and a cap admits what sits under it', () => {
  assert.deepEqual([...rules.RATINGS], ['general', 'teen', 'mature', 'adult']);
  assert.equal(rules.KIDS_CAP, 'general');
  assert.equal(rules.ratingAllowed('mature', 'teen'), true);
  assert.equal(rules.ratingAllowed('teen', 'mature'), false);
  assert.equal(rules.ratingAllowed('teen', 'teen'), true);
  assert.equal(rules.ratingAllowed('', 'general'), false, 'no cap is not a licence');
  assert.equal(rules.ratingAllowed('teen', 'nonsense'), false, 'an unknown tier is not a verdict');
});

test('a raise is what needs the PIN, and only a raise', () => {
  assert.equal(rules.raising('teen', 'adult'), true);
  assert.equal(rules.raising('teen', 'mature'), true);
  assert.equal(rules.raising('mature', 'teen'), false, 'tightening never asks for a PIN');
  assert.equal(rules.raising('teen', 'teen'), false);
  // An unknown current cap is index -1, so ANY real tier reads as a raise.
  // That is the safe direction: it asks for the PIN rather than skipping it.
  assert.equal(rules.raising('nonsense', 'general'), true);
});

test('THE KIDS INTERLOCK — a kids profile is pinned to KIDS_CAP with adult off, in the same request', () => {
  assert.deepEqual(plain(rules.newProfileFields(true, 'adult', true)), { isKids: true, maxRating: 'general', allowAdult: false });
  assert.deepEqual(plain(rules.newProfileFields(false, 'mature', true)), { isKids: false, maxRating: 'mature', allowAdult: true });
  assert.deepEqual(plain(rules.newProfileFields(false, 'nonsense', false)), { isKids: false, maxRating: 'teen', allowAdult: false },
    'an unrecognised rating falls back to the conservative default, not to the value sent');
  assert.equal(rules.newProfileFields(false, 'teen', 'yes').allowAdult, false, 'only true is true');
});

test('B15 — Delete is never offered on the last profile in the house', () => {
  assert.equal(rules.canDelete(0), false);
  assert.equal(rules.canDelete(1), false, 'a picker with zero rows is a broken picker, not an empty one');
  assert.equal(rules.canDelete(2), true);
});

test('B13 — grownUp() is the gate on where content comes from, and null is a no', () => {
  assert.equal(rules.grownUp(null), false);
  assert.equal(rules.grownUp(undefined), false);
  assert.equal(rules.grownUp({ isKids: true, maxRating: 'adult' }), false);
  assert.equal(rules.grownUp({ isKids: false, maxRating: 'teen' }), false);
  assert.equal(rules.grownUp({ isKids: false, maxRating: 'mature' }), true);
  assert.equal(rules.grownUp({ isKids: false, maxRating: 'adult' }), true);
});

test('avatarChange still only names a picture that actually changed', () => {
  assert.equal(rules.avatarChange('🦊', '🦊'), null);
  assert.equal(rules.avatarChange('🦊', '🐯'), '🐯');
  assert.equal(rules.avatarChange('', '🐯'), '🐯');
  assert.equal(rules.avatarChange('🦊', '   '), null);
});
