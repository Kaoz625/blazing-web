import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./media-library.js', import.meta.url), 'utf8');
const mature = { id: 'profile-a', maxRating: 'mature', isKids: false };
const album = { id: 'archive:owned-music', title: 'An actual album', creator: 'Test artist' };
const book = { id: 'gutenberg:11', title: 'Alice', authors: ['Lewis Carroll'], formats: { text: 'https://www.gutenberg.org/a.txt' } };
const tracks = [{ id: 'audio-1', title: 'First track', url: 'https://audio.example.org/first.mp3' }, { id: 'audio-2', title: 'Next track', url: 'https://audio.example.org/next.mp3' }];
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Audio extends EventTarget {
  constructor() { super(); this.src = ''; this.currentTime = 0; this.duration = NaN; this.paused = true; this.loads = 0; this.plays = 0; this.behavior = null; }
  play() { this.plays++; if (this.behavior) return this.behavior(); this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.loads++; }
  removeAttribute(name) { if (name === 'src') { this.src = ''; this.currentTime = 0; this.duration = NaN; } }
  metadata(duration = 120) { this.duration = duration; this.dispatchEvent(new Event('loadedmetadata')); }
  matches(selector) { return selector === 'audio' || selector === '.media-audio-element'; }
  querySelectorAll() { return []; }
  get textContent() { return ''; }
}
function fixture(saved = new Map(), frames = null) {
  const document = new EventTarget(), window = new EventTarget(), audios = [];
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.className = ''; this.value = ''; this._text = ''; this.hidden = false;
      this.scrollHeight = 1200; this.clientHeight = 200; this.scrollTop = 0;
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); } };
    }
    append(...nodes) { for (const child of nodes) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...nodes) { this.children.forEach((child) => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName.toLowerCase() === selector; }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { this.dispatchEvent(new Event('click')); }
  }
  document.body = new Element('body'); document.activeElement = document.body;
  document.createElement = (tag) => { if (tag === 'audio') { const audio = new Audio(); audios.push(audio); return audio; } return new Element(tag); };
  const store = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  vm.runInNewContext(source, { window, document, localStorage: store, CustomEvent, URL, AbortController, setTimeout, clearTimeout,
    requestAnimationFrame: (callback) => frames ? frames.push(callback) : queueMicrotask(callback), console });
  const host = new Element('section'), playerHost = new Element('aside'); document.body.append(host, playerHost);
  const selected = (profile) => document.dispatchEvent(new CustomEvent('blazing-profile-selected', { detail: profile }));
  const signedOut = () => document.dispatchEvent(new CustomEvent('blazing-profile-signed-out'));
  return { api: window.BlazingMediaLibrary, document, window, Element, audios, host, playerHost, saved, store, selected, signedOut };
}
function playerFixture(options = {}) {
  const f = fixture(options.saved), audio = new Audio(), changes = [], starts = [];
  const player = f.api.core.createAudioPlayer({ audio, store: f.store, resolveItems: options.resolveItems || (async () => ({ id: album.id, items: tracks })),
    onChange: (data) => changes.push(plain(data)), onStart: () => starts.push(true) });
  return { ...f, audio, player, changes, starts };
}

test('unknown-age libraries fail closed for guests, teens, kids and effective account caps', () => {
  const { core } = fixture().api;
  for (const profile of [null, {}, { ...mature, id: {} }, { ...mature, maxRating: 'teen' }, { ...mature, isKids: true }, { ...mature, effectiveMaxRating: 'general' }]) assert.equal(Boolean(core.profileAllowed(profile)), false);
  assert.equal(core.profileAllowed(mature), true); assert.equal(core.profileAllowed({ ...mature, maxRating: 'adult', allowAdult: false }), true);
});

