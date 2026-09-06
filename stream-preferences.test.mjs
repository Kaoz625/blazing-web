import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./stream-preferences.js', import.meta.url), 'utf8');
function fixture(saved = new Map()) {
  const document = new EventTarget();
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.className = ''; this.value = ''; this._text = ''; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach((node) => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
    set textContent(value) { this._text = value; }
    matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
    querySelector(selector) { for (const node of this.children) { if (node.matches(selector)) return node; const child = node.querySelector(selector); if (child) return child; } return null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    focus() { document.activeElement = this; }
  }
  document.createElement = (tag) => new Element(tag);
  document.activeElement = null;
  const window = {};
  const localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  vm.runInNewContext(source, { window, document, localStorage, CustomEvent, queueMicrotask, console });
  const selectProfile = (id) => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: { id } }));
  const change = (select, value) => { select.value = String(value); select.dispatchEvent(new Event('change')); };
  const player = () => {
    const root = new Element('section'); root.className = 'player';
    const bar = new Element('div'); bar.className = 'player-bar'; const video = new Element('video'); root.append(bar, video);
    video.audioTracks = []; video.textTracks = []; video.readyState = 0;
    return { root, bar, video };
  };
  return { api: window.BlazingStreamPreferences, document, Element, saved, selectProfile, change, player };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => queueMicrotask(resolve));
function hlsFixture(audioTracks = [], subtitleTracks = []) {
  const callbacks = new Map();
  return { audioTracks, subtitleTracks, audioTrack: 0, subtitleTrack: -1, subtitleDisplay: false,
    on(event, callback) { if (!callbacks.has(event)) callbacks.set(event, new Set()); callbacks.get(event).add(callback); },
    off(event, callback) { callbacks.get(event)?.delete(callback); },
    emit(event) { callbacks.get(event)?.forEach((callback) => callback()); },
    listeners() { return [...callbacks.values()].reduce((total, group) => total + group.size, 0); },
  };
}

test('defaults and server query are explicit; no profile cannot send preferences', () => {
  const { api, selectProfile } = fixture();
  assert.equal(api.query(), ''); assert.equal(api.current().profileId, null);
  selectProfile('actual-profile-a');
  assert.deepEqual(plain(api.current()), { profileId: 'actual-profile-a', audio: 'english', subtitles: 'english' });
  assert.equal(api.query(), 'audio=en&sub=en');
  assert.equal(api.core.parameters({ audio: 'any', subtitles: 'off' }), 'audio=any&sub=off');
  assert.deepEqual(plain(api.core.normalize({ audio: 'https://invalid.example/', subtitles: 'bad' })), { audio: 'english', subtitles: 'english' });
});

test('detail changes persist only enums for the actual profile and dispatch its identity', () => {
  const f = fixture(); f.selectProfile('profile/a'); const host = new f.Element('div'); f.api.mountDetail(host);
  const events = []; f.document.addEventListener('blazing-stream-preferences-changed', (event) => events.push(plain(event.detail)));
  const [audio, subtitles] = host.children[0].children.map((field) => field.querySelector('select'));
  f.change(audio, 'any'); f.change(subtitles, 'off');
  assert.equal(f.api.query(), 'audio=any&sub=off');
  assert.deepEqual(JSON.parse(f.saved.get('blazing-stream-preferences-v1:profile%2Fa')), { audio: 'any', subtitles: 'off' });
  assert.equal(events.length, 2); assert.equal(events[1].profileId, 'profile/a');
  assert.equal(f.saved.size, 1);
  f.selectProfile('profile-b'); assert.equal(f.api.query(), 'audio=en&sub=en');
  f.selectProfile('profile/a'); assert.equal(f.api.query(), 'audio=any&sub=off');
  f.document.dispatchEvent(new CustomEvent('blazing-profile-signed-out'));
  assert.equal(f.api.query(), ''); assert.equal(f.api.current().profileId, null); assert.equal(host.children.length, 0);
  const next = fixture(f.saved); next.selectProfile('profile/a'); assert.equal(next.api.query(), 'audio=any&sub=off');
});

