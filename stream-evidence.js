/* Describe the server's measured samples without promising full playback. */
'use strict';
(() => {
  const TIERS = ['2160p', '1080p', '720p', '480p'];
  const TTL = 15 * 60 * 1000;
  const tracks = (value) => Array.isArray(value) ? value : [];
  const fresh = (value, now) => Number.isFinite(value) && value <= now + 60000 && now - value < TTL;
  const english = (track) => /^(en|eng)(?:[-_]|$)/i.test(String(track?.language || '').trim()) && Number(track?.packets) > 0;
  function measuredTier(video) {
    const short = Math.min(video.width, video.height), long = Math.max(video.width, video.height);
    if (short < 480) return '';
    return long >= 3840 ? '2160p' : long >= 1920 ? '1080p' : long >= 1280 ? '720p' : '480p';
  }
  function matches(verification, preferences, now = Date.now()) {
    return verification?.mode === 'media-v1' && ['inspected', 'unproved'].includes(verification.status)
      && fresh(verification.checkedAt, now)
      && verification.prefs?.wantEnglishAudio === (preferences?.audio === 'english')
      && verification.prefs?.wantEnglishSub === (preferences?.subtitles === 'english');
  }
  function coverage(verification, preferences, now = Date.now()) {
    if (!matches(verification, preferences, now)) return null;
    return TIERS.map((quality) => {
      const raw = verification.coverage?.[quality]?.inspected;
      const checked = Number.isInteger(raw) ? Math.min(3, Math.max(0, raw)) : 0;
      return { quality, checked, requested: 3, missing: 3 - checked };
    });
  }
  function inspected(stream, verification, preferences, now = Date.now()) {
    if (!matches(verification, preferences, now) || verification.status !== 'inspected') return false;
    const proof = stream?._verified;
    const evidence = stream?._mediaEvidence;
    const video = evidence?.video;
    if (proof?.mode !== 'media-v1' || !TIERS.includes(proof.quality) || !fresh(proof.checkedAt, now)
      || evidence?.kind !== 'ffprobe-sample-v1' || !fresh(evidence.inspectedAt, now)
      || !(evidence.bytes > 0) || !(video?.packets > 0)
      || !Number.isInteger(video?.width) || !Number.isInteger(video?.height)
      || video.width < 1 || video.height < 1 || video.tier !== proof.quality) return false;
    if (measuredTier(video) !== proof.quality) return false;
    if (preferences.audio === 'english' && !tracks(evidence.audio).some(english)) return false;
    if (preferences.subtitles === 'english' && !tracks(evidence.subtitles).some((track) => english(track) && track.forced !== true)) return false;
    return true;
  }
  function description(stream, verification, preferences, now = Date.now()) {
    if (!inspected(stream, verification, preferences, now)) return '';
    const data = stream._mediaEvidence;
    const parts = [`Sample checked · ${data.video.width} × ${data.video.height}`];
    if (tracks(data.audio).some(english)) parts.push('English audio listed');
    if (tracks(data.subtitles).some((track) => english(track) && track.forced !== true)) parts.push('English subtitles listed');
    return parts.join(' · ');
  }
  function render(host, verification, preferences) {
    if (!host) return;
    host.replaceChildren();
    const items = coverage(verification, preferences);
    const status = document.createElement('p');
    status.className = 'stream-check-status';
    status.textContent = items ? 'Source sample checks' : 'Source samples have not been checked for these choices.';
    host.append(status);
    if (items) {
      const list = document.createElement('div'); list.className = 'stream-check-coverage';
      for (const item of items) {
        const entry = document.createElement('span');
        entry.textContent = `${item.quality === '2160p' ? '4K' : item.quality} · ${item.checked}/${item.requested}`;
        entry.title = `${item.checked} short samples checked; ${item.missing} still missing`;
        list.append(entry);
      }
      const note = document.createElement('p'); note.className = 'stream-check-note';
      note.textContent = 'These are short samples. Full playback is not confirmed.';
      host.append(list, note);
    }
  }
  window.BlazingStreamEvidence = Object.freeze({ coverage, inspected, description, render });
})();