test('one player has real queue controls, seeks, moves on end, and saves completed tracks at zero', async () => {
  const f = playerFixture(); f.player.setProfile(mature);
  assert.equal(f.player.setQueue(tracks, 'audio-1', 'music', album.id), true); await flush();
  assert.equal(f.player.snapshot().phase, 'playing'); assert.equal(f.audio.src, tracks[0].url);
  f.audio.metadata(); f.player.seek(40); assert.equal(f.audio.currentTime, 40);
  f.player.pause(); assert.equal(f.player.snapshot().phase, 'paused');
  await f.player.play(); assert.equal(f.player.snapshot().phase, 'playing');
  f.audio.currentTime = 120; f.audio.dispatchEvent(new Event('ended')); await flush();
  assert.equal(f.audio.src, tracks[1].url); assert.equal(f.player.snapshot().index, 1);
  f.audio.metadata(90); f.player.seek(90); f.audio.dispatchEvent(new Event('ended')); f.player.flush(); f.player.pause();
  assert.equal(f.player.snapshot().phase, 'ended'); assert.equal(f.audio.plays, 3);
  const progress = f.api.core.readProgress(f.store, mature.id);
  assert.equal(progress.audio['audio-1'], 0); assert.equal(progress.audio['audio-2'], 0);
  assert.equal(f.starts.length, 3); assert.doesNotMatch([...f.saved.values()].join(''), /https:/, 'saved state has IDs, not expiring links');
});

test('profile switch and sign-out stop audio; resume resolves fresh URLs only for the chosen profile', async () => {
  const requested = [];
  const f = playerFixture({ resolveItems: async (kind, id) => { requested.push([kind, id]); return { id, items: [{ ...tracks[0], url: 'https://audio.example.org/renewed.mp3' }] }; } });
  f.player.setProfile(mature); f.player.setQueue(tracks, 0, 'music', album.id); await flush(); f.audio.metadata(); f.player.seek(32);
  f.player.setProfile({ ...mature, id: 'profile-b' });
  assert.equal(f.audio.src, ''); assert.equal(f.player.snapshot().last, null); assert.equal(await f.player.resume(), false);
  f.player.setProfile(mature); assert.equal(f.audio.src, '', 'selecting a profile never starts audio');
  assert.equal(await f.player.resume(), true); f.audio.metadata();
  assert.equal(f.audio.src, 'https://audio.example.org/renewed.mp3'); assert.equal(f.audio.currentTime, 32);
  assert.deepEqual(requested, [['music', album.id]]);
  f.player.setProfile(null); assert.equal(f.audio.src, ''); assert.equal(f.player.snapshot().queue.length, 0);
});

test('late play failure cannot replace a new profile and late resume cannot start old audio', async () => {
  const play = deferred(), lookup = deferred(); const f = playerFixture({ resolveItems: () => lookup.promise });
  f.player.setProfile(mature); f.audio.behavior = () => play.promise; f.player.setQueue(tracks, 0, 'music', album.id);
  f.player.setProfile({ ...mature, id: 'profile-b' }); play.reject(new Error('old failure')); await flush();
  assert.equal(f.player.snapshot().phase, 'idle'); assert.equal(f.player.snapshot().message, '');
  f.audio.behavior = null; f.player.setProfile(mature); const pending = f.player.resume();
  f.player.setProfile({ ...mature, id: 'profile-b' }); lookup.resolve({ items: tracks });
  assert.equal(await pending, false); assert.equal(f.audio.src, ''); assert.equal(f.player.snapshot().profileId, 'profile-b');
});

test('media error is visible and retry reloads; invalid URLs and absent saved tracks do not start substitutes', async () => {
  const f = playerFixture(); f.player.setProfile(mature);
  f.player.setQueue([...tracks, { id: 'bad', url: 'javascript:alert(1)' }], 0, 'music', album.id); await flush();
  assert.equal(f.player.snapshot().queue.length, 2);
  f.audio.dispatchEvent(new Event('error')); assert.match(f.player.snapshot().message, /could not be played/);
  const before = f.audio.loads; await f.player.play(); assert.equal(f.audio.loads, before + 1);
  assert.equal(f.player.setQueue(tracks, 'not-the-saved-track', 'music', album.id), false);
  assert.equal(f.audio.src, ''); assert.equal(f.player.snapshot().track, null);
});