test('malformed saved preferences and non-profile events cannot inherit another profile', () => {
  const f = fixture(new Map([['blazing-stream-preferences-v1:a', '{broken']]));
  f.selectProfile('a'); assert.equal(f.api.query(), 'audio=en&sub=en');
  f.selectProfile({ id: 'a' }); assert.equal(f.api.query(), '');
});

test('English detection uses real language or labels and does not invent a language', () => {
  const { core } = fixture().api;
  for (const track of [{ lang: 'en-US' }, { language: 'eng' }, { name: 'English CC' }]) assert.equal(core.english(track), true);
  for (const track of [{ lang: 'ja' }, { lang: 'fr', label: 'English' }, { label: 'Track 1' }, {}]) assert.equal(core.english(track), false);
  assert.equal(core.label({}, 'Audio', 0), 'Audio 1');
});

test('Hls menus use actual tracks, prefer English, and preserve a manual source choice', async () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player();
  const hls = hlsFixture([{ lang: 'ja', name: 'Japanese' }, { lang: 'eng', name: 'English dub' }], [{ lang: 'en', name: 'English captions' }]);
  f.api.bindPlayer(video, hls);
  assert.equal(hls.audioTrack, 1); assert.equal(hls.subtitleTrack, 0); assert.equal(hls.subtitleDisplay, true);
  const audio = bar.querySelector('.stream-audio-track');
  assert.equal(audio.children.length, 2); assert.deepEqual(audio.children.map((option) => option.textContent), ['Japanese', 'English dub']);
  audio.focus(); f.change(audio, 0); await flush(); hls.emit('hlsAudioTrackSwitched'); await flush();
  assert.equal(hls.audioTrack, 0); assert.equal(f.document.activeElement, bar.querySelector('.stream-audio-track'));
  assert.equal(f.api.current().audio, 'english');
});

test('tracks arriving after manifest load apply saved preferences; Off disables Hls captions', async () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player(); const hls = hlsFixture();
  f.api.bindPlayer(video, hls); assert.equal(bar.querySelector('.stream-audio-track'), null);
  assert.doesNotMatch(bar.textContent, /no alternate tracks/);
  hls.audioTracks = [{ lang: 'fr' }, { lang: 'en' }]; hls.subtitleTracks = [{ lang: 'en' }];
  hls.emit('hlsManifestParsed'); await flush(); assert.equal(hls.audioTrack, 1); assert.equal(hls.subtitleTrack, 0);
  const host = new f.Element('div'); f.api.mountDetail(host);
  f.change(host.children[0].children[1].querySelector('select'), 'off'); await flush();
  assert.equal(hls.subtitleTrack, -1); assert.equal(hls.subtitleDisplay, false);
  assert.equal(bar.querySelector('.stream-subtitle-track').value, '-1');
});

test('unavailable English keeps the actual audio and does not add a fake English option', () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player(); const hls = hlsFixture([{ lang: 'ja', name: 'Japanese' }]);
  video.readyState = 1;
  f.api.bindPlayer(video, hls); assert.equal(hls.audioTrack, 0);
  assert.equal(bar.querySelector('.stream-audio-track').children.length, 1);
  assert.equal(bar.querySelector('.stream-audio-track').disabled, true);
  assert.doesNotMatch(bar.textContent, /English/); assert.match(bar.textContent, /no alternate tracks/);
});

test('no-track notice waits for metadata and clears when the source is emptied', async () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player();
  f.api.bindPlayer(video);
  assert.equal(bar.querySelector('.stream-track-notice'), null);
  video.readyState = 1; video.dispatchEvent(new Event('loadedmetadata')); await flush();
  assert.match(bar.textContent, /no alternate tracks/);
  assert.equal(bar.querySelector('.stream-audio-track'), null);
  assert.equal(bar.querySelector('.stream-subtitle-track'), null);
  video.readyState = 0; video.dispatchEvent(new Event('emptied')); await flush();
  assert.equal(bar.querySelector('.stream-track-notice'), null);
});

