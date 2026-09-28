// A row the debrid service must download first never leads a row that starts now.
//
// 28 Sep 2026, Toy Story 5 on the web: an UNCACHED 2.9 GB 4K AV1 torrent row
// (`_start: 'uncached'`, set by the add-on's stream-normalise.js) out-scored every
// ready row on a browser that decodes AV1 and E-AC-3. Play opened it, the debrid
// add-on answered with its 30-second "Downloading to Store" status clip, the
// player ran that clip to the end twice, and no error ever fired, so the failover
// never moved on. The rows below are that list's shape, cut down to the four
// kinds that decide the order.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const context = { window: {} };
vm.runInNewContext(await readFile(new URL('./caps.js', import.meta.url), 'utf8'), context);
const Caps = context.window.BlazingCaps;

// A browser that decodes 4K AV1 and Dolby audio: Safari on M3/A17 Pro and newer,
// or Edge with AV1 hardware. The uncached row only led on caps like these.
const yes = { aac: true, mp3: true, opus: true, vorbis: true, flac: true, pcm: true, ac3: true, eac3: true, dts: false, truehd: false };
const caps = {
  h264: true, h264Smooth: true, h264Hw: true, hevc: true, hevcSmooth: true, hevcHw: true,
  vp9: true, vp9Smooth: true, av1: true, av1Smooth: true, av1Hw: true,
  h2644k: true, hevc4k: true, av14k: true, hlsNative: true, hlsJs: true,
  highBitrateOk: false, maxSizeGb: 20, maxHeight: 2160, audioFile: yes, audioMse: yes,
};

const uncached = {
  _from: 'Debridio (Real-Debrid)', _start: 'uncached', _cached: false,
  name: '[RD] \nDebridio 4k DV|HDR',
  title: 'Toy.Story.5.2026.MULTI.VF2.2160p.WEBRip.DV.HDR10.EAC3.5.1.AV1-FDRY\n 📺 4k 💾 2.90 GB 👤 38',
  url: 'https://addon.lyreosai.com/play/UNCACHED',
};
const cached = {
  _from: 'StremThru Torz (Real-Debrid)', _start: 'cached', _cached: true,
  name: '[RD+]\nTorz\n1080p',
  title: 'Toy.Story.5.2026.1080p.WEB-DL.H264.AAC.mp4 📦 2.1 GB',
  url: 'https://addon.lyreosai.com/play/CACHED',
};
const direct = {
  _from: 'PenguPlay', _start: 'direct', _cached: true,
  name: 'PenguPlay 720p',
  title: 'Toy Story 5 (2026) 720p HLS',
  url: 'https://addon.lyreosai.com/play/DIRECT.m3u8',
};

const rank = (rows, opts = {}) => Caps.rankStreams(rows, caps, { deadLinks: [], inspected: () => false, ...opts }).streams;
// Spread into this realm's Array: caps.js runs in a vm context, and
// deepStrictEqual fails an array from another realm on its prototype alone.
const order = (rows, opts) => [...rank(rows, opts).map((i) => i.raw.url.split('/').pop())];

test('an uncached 4K row ranks below a cached 1080p row and a direct 720p row', () => {
  assert.deepEqual(order([uncached, cached, direct]), ['CACHED', 'DIRECT.m3u8', 'UNCACHED']);
});

test('the boolean twin alone is enough (`_cached: false` with no `_start`)', () => {
  const { _start, ...twinOnly } = uncached;
  assert.equal(order([twinOnly, cached])[0], 'CACHED');
});

test('an uncached row is kept, not removed: alone it is still the one to try', () => {
  assert.deepEqual(order([uncached]), ['UNCACHED']);
});

test('an uncached row still ranks above a dead link', () => {
  assert.deepEqual(order([cached, uncached], { deadLinks: [cached.url] }), ['UNCACHED', 'CACHED']);
});

test('rows with no cache verdict at all are not treated as uncached', () => {
  const unknown = { ...cached, _start: undefined, _cached: undefined, url: 'https://addon.lyreosai.com/play/UNKNOWN' };
  const info = rank([unknown])[0];
  assert.equal(info.uncached, false);
});