test('Pause wins over an in-flight Play promise and Close hides the player without erasing later resume', async () => {
  const job = deferred(), f = playerFixture(); f.player.setProfile(mature); f.audio.behavior = () => job.promise;
  f.player.setQueue(tracks, 0, 'music', album.id); f.player.pause(); job.resolve(); await flush();
  assert.equal(f.player.snapshot().phase, 'paused');
  f.player.clear(); assert.equal(f.player.snapshot().track, null); assert.equal(f.player.snapshot().last, null);
  f.player.setProfile(mature); assert.equal(f.player.snapshot().last.trackId, 'audio-1');
});

test('pending audio metadata preserves resume position and a changed parent identity is refused', async () => {
  const f = playerFixture({ resolveItems: async () => ({ id: 'archive:wrong-album', items: tracks }) });
  f.player.setProfile(mature); f.player.setQueue(tracks, 0, 'music', album.id); await flush(); f.audio.metadata(); f.player.seek(50);
  f.player.setProfile(mature); f.player.setQueue(tracks, 0, 'music', album.id); f.player.clear();
  assert.equal(f.api.core.readProgress(f.store, mature.id).audio['audio-1'], 50);
  f.player.setProfile(mature); assert.equal(await f.player.resume(), false); assert.equal(f.audio.src, '');
  assert.match(f.player.snapshot().message, /could not be reached/);
});

test('progress ignores malformed data and keeps bounds without joining profile stores', () => {
  const f = fixture(new Map([['blazing-media-progress-v1:broken', '{oops']]));
  assert.equal(f.api.core.readProgress(f.store, 'broken').last, null);
  for (let id = 1; id <= 55; id++) f.api.core.writeProgress(f.store, 'a', (value) => { value.books[`gutenberg:${id}`] = { ratio: 0.5, title: 'Book', at: id }; });
  assert.equal(Object.keys(f.api.core.readProgress(f.store, 'a').books).length, 50);
  assert.equal(Object.keys(f.api.core.readProgress(f.store, 'b').books).length, 0);
});

test('mount before selection does not fetch; selected effective Mature profile loads actual cards', async () => {
  const f = fixture(), calls = [];
  f.api.mount('books', { host: f.host, playerHost: f.playerHost, request: async (path) => { calls.push(path); return { items: [book] }; } });
  assert.equal(calls.length, 0); assert.match(f.host.textContent, /Choose a Mature or Adult profile/);
  f.selected(mature); await flush();
  assert.equal(calls.length, 1); assert.equal(f.host.querySelectorAll('.media-library-card').length, 1);
  assert.match(calls[0], /^\/media\/books\?q=&limit=24$/);
  f.selected({ ...mature, effectiveMaxRating: 'teen' }); await flush();
  assert.equal(calls.length, 1); assert.equal(f.host.querySelectorAll('.media-library-card').length, 0);
});

test('late library replies are discarded after profile changes, route leave, or newer searches', async () => {
  const f = fixture(), pending = [];
  const request = (path, options) => { const job = deferred(); pending.push({ ...job, path, signal: options.signal }); return job.promise; };
  f.api.mount('books', { host: f.host, playerHost: f.playerHost, profile: mature, request });
  const form = f.host.querySelector('form'), input = f.host.querySelector('input'); input.value = 'new'; form.dispatchEvent(new Event('submit'));
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ items: [{ ...book, title: 'Newest result' }] }); await flush(); pending[0].resolve({ items: [book] }); await flush();
  assert.match(f.host.textContent, /Newest result/); assert.equal(f.host.querySelectorAll('.media-library-card').length, 1);
  input.value = 'other'; form.dispatchEvent(new Event('submit')); f.signedOut();
  pending[2].resolve({ items: [book] }); await flush(); assert.equal(f.host.querySelectorAll('.media-library-card').length, 0);
  f.selected(mature); f.api.leave(); pending[3].resolve({ items: [book] }); await flush();
  assert.equal(f.host.querySelectorAll('.media-library-card').length, 0);
});

