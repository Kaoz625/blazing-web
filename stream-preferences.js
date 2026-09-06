/* Profile language preferences and the tracks a source actually exposes. */
'use strict';
(() => {
  const KEY = 'blazing-stream-preferences-v1:';
  const CHANGE = 'blazing-stream-preferences-changed';
  const DEFAULTS = Object.freeze({ audio: 'english', subtitles: 'english' });
  const normalize = (value) => ({
    audio: ['english', 'any'].includes(value?.audio) ? value.audio : DEFAULTS.audio,
    subtitles: ['english', 'any', 'off'].includes(value?.subtitles) ? value.subtitles : DEFAULTS.subtitles,
  });
  const english = (track) => {
    const language = String(track?.lang || track?.language || '').trim();
    return language && language !== 'und' ? /^(en|eng)(?:[-_]|$)/i.test(language)
      : /\benglish\b/i.test(String(track?.name || track?.label || ''));
  };
  const label = (track, kind, index) => String(track?.name || track?.label || track?.lang || track?.language || `${kind} ${index + 1}`).slice(0, 100);
  const parameters = (value) => {
    const prefs = normalize(value);
    return `audio=${prefs.audio === 'english' ? 'en' : 'any'}&sub=${prefs.subtitles === 'english' ? 'en' : prefs.subtitles}`;
  };
  const list = (value) => Array.from(value || []);
  let profileId = null;
  let profileGeneration = 0;
  let preferences = { ...DEFAULTS };
  let detailHost = null;
  let playerCleanup = null;
  const current = () => ({ profileId, ...preferences });
  const query = () => profileId ? parameters(preferences) : '';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function selectControl(parent, title, values, value, change, className) {
    const wrapper = element('label', 'stream-preference-field');
    wrapper.append(element('span', '', title));
    const select = element('select', className || 'stream-preference-select');
    select.setAttribute('aria-label', title);
    for (const [id, text] of values) {
      const option = element('option', '', text); option.value = String(id); select.append(option);
    }
    select.value = String(value);
    select.addEventListener('change', () => change(select.value));
    wrapper.append(select); parent.append(wrapper);
    return select;
  }
  function save(change) {
    if (!profileId) return;
    preferences = normalize({ ...preferences, ...change });
    try { localStorage.setItem(KEY + encodeURIComponent(profileId), JSON.stringify(preferences)); } catch { /* Session still works without storage. */ }
    document.dispatchEvent(new CustomEvent(CHANGE, { detail: current() }));
  }
  function renderDetail() {
    if (!detailHost) return;
    detailHost.replaceChildren();
    if (!profileId) return;
    const mountedGeneration = profileGeneration;
    const update = (change) => { if (profileGeneration === mountedGeneration) save(change); };
    const fields = element('div', 'stream-preferences');
    selectControl(fields, 'Preferred audio', [['english', 'English'], ['any', 'Any language']], preferences.audio, (audio) => update({ audio }));
    selectControl(fields, 'Preferred subtitles', [['english', 'English'], ['any', 'Any language'], ['off', 'Off']], preferences.subtitles, (subtitles) => update({ subtitles }));
    detailHost.append(fields);
  }
  function mountDetail(host) {
    if (detailHost && detailHost !== host) detailHost.replaceChildren();
    detailHost = host || null; renderDetail();
    return () => { if (detailHost === host) { host.replaceChildren(); detailHost = null; } };
  }
  function resetPlayer() {
    const cleanup = playerCleanup; playerCleanup = null;
    cleanup?.();
  }
  function bindPlayer(video, hls) {
    resetPlayer();
    const bar = video?.closest?.('.player')?.querySelector('.player-bar');
    if (!profileId || !video || !bar) return () => {};
    const boundProfile = profileId;
    const host = element('div', 'stream-track-controls');
    host.setAttribute('aria-label', 'Audio and subtitles');
    bar.append(host);
    let stopped = false, queued = false, manualAudio = false, manualSubtitles = false, failure = '';
    let audioSelect = null, subtitleSelect = null;
    const listeners = [];
    const hasHlsAudio = () => Boolean(hls?.audioTracks?.length);
    const hasHlsSubtitles = () => Boolean(hls?.subtitleTracks?.length);
    const tracks = () => ({
      audio: hasHlsAudio() ? list(hls.audioTracks) : list(video.audioTracks),
      subtitles: hasHlsSubtitles() ? list(hls.subtitleTracks) : list(video.textTracks).filter((track) => ['subtitles', 'captions'].includes(track.kind)),
    });
    const audioIndex = (items) => hasHlsAudio() ? hls.audioTrack : items.findIndex((track) => track.enabled);
    const subtitleIndex = (items) => hasHlsSubtitles() ? (hls.subtitleDisplay === false ? -1 : hls.subtitleTrack) : items.findIndex((track) => track.mode === 'showing');
    function chooseAudio(index, items) {
      if (!Number.isInteger(index) || !items[index]) return false;
      try {
        if (hasHlsAudio()) hls.audioTrack = index;
        else items.forEach((track, i) => { track.enabled = i === index; });
        if (audioIndex(items) !== index) throw new Error('Unavailable');
        failure = ''; return true;
      } catch { failure = 'Audio switching is not available for this source.'; return false; }
    }
    function chooseSubtitles(index, items) {
      if (!Number.isInteger(index) || (index !== -1 && !items[index])) return false;
      try {
        if (hasHlsSubtitles()) { hls.subtitleTrack = index; hls.subtitleDisplay = index !== -1; }
        else items.forEach((track, i) => { track.mode = i === index ? 'showing' : 'disabled'; });
        if (subtitleIndex(items) !== index) throw new Error('Unavailable');
        failure = ''; return true;
      } catch { failure = 'Subtitle switching is not available for this source.'; return false; }
    }
    function refresh() {
      if (stopped || profileId !== boundProfile) return;
      const found = tracks();
      if (!manualAudio && preferences.audio === 'english') {
        const index = found.audio.findIndex(english);
        if (index !== -1 && audioIndex(found.audio) !== index) chooseAudio(index, found.audio);
      }
      if (!manualSubtitles) {
        const index = preferences.subtitles === 'off' ? -1 : preferences.subtitles === 'english' ? found.subtitles.findIndex(english) : null;
        if (index !== null && (index !== -1 || preferences.subtitles === 'off') && subtitleIndex(found.subtitles) !== index) chooseSubtitles(index, found.subtitles);
      }
      const focused = document.activeElement === audioSelect ? 'audio' : document.activeElement === subtitleSelect ? 'subtitles' : '';
      host.replaceChildren(); audioSelect = null; subtitleSelect = null;
      if (found.audio.length) {
        audioSelect = selectControl(host, 'Audio track', found.audio.map((track, index) => [index, label(track, 'Audio', index)]), audioIndex(found.audio), (value) => {
          if (stopped || profileId !== boundProfile) return;
          manualAudio = true; chooseAudio(Number(value), tracks().audio); schedule();
        }, 'stream-audio-track');
        audioSelect.disabled = found.audio.length < 2;
      }
      if (found.subtitles.length) {
        subtitleSelect = selectControl(host, 'Subtitle track', [[-1, 'Off'], ...found.subtitles.map((track, index) => [index, label(track, 'Subtitles', index)])], subtitleIndex(found.subtitles), (value) => {
          if (stopped || profileId !== boundProfile) return;
          manualSubtitles = true; chooseSubtitles(Number(value), tracks().subtitles); schedule();
        }, 'stream-subtitle-track');
      }
      const message = failure || (video.readyState >= 1 && found.audio.length <= 1 && !found.subtitles.length ? 'This source exposes no alternate tracks.' : '');
      if (message) {
        const notice = element('span', 'stream-track-notice', message); notice.setAttribute('role', 'status'); host.append(notice);
      }
      if (focused === 'audio') audioSelect?.focus();
      else if (focused === 'subtitles') subtitleSelect?.focus();
    }
    function schedule() {
      if (queued || stopped) return;
      queued = true;
      queueMicrotask(() => { queued = false; refresh(); });
    }
    const listen = (target, event, callback) => {
      if (!target?.addEventListener) return;
      target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback));
    };
    for (const event of ['loadedmetadata', 'emptied']) listen(video, event, schedule);
    for (const target of [video.audioTracks, video.textTracks]) {
      for (const event of ['addtrack', 'removetrack', 'change']) listen(target, event, schedule);
    }
    if (hls?.on && hls?.off) {
      const events = window.Hls?.Events || {};
      for (const [key, fallback] of [['MANIFEST_PARSED', 'hlsManifestParsed'], ['AUDIO_TRACKS_UPDATED', 'hlsAudioTracksUpdated'], ['SUBTITLE_TRACKS_UPDATED', 'hlsSubtitleTracksUpdated'], ['AUDIO_TRACK_SWITCHED', 'hlsAudioTrackSwitched'], ['SUBTITLE_TRACK_SWITCH', 'hlsSubtitleTrackSwitch']]) {
        const event = events[key] || fallback;
        hls.on(event, schedule); listeners.push(() => hls.off(event, schedule));
      }
    }
    listen(document, CHANGE, () => { manualAudio = false; manualSubtitles = false; schedule(); });
    const cleanup = () => {
      if (stopped) return;
      stopped = true; listeners.forEach((remove) => remove()); host.remove();
    };
    playerCleanup = cleanup; refresh();
    return () => { cleanup(); if (playerCleanup === cleanup) playerCleanup = null; };
  }
  document.addEventListener('blazing-profile-selected', (event) => {
    ++profileGeneration;
    resetPlayer();
    profileId = typeof event.detail?.id === 'string' && event.detail.id.trim() ? event.detail.id : null;
    let stored;
    try { stored = profileId ? JSON.parse(localStorage.getItem(KEY + encodeURIComponent(profileId))) : null; } catch { /* Invalid storage uses defaults. */ }
    preferences = normalize(stored); renderDetail();
  });
  document.addEventListener('blazing-profile-signed-out', () => {
    ++profileGeneration;
    resetPlayer(); profileId = null; preferences = { ...DEFAULTS }; renderDetail();
  });
  window.BlazingStreamPreferences = Object.freeze({ current, query, mountDetail, bindPlayer, resetPlayer, core: Object.freeze({ normalize, english, label, parameters }) });
})();
