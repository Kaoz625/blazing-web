import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = { window: {} };
vm.runInNewContext(await readFile(new URL('./stream-evidence.js', import.meta.url), 'utf8'), context);
const api = context.window.BlazingStreamEvidence;
vm.runInNewContext(await readFile(new URL('./caps.js', import.meta.url), 'utf8'), context);
const caps = { maxHeight: 1080, maxSizeGb: 100, h264: true, hevc: false, highBitrateOk: true };
const now = Date.now();
const prefs = { audio: 'english', subtitles: 'english' };
const verification = { mode: 'media-v1', status: 'inspected', checkedAt: now, prefs: { wantEnglishAudio: true, wantEnglishSub: true }, coverage: { '1080p': { inspected: 1 } } };
const stream = () => ({ _verified: { mode: 'media-v1', checkedAt: now, quality: '1080p' }, _mediaEvidence: { kind: 'ffprobe-sample-v1', inspectedAt: now, bytes: 2048, video: { width: 1920, height: 1080, packets: 10, tier: '1080p' }, audio: [{ language: 'eng', packets: 3 }], subtitles: [{ language: 'en', packets: 2, forced: false }] } });
test('Measured sample is labelled with dimensions and reported languages', () => {
  assert.equal(api.inspected(stream(), verification, prefs, now), true);
  assert.match(api.description(stream(), verification, prefs, now), /1920 × 1080.*English audio listed.*English subtitles listed/);
});
test('A name, a check mark, or a proof marker alone cannot create a badge', () => {
  assert.equal(api.description({ name: '✓ 4K verified', _verified: stream()._verified }, verification, prefs, now), '');
});
test('Expired samples and a different preference response do not qualify', () => {
  assert.equal(api.inspected(stream(), verification, prefs, now + 900001), false);
  assert.equal(api.inspected(stream(), verification, { audio: 'any', subtitles: 'off' }, now), false);
});
test('Missing English packets and forced-only subtitles do not qualify', () => {
  const noAudio = stream(); noAudio._mediaEvidence.audio[0].packets = 0;
  assert.equal(api.inspected(noAudio, verification, prefs, now), false);
  const forced = stream(); forced._mediaEvidence.subtitles[0].forced = true;
  assert.equal(api.inspected(forced, verification, prefs, now), false);
});
test('360p cannot count as a measured480p stream', () => {
  const item = stream(); item._verified.quality = '480p'; item._mediaEvidence.video = { width: 640, height: 360, packets: 3, tier: '480p' };
  assert.equal(api.inspected(item, verification, prefs, now), false);
  item._mediaEvidence.video.height = 480;
  assert.equal(api.inspected(item, verification, prefs, now), true);
});
test('A contradictory tier marker cannot promote a smaller sample', () => {
  const item = stream();
  item._mediaEvidence.video.width = 640; item._mediaEvidence.video.height = 360;
  assert.equal(api.inspected(item, verification, prefs, now), false);
  item._mediaEvidence.video.width = 1280; item._mediaEvidence.video.height = 720;
  assert.equal(api.inspected(item, verification, prefs, now), false);
  item._mediaEvidence.video.width = 1920; item._mediaEvidence.video.height = 800;
  assert.equal(api.inspected(item, verification, prefs, now), true);
});
test('Coverage shows missing checks without inventing three working streams', () => {
  const items = api.coverage(verification, prefs, now);
  assert.equal(items[1].checked, 1); assert.equal(items[1].missing, 2);
  assert.equal(items[0].checked, 0); assert.equal(items[0].missing, 3);
  assert.equal(api.coverage({ mode: 'media-v1', status: 'not-checked' }, prefs, now), null);
});
test('Fresh measured video overrides a false4K HEVC name before device filtering', () => {
  const item = stream();
  Object.assign(item, { name: '4K HEVC', title: 'Movie.2160p.HEVC.RUS.DTS', url: 'https://media.invalid/video.mp4' });
  item._mediaEvidence.video.codec = 'h264';
  item._mediaEvidence.audio[0].codec = 'aac';
  const rank = (options) => context.window.BlazingCaps.rankStreams([item], caps, options);
  assert.equal(rank({}).streams.length, 0);
  const measured = rank({ inspected: (s) => api.inspected(s, verification, prefs, now) }).streams;
  assert.equal(measured.length, 1);
  assert.equal(measured[0].height, 1080);
  assert.equal(measured[0].codec, 'h264');
  assert.equal(measured[0].foreign, false);
  assert.equal(measured[0].audio, 'aac');
  assert.equal(rank({ inspected: (s) => api.inspected(s, verification, prefs, now + 900001) }).streams.length, 0);
});
test('Measured unsupported codec and dimensions still respect this device', () => {
  const item = stream();
  Object.assign(item, { name: '720p H264', url: 'https://media.invalid/video.mp4' });
  item._mediaEvidence.video.codec = 'hevc';
  const options = { inspected: (s) => api.inspected(s, verification, prefs, now) };
  assert.equal(context.window.BlazingCaps.rankStreams([item], caps, options).dropped.codec, 1);
  item._mediaEvidence.video.codec = 'h264';
  item._mediaEvidence.video.width = 3840;
  item._mediaEvidence.video.height = 2160;
  item._mediaEvidence.video.tier = '2160p'; item._verified.quality = '2160p';
  assert.equal(context.window.BlazingCaps.rankStreams([item], caps, options).dropped.res, 1);
});