test('plain text reader restores per-profile position, closes on sign-out, and keeps result cards working', async () => {
  const f = fixture(); let reads = 0;
  f.api.core.writeProgress(f.store, mature.id, (value) => { value.books[book.id] = { ratio: 0.35, title: 'Alice', at: 1 }; });
  f.api.mount('books', { host: f.host, playerHost: f.playerHost, profile: mature, request: async (path) => {
    if (path.endsWith('/text')) { reads++; return { id: book.id, title: 'Alice', text: '<script>This is literal book text</script>\nChapter One', truncated: false }; }
    return { items: [book] };
  } }); await flush();
  const card = f.host.querySelector('.media-library-card'); card.focus(); card.click(); await flush();
  const reader = f.host.querySelector('.media-book-text'); assert.equal(reader.scrollTop, 350); assert.equal(reader.children.length, 0);
  assert.match(reader.textContent, /<script>/); reader.scrollTop = 620; reader.dispatchEvent(new Event('scroll'));
  f.api.closeReader(); assert.equal(f.document.activeElement, card); card.click(); await flush();
  assert.equal(reads, 2); assert.equal(f.host.querySelector('.media-book-text').scrollTop, 620);
  f.signedOut(); assert.equal(f.host.querySelector('dialog'), null);
  assert.equal(f.api.core.readProgress(f.store, mature.id).books[book.id].ratio, 0.62);
  assert.equal(f.api.core.readProgress(f.store, 'profile-b').books[book.id], undefined);
});

test('late book content cannot reopen after switching profile and errors offer an actual retry', async () => {
  const f = fixture(), read = deferred(); let tries = 0;
  f.api.mount('books', { host: f.host, playerHost: f.playerHost, profile: mature, request: async (path) => {
    if (path.endsWith('/text')) return read.promise;
    if (++tries === 1) throw new Error('source-timeout'); return { items: [book] };
  } }); await flush();
  assert.match(f.host.textContent, /could not be reached/); f.host.querySelector('.media-library-status').querySelector('button').click(); await flush();
  assert.equal(tries, 2); f.host.querySelector('.media-library-card').click(); f.selected({ ...mature, id: 'profile-b' });
  read.resolve({ id: book.id, title: 'Old private read', text: 'Old text', truncated: false }); await flush();
  assert.equal(f.host.querySelector('dialog'), null); assert.doesNotMatch(f.host.textContent, /Old private read/);
});

test('closing a book before its first layout frame preserves the saved reading position', async () => {
  const frames = [], f = fixture(new Map(), frames);
  f.api.core.writeProgress(f.store, mature.id, (value) => { value.books[book.id] = { ratio: 0.6, title: 'Alice', at: 1 }; });
  f.api.mount('books', { host: f.host, playerHost: f.playerHost, profile: mature, request: async (path) => path.endsWith('/text')
    ? { id: book.id, title: 'Alice', text: 'A full text fixture', truncated: false } : { items: [book] } });
  await flush(); f.host.querySelector('.media-library-card').click(); await flush();
  assert.equal(frames.length, 1); f.api.closeReader(); frames[0]();
  assert.equal(f.api.core.readProgress(f.store, mature.id).books[book.id].ratio, 0.6);
});