test('native audio and captions switch; metadata tracks never appear as subtitles', async () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player();
  video.audioTracks = [{ language: 'ja', enabled: true }, { language: 'en', enabled: false }];
  video.textTracks = [{ kind: 'metadata', label: 'Chapters', mode: 'hidden' }, { kind: 'captions', language: 'en', mode: 'disabled' }, { kind: 'subtitles', language: 'fr', mode: 'disabled' }];
  f.api.bindPlayer(video);
  assert.equal(video.audioTracks[0].enabled, false); assert.equal(video.audioTracks[1].enabled, true);
  assert.equal(video.textTracks[1].mode, 'showing'); assert.equal(video.textTracks[0].mode, 'hidden');
  assert.equal(bar.querySelector('.stream-subtitle-track').children.length, 3);
  f.change(bar.querySelector('.stream-subtitle-track'), -1); await flush();
  assert.equal(video.textTracks[1].mode, 'disabled'); assert.equal(video.textTracks[2].mode, 'disabled');
  assert.equal(video.textTracks[0].mode, 'hidden');
});

test('unsupported native track changes show failure instead of claiming success', () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player();
  video.audioTracks = [Object.freeze({ language: 'ja', enabled: true }), Object.freeze({ language: 'en', enabled: false })];
  f.api.bindPlayer(video);
  assert.equal(video.audioTracks[0].enabled, true); assert.match(bar.textContent, /Audio switching is not available/);
  assert.equal(bar.querySelector('.stream-audio-track').value, '0');
});

test('Hls in-band captions fall back to actual native text tracks when no Hls subtitle list exists', () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player();
  video.textTracks = [{ kind: 'captions', language: 'en', label: 'English CC', mode: 'disabled' }];
  const hls = hlsFixture(); f.api.bindPlayer(video, hls);
  assert.equal(video.textTracks[0].mode, 'showing');
  assert.equal(bar.querySelector('.stream-subtitle-track').children[1].textContent, 'English CC');
  assert.equal(hls.subtitleTrack, -1);
});

test('profile switch and signout remove track menus and old Hls listeners', async () => {
  const f = fixture(); f.selectProfile('a'); const { bar, video } = f.player(); const hls = hlsFixture([{ lang: 'ja' }]);
  f.api.bindPlayer(video, hls); assert.ok(hls.listeners() > 0);
  f.selectProfile('b'); assert.equal(bar.children.length, 0); assert.equal(hls.listeners(), 0);
  hls.audioTracks.push({ lang: 'en' }); hls.emit('hlsAudioTracksUpdated'); await flush(); assert.equal(hls.audioTrack, 0);
  f.api.bindPlayer(video, hls); assert.equal(hls.audioTrack, 1);
  f.document.dispatchEvent(new CustomEvent('blazing-profile-signed-out'));
  assert.equal(bar.children.length, 0); assert.equal(hls.listeners(), 0); assert.equal(f.api.query(), '');
});

test('reset and cleanup from a previous player cannot remove a newer binding', () => {
  const f = fixture(); f.selectProfile('a'); const first = f.player(), second = f.player();
  const closeFirst = f.api.bindPlayer(first.video, hlsFixture()); f.api.bindPlayer(second.video, hlsFixture()); closeFirst();
  assert.equal(first.bar.children.length, 0); assert.equal(second.bar.children.length, 1);
  f.api.resetPlayer(); f.api.resetPlayer(); assert.equal(second.bar.children.length, 0);
});

test('queued changes from detached profile controls cannot change the new profile or old stream', () => {
  const f = fixture(); f.selectProfile('a'); const host = new f.Element('div'); f.api.mountDetail(host);
  const oldPreference = host.children[0].children[0].querySelector('select');
  const { bar, video } = f.player(); const hls = hlsFixture([{ lang: 'en' }, { lang: 'fr' }]); f.api.bindPlayer(video, hls);
  const oldTrack = bar.querySelector('.stream-audio-track');
  f.selectProfile('b'); f.change(oldPreference, 'any'); f.change(oldTrack, 1);
  assert.equal(f.api.query(), 'audio=en&sub=en'); assert.equal(hls.audioTrack, 0); assert.equal(f.saved.size, 0);
  f.selectProfile('a'); f.change(oldPreference, 'any');
  assert.equal(f.api.query(), 'audio=en&sub=en'); assert.equal(f.saved.size, 0);
});