test('music and podcasts use encoded authenticated routes; persistent controls survive leaving and stop on sign-out', async () => {
  const f = fixture(), paths = [], videoPauses = [];
  const request = async (path) => { paths.push(path); return path.includes('/tracks') ? { ...album, items: tracks } : { items: [album] }; };
  f.selected(mature); // Module can hear the profile before its first mount.
  f.api.mount('music', { host: f.host, playerHost: f.playerHost, profile: mature, request, pauseVideo: () => videoPauses.push(true) }); await flush();
  f.host.querySelector('.media-library-card').click(); await flush(); f.host.querySelector('.media-track-list').querySelector('button').click(); await flush();
  assert.ok(paths.includes('/media/music/archive%3Aowned-music/tracks')); assert.equal(f.audios.length, 1); assert.equal(f.playerHost.hidden, false);
  const play = f.playerHost.querySelector('.primary-button'); assert.equal(play.textContent, 'Pause'); play.click(); assert.equal(play.textContent, 'Play');
  play.click(); await flush(); f.api.leave(); assert.equal(f.audios[0].paused, false); assert.equal(videoPauses.length, 2);
  f.api.pause(); assert.equal(f.audios[0].paused, true);
  f.signedOut(); assert.equal(f.audios[0].src, ''); assert.equal(f.playerHost.hidden, true); assert.equal(f.playerHost.querySelector('ol').children.length, 0);
  f.api.mount('podcasts', { host: f.host, playerHost: f.playerHost, profile: mature, request: async (path) => {
    paths.push(path); return path.includes('/episodes') ? { id: 'itunes:123', title: 'A show', items: tracks } : { items: [{ id: 'itunes:123', title: 'A show' }] };
  } }); await flush(); f.host.querySelector('.media-library-card').click(); await flush();
  assert.ok(paths.includes('/media/podcasts/itunes%3A123/episodes')); assert.equal(f.audios.length, 1);
});

test('initial query uses the search endpoint; chosen items open by validated ID without repeating search', async () => {
  const f = fixture(), paths = [], services = { host:f.host, playerHost:f.playerHost, profile:mature, request:async path => {
    paths.push(path);
    if (path.endsWith('/text')) return { id:book.id,title:book.title,text:'A complete selected book.',truncated:false };
    if (path.endsWith('/tracks')) return { id:album.id,title:album.title,items:tracks };
    if (path.endsWith('/episodes')) return { id:'itunes:123',title:'Selected show',items:tracks };
    return { items:[book] };
  } };
  f.api.mount('books',{...services,initialQuery:'Alice in Wonderland'}); await flush();
  assert.deepEqual(paths,['/media/books?q=Alice%20in%20Wonderland&limit=24']);
  assert.equal(f.host.querySelector('input').value,'Alice in Wonderland');
  paths.length=0;
  f.api.mount('books',{...services,initialQuery:'Alice',initialItem:{...book,type:'book'}}); await flush();
  assert.deepEqual(paths,['/media/books/gutenberg%3A11/text']);
  assert.equal(f.host.querySelector('.media-book-text').textContent,'A complete selected book.');
  f.api.closeReader();
  assert.equal(f.document.activeElement,f.host.querySelector('.media-library-card'));
  paths.length=0;
  f.api.mount('music',{...services,initialItem:{...album,type:'album'}}); await flush();
  assert.deepEqual(paths,['/media/music/archive%3Aowned-music/tracks']);
  assert.equal(f.host.querySelector('.media-track-list').children.length,2);
  paths.length=0;
  f.api.mount('podcasts',{...services,initialItem:{id:'itunes:123',type:'podcast',title:'Selected show'}}); await flush();
  assert.deepEqual(paths,['/media/podcasts/itunes%3A123/episodes']);
});

test('initial item rejects mismatched kinds and IDs; late selected book cannot replace a newer choice', async () => {
  const f = fixture(), paths = [], first = deferred(), other = {...book,id:'gutenberg:1342',title:'Pride'};
  const services={host:f.host,playerHost:f.playerHost,profile:mature,request:async path=>{
    paths.push(path); return path.includes('1342') ? {id:other.id,title:other.title,text:'Pride text',truncated:false} : first.promise;
  }};
  for(const item of [album,{...book,type:'album'},{...book,id:'gutenberg:11/../../x'},{...book,title:''}]) {
    f.api.mount('books',{...services,initialItem:item}); await flush();
    assert.match(f.host.textContent,/selection is not available/);
  }
  assert.equal(paths.length,0);
  f.api.mount('books',{...services,initialItem:book});
  f.api.mount('books',{...services,initialItem:other}); await flush();
  first.resolve({id:book.id,title:book.title,text:'Old Alice text',truncated:false}); await flush();
  assert.equal(f.host.querySelector('.media-book-text').textContent,'Pride text');
  f.signedOut();
  f.api.mount('books',{...services,profile:null,initialItem:book}); await flush();
  assert.equal(paths.length,2); assert.equal(f.host.querySelector('dialog'),null);
  assert.match(f.host.textContent,/Choose profile/);
});

test('permission failures offer profile or sign-in actions for catalog, reader, tracks and saved audio', async () => {
  for(const [route,item,error,label] of [
    ['books',null,{status:401},'Sign in'], ['books',book,{code:'profile_locked'},'Choose profile'],
    ['music',album,{status:403},'Choose profile'], ['podcasts',{id:'itunes:123',title:'Show'},{status:403},'Choose profile'],
  ]) {
    const f=fixture();let opened=0;f.window.BlazingProfile={open:()=>opened++};
    f.api.mount(route,{host:f.host,playerHost:f.playerHost,profile:mature,initialItem:item,request:async()=>{throw error;}});await flush();
    const action=f.host.querySelector('.media-library-status').querySelector('button');
    assert.equal(action.textContent,label); action.click(); assert.equal(opened,1);
    assert.doesNotMatch(f.host.textContent,/Try again/); assert.equal(f.host.querySelector('.media-library-card'),null);
  }
  const f=fixture();let opened=0;f.window.BlazingProfile={open:()=>opened++};
  f.api.core.writeProgress(f.store,mature.id,value=>{value.last={kind:'music',parentId:album.id,trackId:tracks[0].id,title:'Saved track'};});
  f.api.mount('music',{host:f.host,playerHost:f.playerHost,profile:mature,request:async path=>{
    if(path.endsWith('/tracks'))throw {status:403,code:'profile_locked'};return {items:[]};
  }});await flush();
  f.playerHost.querySelector('.primary-button').click();await flush();
  const action=f.playerHost.querySelector('.primary-button');assert.equal(action.textContent,'Choose profile');
  action.click();assert.equal(opened,1);assert.equal(f.audios[0].src,'');
});

test('unlock expiry closes the reader, stops shared audio and rejects late content until profile reselect', async () => {
  const f=fixture(), late=deferred();let hold=false,calls=0,opened=0;
  f.window.BlazingProfile={open:()=>opened++};
  const services={host:f.host,playerHost:f.playerHost,profile:mature,request:async path=>{
    calls++; if(path.endsWith('/tracks'))return {...album,items:tracks};
    if(path.endsWith('/text'))return hold?late.promise:{id:book.id,title:book.title,text:'Complete text',truncated:false};return {items:[book]};
  }};
  f.api.mount('music',{...services,initialItem:album});await flush();f.host.querySelector('.media-track-list').querySelector('button').click();await flush();
  f.api.mount('books',{...services,initialItem:book});await flush();assert.ok(f.host.querySelector('dialog'));assert.ok(f.audios[0].src);
  const expire=()=>f.document.dispatchEvent(new CustomEvent('blazing-profile-unlock-expired'));
  expire();assert.equal(f.host.querySelector('dialog'),null);assert.equal(f.audios[0].src,'');assert.equal(f.playerHost.hidden,true);
  const before=calls;f.host.querySelector('.media-library-status').querySelector('button').click();assert.equal(opened,1);assert.equal(calls,before);
  hold=true;f.api.mount('books',{...services,initialItem:book});expire();late.resolve({id:book.id,title:book.title,text:'Stale content',truncated:false});await flush();
  assert.equal(f.host.querySelector('dialog'),null);assert.doesNotMatch(f.host.textContent,/Stale content/);
});
