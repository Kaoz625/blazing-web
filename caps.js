/*
 * caps.js — what THIS browser, on THIS screen, on THIS link can actually decode,
 * and the ranking that turns a raw Stremio /stream list into rows it can play.
 *
 * NOTHING HERE IS CALIBRATED TO A PARTICULAR MACHINE. Every rule reads the
 * numbers the probe came back with, the same doctrine as the Roku's
 * DeviceCaps.brs ("NOTHING HERE IS CALIBRATED TO A PARTICULAR TV") and the Fire
 * TV's Device.kt. One build is served to a 4K desktop, a Retina laptop, an
 * Android phone and an LG webOS television out of the same GitHub Pages
 * directory, and the same file has to pick 4K HEVC on the first and 1080p H.264
 * on the last.
 *
 * WHY IT MATTERS MORE ON THE WEB THAN ANYWHERE ELSE. The six clients differ in
 * how badly they fail an undecodable file, and the browser fails worst:
 *   - Roku refuses the stream and shows an error.
 *   - ExoPlayer on the Fire TV plays the audio track over a black screen.
 *   - A browser given 4K HEVC it cannot decode does BOTH, silently and
 *     differently per engine: Chrome on Linux has no HEVC decoder at all and
 *     stalls at readyState 0, Safari decodes it fine, and Firefox's answer
 *     depends on the platform. The user sees a spinner that never ends and
 *     concludes the source list is broken.
 * So the codec gate below is not a nicety. It is the difference between a
 * shorter list and a dead player.
 *
 * THE FAILURE THIS IS WRITTEN AGAINST, and it has already happened once on this
 * fleet: the trailer resolver carried a flat `height<=1080` cap for EVERY
 * caller, written to protect one 921 MB Fire TV stick that hangs outright on a
 * 2160p decode. Correct for that stick, and it quietly held every 4K device on
 * the fleet to 1080p as well. One device's floor had become the fleet's ceiling.
 * Every ceiling in this file therefore travels with the device that measured it
 * and is never written down as a constant.
 *
 *
 * THE PROBE, in the order it is trusted
 * ─────────────────────────────────────
 * 1. navigator.mediaCapabilities.decodingInfo({type, video:{...}})
 *    The only API on any of our six clients that answers three questions rather
 *    than one: `supported` (will it decode at all), `smooth` (will it keep up at
 *    this size and framerate) and `powerEfficient` (is a hardware decoder doing
 *    it). That third one is the closest a browser gets to the Fire TV's
 *    MediaCodecInfo.isHardwareAccelerated, which is why it is asked for.
 *
 *    IT IS NOT USED AS A HARD GATE, and that is deliberate rather than timid.
 *    MEASURED, Chromium 147.0.7727.15 headless on this Mac, 3 Sep 2026, one
 *    decodingInfo call per line:
 *
 *      h264 1280x720   {supported:true,  smooth:true,  powerEfficient:false}
 *      h264 1920x1080  {supported:true,  smooth:true,  powerEfficient:false}
 *      vp9  1920x1080  {supported:true,  smooth:true,  powerEfficient:false}
 *      av1  1920x1080  {supported:true,  smooth:true,  powerEfficient:false}
 *      hevc 1920x1080  {supported:false, smooth:false, powerEfficient:false}
 *      hevc 3840x2160  {supported:false, smooth:false, powerEfficient:false}
 *      av1  3840x2160  {supported:true,  smooth:true,  powerEfficient:false}
 *
 *    EVERY line says powerEfficient:false, including plain H.264 at 720p, which
 *    this machine unquestionably decodes in hardware. It reports that way
 *    because no GPU video-decode stack is attached to a headless process, and
 *    plenty of real desktop Chrome builds answer the same for the same reason.
 *    A hard reject on powerEfficient would therefore have emptied the source
 *    list on a machine that plays everything — the fleet's-ceiling bug again,
 *    with a different sensor.
 *
 *    The HEVC lines are the other half of the same measurement and they are why
 *    `supported` IS trusted: this build has no HEVC decoder at all, so a 4K HEVC
 *    remux — the row that tops almost every debrid list — is a guaranteed dead
 *    player here, and it is the row a resolution-only filter would put first. So:
 *        supported === false   -> the row is REMOVED. This is a fact.
 *        smooth === false      -> the row is kept but cannot raise the 4K
 *                                 ceiling. This is the direct analogue of the
 *                                 Fire TV's videoCapabilities.isSizeSupported.
 *        powerEfficient        -> a SCORE, and a tie-break between two codecs
 *                                 at the same resolution. Never a veto.
 *
 * 2. HTMLMediaElement.canPlayType with FULL codec strings, for engines with no
 *    mediaCapabilities (Firefox shipped decodingInfo late; older WebKit and
 *    every webOS/Tizen browser predating it have none). A bare
 *    canPlayType('video/mp4') answers "maybe" for everything and is worth
 *    nothing — app.js already carries that scar in its HLS detection, where
 *    'video/mp4', 'application/x-mpegURL' and 'application/vnd.apple.mpegurl'
 *    all returned "maybe" on browsers that could play none of them. The codec
 *    parameter is the whole value of the call.
 *
 * 3. window.screen for the panel, navigator.deviceMemory for the RAM floor,
 *    navigator.connection for the link. Same three ceilings the Roku and the
 *    Fire TV read, through the only APIs a browser has for them.
 *
 * 4. MediaSource.isTypeSupported and HTMLMediaElement.canPlayType for AUDIO,
 *    which is the half this file did not have until 6 Sep 2026.
 *
 *    THE FAILURE IT IS WRITTEN AGAINST. Measured live on "Past Lives" in
 *    headless Comet: rows 1, 3 and 4 of the default list decoded megabytes of
 *    VIDEO with webkitAudioDecodedByteCount stuck at exactly 0, while row 2 —
 *    an AAC copy of the same film — decoded 173,511 bytes of audio in the SAME
 *    browser session. The picture was perfect and the film was silent.
 *
 *    NO ERROR EVENT FIRES FOR IT, and that is what makes it worse than the
 *    video case this file was built for. An undecodable VIDEO track stalls the
 *    element at readyState 0, so at least something is visibly wrong. An
 *    undecodable AUDIO track simply produces no sound: the video plays, the
 *    controls work, the mute button is off, and nothing anywhere says the app
 *    picked a file this browser cannot make a noise from.
 *
 *    Four codecs cause all of it — Dolby Digital (AC-3), Dolby Digital Plus
 *    (E-AC-3), DTS and TrueHD — and they sit on exactly the releases a
 *    resolution sort puts FIRST, because a remux is where lossless audio lives.
 *
 *    Until now the only defence was a -250/-700 score penalty guessed from the
 *    release name, and it was wrong twice over: it cannot outweigh a height*4
 *    resolution term, so it never kept a silent file out of first place; and it
 *    does not fire at all on a name that carries no audio tag.
 *
 *    IT IS A RUNTIME PROBE AND NEVER A HARDCODED BLOCKLIST, for the reason the
 *    header keeps repeating. Safari on a Mac DOES decode AC-3 and E-AC-3,
 *    because Apple ships those decoders with the OS. A hardcoded "browsers
 *    cannot play Dolby" list would take the best file on the fleet's most
 *    capable browser away and call it a fix — one device's floor becoming the
 *    fleet's ceiling, arriving through a third sensor.
 *
 *    BOTH APIs ARE ASKED, because they disagree. MEASURED, Comet 151 headless
 *    (a branded Chrome, so it has the proprietary decoders Chromium lacks) on
 *    this Mac, 6 Sep 2026:
 *
 *      audio/mp4; codecs="mp4a.40.2"   MSE true    canPlayType probably
 *      audio/mp4; codecs="opus"        MSE true    canPlayType probably
 *      audio/mp4; codecs="mp4a.69"     MSE FALSE   canPlayType probably
 *      audio/flac                      MSE FALSE   canPlayType probably
 *      audio/wav; codecs="1"           MSE FALSE   canPlayType probably
 *      audio/mp4; codecs="ac-3"        MSE false   canPlayType ""
 *      audio/mp4; codecs="ec-3"        MSE false   canPlayType ""
 *      audio/mp4; codecs="dtsc"        MSE false   canPlayType ""
 *      audio/mp4; codecs="dtse"        MSE false   canPlayType ""
 *      audio/mp4; codecs="dtsx"        MSE false   canPlayType ""
 *      audio/mp4; codecs="dtsh"        MSE false   canPlayType ""
 *      audio/mp4; codecs="mlpa"        MSE false   canPlayType ""
 *
 *    The three FALSE-but-probably lines are the whole reason both are asked.
 *    hls.js feeds every HLS manifest through MediaSource and a plain debrid
 *    file goes straight into the element, so a row is judged on the path it
 *    will really take rather than on whichever API answered first.
 *
 *    decodingInfo was measured here too and it answered the ELEMENT, line for
 *    line: supported:true for mp3-in-mp4, FLAC and PCM, false for all four
 *    Dolby and DTS spellings. It is not asked for audio because it adds no
 *    information over canPlayType and it is async. Unlike video, audio has no
 *    width, height or framerate, so canPlayType's one real weakness — that it
 *    cannot tell 1080p HEVC from 4K HEVC — has no equivalent on this side, and
 *    the audio probe stays synchronous and free.
 */
(function () {
  'use strict';

  /* The tiers a release is ever labelled with. Everything snaps to one of these
     so that a 1964-pixel Retina panel and a 1920-pixel monitor do not produce
     two different ceilings for the same set of files. */
  var TIERS = [2160, 1440, 1080, 720, 480];

  /* Representative streams to ask about. Width/height/bitrate/framerate are all
     REQUIRED by decodingInfo — leave one out and the promise rejects with a
     TypeError rather than answering, so a probe that "passes" while asking
     nothing is not possible here. The bitrates are the ones these tiers really
     arrive at from a debrid link, not round numbers: an 8 Mbit 1080p and a
     35 Mbit 2160p are what the ranking is going to be handed. */
  var PROBES = [
    { key: 'h264',  type: 'video/mp4; codecs="avc1.640028"',      w: 1920, h: 1080, br: 8000000,  fr: 24 },
    { key: 'hevc',  type: 'video/mp4; codecs="hvc1.1.6.L93.B0"',  w: 1920, h: 1080, br: 6000000,  fr: 24 },
    { key: 'vp9',   type: 'video/webm; codecs="vp09.00.31.08"',   w: 1920, h: 1080, br: 6000000,  fr: 24 },
    { key: 'av1',   type: 'video/mp4; codecs="av01.0.08M.08"',    w: 1920, h: 1080, br: 5000000,  fr: 24 }
  ];

  var PROBES_4K = [
    { key: 'h264',  type: 'video/mp4; codecs="avc1.640033"',      w: 3840, h: 2160, br: 45000000, fr: 24 },
    { key: 'hevc',  type: 'video/mp4; codecs="hvc1.1.6.L150.B0"', w: 3840, h: 2160, br: 35000000, fr: 24 },
    { key: 'vp9',   type: 'video/webm; codecs="vp09.00.50.08"',   w: 3840, h: 2160, br: 35000000, fr: 24 },
    { key: 'av1',   type: 'video/mp4; codecs="av01.0.12M.08"',    w: 3840, h: 2160, br: 25000000, fr: 24 }
  ];

  /* The audio codecs a release is ever labelled with, and every spelling of
     each one that a browser might answer differently about.

     SEVERAL TYPES PER KEY, ANY-OF. A key is a FAMILY, not a fourcc: a browser
     that decodes DTS core decodes the family for our purposes, and it is the
     family that a release name says. The measured table in the header is why
     the list is not one string per key — 'audio/mp4; codecs="mp4a.69"' is
     false under MSE on this machine while 'audio/mpeg' is true, and both of
     them mean MP3.

     THE FOUR THAT MATTER ARE LAST. ac3, eac3, dts and truehd are the codecs a
     browser fails silently on, and they are also the ones Safari may well say
     YES to. Nothing here decides anything; the browser does. */
  var AUDIO_PROBES = [
    { key: 'aac',    types: ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"', 'audio/aac'] },
    { key: 'mp3',    types: ['audio/mpeg', 'audio/mp4; codecs="mp4a.69"'] },
    { key: 'opus',   types: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'] },
    { key: 'vorbis', types: ['audio/webm; codecs="vorbis"'] },
    { key: 'flac',   types: ['audio/mp4; codecs="flac"', 'audio/flac'] },
    { key: 'pcm',    types: ['audio/wav; codecs="1"'] },
    { key: 'ac3',    types: ['audio/mp4; codecs="ac-3"'] },
    { key: 'eac3',   types: ['audio/mp4; codecs="ec-3"'] },
    { key: 'dts',    types: ['audio/mp4; codecs="dtsc"', 'audio/mp4; codecs="dtse"', 'audio/mp4; codecs="dtsx"', 'audio/mp4; codecs="dtsh"'] },
    { key: 'truehd', types: ['audio/mp4; codecs="mlpa"'] }
  ];

  /* What a family is called when the reason has to be shown to a person. */
  var AUDIO_LABELS = {
    aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', pcm: 'PCM',
    ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)',
    dts: 'DTS', truehd: 'Dolby TrueHD', atmos: 'Dolby Atmos'
  };

  /* A label that does not name its own codec, and the families it could be.
     "Atmos" rides on TrueHD in a remux and on E-AC-3 in a WEB-DL, and a bare
     ATMOS tag with neither word beside it does not say which. Decodable if
     EITHER family decodes: on Chrome both are no and the row goes, on Safari
     E-AC-3 is yes and the row stays. That is the right answer on both without
     the file having to guess which one the muxer used. */
  var AUDIO_FAMILIES = { atmos: ['truehd', 'eac3'] };

  /* ─────────────────────────────────────────────────────── the probe itself */

  /**
   * One codec, one size, three answers.
   *
   * `kind` is 'file' for a progressive MP4/WebM straight from a debrid link and
   * 'media-source' for anything hls.js feeds through MSE. They are NOT the same
   * question and this repo needs both: the education player and every fleet HLS
   * manifest go through hls.js (MSE), while a debrid unrestrict hands back a
   * plain file the <video> opens directly. A browser can support a codec in one
   * path and not the other — MSE support is a separate switch inside the engine.
   */
  function decodingInfo(kind, p) {
    var mc = navigator.mediaCapabilities;
    if (!mc || typeof mc.decodingInfo !== 'function') return Promise.resolve(null);
    var cfg = {
      type: kind,
      video: { contentType: p.type, width: p.w, height: p.h, bitrate: p.br, framerate: p.fr }
    };
    return mc.decodingInfo(cfg).then(function (r) {
      return { supported: !!r.supported, smooth: !!r.smooth, powerEfficient: !!r.powerEfficient };
    }).catch(function () {
      /* A TypeError here means this engine rejected the shape of the query, not
         that the codec is missing. Answering "no" would be a lie that costs the
         user their whole 4K list, so hand back null and let the canPlayType
         fallback speak instead. */
      return null;
    });
  }

  /**
   * The fallback, and the reason it is a fallback.
   *
   * canPlayType returns "probably" | "maybe" | "". It knows nothing about size,
   * bitrate or hardware, so it cannot tell 1080p HEVC from 4K HEVC — the exact
   * distinction that decides whether a Fire TV stick hangs. Treat "probably" as
   * yes, "maybe" as yes-but-unproven, "" as no.
   */
  function canPlay(type) {
    try {
      var v = document.createElement('video');
      if (!v || typeof v.canPlayType !== 'function') return '';
      return v.canPlayType(type) || '';
    } catch (e) { return ''; }
  }

  /**
   * The other half of the audio question: what hls.js will be allowed to feed
   * MediaSource.
   *
   * null, not false, when the engine has no MediaSource at all. There are
   * browsers on this fleet's list that have none, and answering "no" for them
   * would reject every row on a device whose real answer is "ask the element
   * instead" — the fleet's-ceiling bug once more.
   */
  function mseSupports(type) {
    try {
      var MS = window.MediaSource || window.WebKitMediaSource;
      if (!MS || typeof MS.isTypeSupported !== 'function') return null;
      return !!MS.isTypeSupported(type);
    } catch (e) { return null; }
  }

  /**
   * Every audio family, on both paths, in one synchronous sweep.
   *
   * "maybe" COUNTS AS YES here, and that is the opposite of the video rule two
   * functions up, on purpose. For video, "maybe" is a claim about a codec whose
   * SIZE the engine was never asked about, so believing it puts a 4K HEVC file
   * in front of a decoder that tops out at 1080p. Audio has no size, so the
   * only thing "maybe" can mean is "this engine will not commit". Measured
   * above, this browser answered "probably" or "" for every audio type and
   * never "maybe" at all — so the case is rare, and when it does happen the
   * cost of reading it as NO is a row removed that would have played, while
   * the cost of reading it as YES is the silence we already have. Unknown must
   * not remove rows. That rule is the same one detectAudio() follows.
   */
  function probeAudio() {
    var file = {};
    var mse = {};
    var sawMse = false;
    for (var i = 0; i < AUDIO_PROBES.length; i++) {
      var p = AUDIO_PROBES[i];
      var byElement = false;
      var byMse = false;
      var askedMse = false;
      for (var j = 0; j < p.types.length; j++) {
        var verdict = canPlay(p.types[j]);
        if (verdict === 'probably' || verdict === 'maybe') byElement = true;
        var ms = mseSupports(p.types[j]);
        if (ms !== null) { askedMse = true; if (ms) byMse = true; }
      }
      if (askedMse) sawMse = true;
      file[p.key] = byElement;
      /* No MediaSource in this engine: mirror the element rather than invent a
         second, harsher answer for a path that does not exist here. */
      mse[p.key] = askedMse ? byMse : byElement;
    }
    return { file: file, mse: mse, hasMse: sawMse };
  }

  /**
   * The panel, in real pixels, short side first.
   *
   * SHORT SIDE, because video is landscape and a phone is not. A modern handset
   * reports screen 390x844 at devicePixelRatio 3, so the long side alone says
   * 2532 and would hand a 6-inch phone the 4K list. min() of the two is what the
   * Fire TV does with mode.physicalWidth/physicalHeight and it is right for the
   * same reason: min(390,844)*3 = 1170 physical pixels across the picture.
   *
   * devicePixelRatio is not optional either. `screen` is in CSS pixels, so a
   * Retina laptop reports 1512x982 for a 3024x1964 panel — read without the
   * ratio it looks like a 982p screen and every 1080p row would be filtered off
   * a machine that renders them perfectly.
   */
  function panelHeight() {
    try {
      var s = window.screen || {};
      var dpr = window.devicePixelRatio || 1;
      var shortSide = Math.min(Number(s.width) || 0, Number(s.height) || 0);
      var px = Math.round(shortSide * dpr);
      if (!px || px < 0) return 1080;
      return px;
    } catch (e) { return 1080; }
  }

  /** Snap a measured pixel height DOWN to a tier a release is actually labelled with. */
  function snapTier(px) {
    for (var i = 0; i < TIERS.length; i++) if (px >= TIERS[i]) return TIERS[i];
    return 480;
  }

  var cached = null;
  var inflight = null;

  /**
   * Probe once per page load and remember the answer.
   *
   * Once, because decodingInfo is a real query into the engine's decoder list
   * and this file asks it sixteen times (four codecs x two sizes x two path
   * types). Doing that per stream row, on a list that can run past a thousand
   * entries, is the same mistake StreamRanker.brs records fixing when it moved
   * the dead-link registry read out of ParseStream.
   */
  function probe() {
    if (cached) return Promise.resolve(cached);
    if (inflight) return inflight;

    var jobs = [];
    var results = { file: {}, file4k: {}, mse: {} };

    PROBES.forEach(function (p) {
      jobs.push(decodingInfo('file', p).then(function (r) { results.file[p.key] = r; }));
      jobs.push(decodingInfo('media-source', p).then(function (r) { results.mse[p.key] = r; }));
    });
    PROBES_4K.forEach(function (p) {
      jobs.push(decodingInfo('file', p).then(function (r) { results.file4k[p.key] = r; }));
    });

    inflight = Promise.all(jobs).then(function () {
      cached = build(results);
      inflight = null;
      return cached;
    }).catch(function () {
      /* A probe that cannot answer must not take the app with it. Fall through
         to the canPlayType-only shape, which every engine can produce. */
      cached = build({ file: {}, file4k: {}, mse: {} });
      inflight = null;
      return cached;
    });
    return inflight;
  }

  function build(r) {
    var usedMediaCaps = false;
    var c = {};

    /* ── codecs at 1080p: the hard gate ────────────────────────────────────
       `supported` from decodingInfo when it answered, canPlayType otherwise.
       Anything this says false about is REMOVED from the list, because the
       alternative is a spinner that never ends. */
    PROBES.forEach(function (p) {
      var mc = r.file[p.key];
      if (mc) {
        usedMediaCaps = true;
        c[p.key] = mc.supported;
        c[p.key + 'Smooth'] = mc.smooth;
        c[p.key + 'Hw'] = mc.powerEfficient;
      } else {
        var verdict = canPlay(p.type);
        c[p.key] = verdict === 'probably' || verdict === 'maybe';
        /* canPlayType cannot see smoothness or hardware. "probably" is the
           strongest word it has, so that is what gets the benefit of the doubt
           and "maybe" does not. Never invent a hardware answer here: an
           unmeasured `true` would rank a codec first on evidence that does not
           exist. */
        c[p.key + 'Smooth'] = verdict === 'probably';
        c[p.key + 'Hw'] = false;
      }
      var mse = r.mse[p.key];
      c[p.key + 'Mse'] = mse ? mse.supported : c[p.key];
    });

    /* ── codecs at 2160p: what may raise the ceiling ───────────────────────
       BOTH supported AND smooth. This is the Fire TV's
       videoCapabilities.isSizeSupported(3840, 2160) check in browser form: a
       decoder that exists but tops out at 1080p is a 1080p decoder however it
       is named, and `smooth:false` at 3840x2160 is the engine saying exactly
       that. powerEfficient is deliberately NOT required — see the header. */
    PROBES_4K.forEach(function (p) {
      var mc = r.file4k[p.key];
      if (mc) {
        c[p.key + '4k'] = mc.supported && mc.smooth;
        c[p.key + '4kHw'] = mc.powerEfficient;
      } else {
        /* No mediaCapabilities: canPlayType cannot distinguish 4K from 1080p at
           all, so the only honest answer is "we do not know". Treat unknown as
           no for RAISING the ceiling — a smaller picture that plays beats a 4K
           file that stalls — and say so in describe() rather than pretending. */
        c[p.key + '4k'] = false;
        c[p.key + '4kHw'] = false;
      }
    });

    c.probeApi = usedMediaCaps ? 'navigator.mediaCapabilities.decodingInfo' : 'HTMLMediaElement.canPlayType';

    /* Native HLS, which is not a codec question. Recovered from app.js's own
       hlsNative() reasoning: Safari and every television play an .m3u8 from a
       bare <video src>, Chrome/Edge/Firefox need hls.js, and this repo ships
       hls.min.js for exactly that. */
    c.hlsNative = !!(canPlay('application/vnd.apple.mpegurl') || canPlay('application/x-mpegURL'));
    c.hlsJs = !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());

    /* ── the audio decoders, per path ──────────────────────────────────────
       Two maps and not one, because the two paths genuinely disagree on this
       machine (see the header's measured table). Which map a row is judged
       against is decided by audioPathFor(), from the row's own container: an
       HLS manifest that hls.js will demux is an MSE question, and a debrid
       file the <video> opens directly is an element question. */
    var au = probeAudio();
    c.audioFile = au.file;
    c.audioMse = au.mse;
    c.audioProbeApi = au.hasMse
      ? 'MediaSource.isTypeSupported + HTMLMediaElement.canPlayType'
      : 'HTMLMediaElement.canPlayType';

    /* ── the panel ─────────────────────────────────────────────────────── */
    c.panelPx = panelHeight();
    c.panelTier = snapTier(c.panelPx);

    /* ── the RAM floor ─────────────────────────────────────────────────────
       navigator.deviceMemory is GB, quantised by the spec to 0.25/0.5/1/2/4/8
       and capped at 8 so it cannot fingerprint. It is the browser's only view
       of the Fire TV rule: an AFTSS with 921 MB total hangs outright on a 2160p
       REMUX, proven on that device, so anything at or under 1 GB is held to
       1080p whatever the display claims.

       ABSENT IS NOT LOW, and this is not a hypothetical: Safari and Firefox do
       not ship deviceMemory at all, and measured 3 Sep 2026 it came back
       `undefined` from Chromium 147 headless too, on a Mac with 16 GB in it.
       Capping a machine to 1080p because its browser declined to answer a
       memory question is precisely the bug in the header — one device's floor
       becoming the fleet's ceiling — so undefined means "no reason to cap",
       not "cap". Only a number at or under 1 caps anything. */
    var dm = navigator.deviceMemory;
    c.deviceMemory = (typeof dm === 'number' && dm > 0) ? dm : null;
    c.lowMemory = (c.deviceMemory !== null && c.deviceMemory <= 1);

    /* ── the link ──────────────────────────────────────────────────────────
       The Roku's rule is "only a wired link is trusted with a remux", after an
       84 MB progressive file hung it at 13% over Wi-Fi. A browser has no
       GetConnectionType, so navigator.connection is the nearest thing: saveData
       is the user asking outright, effectiveType is the engine's own bucket, and
       downlink is an estimate in Mbit/s. Chromium ships all three; Safari and
       Firefox ship none, and the same rule as deviceMemory applies — silence is
       not a slow link, it is silence, so it gets the conservative middle
       setting the Roku gives Wi-Fi rather than the worst one. */
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    c.saveData = !!(conn && conn.saveData);
    c.effectiveType = (conn && conn.effectiveType) || '';
    c.downlink = (conn && typeof conn.downlink === 'number') ? conn.downlink : null;
    var slowLink = c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
    c.highBitrateOk = !slowLink && (c.downlink === null ? false : c.downlink >= 20);

    /* A ceiling on file size is really a ceiling on BITRATE, so it belongs to
       the link and not to the app — StreamRanker.brs's numbers, kept, because
       the constraint is the same one and it was measured against real releases:
       20 GB threw away 61 of 400 releases for one title on a wired set, which is
       exactly the 4K remuxes worth having, so a fast link gets 80. */
    c.maxSizeGb = c.saveData ? 4 : (slowLink ? 8 : (c.highBitrateOk ? 80 : 20));

    /* ── the ceiling, from all four ───────────────────────────────────────── */
    c.any4k = !!(c.hevc4k || c.av14k || c.vp94k || c.h2644k);
    c.maxHeight = ceiling(c);

    c.reduceMotion = prefersReducedMotion();
    return c;
  }

  /**
   * The tallest stream this browser should ever be offered.
   *
   * THE 4K TIER COMES FROM THE DECODER, NEVER FROM THE SCREEN, and that is the
   * one rule in this function that is not negotiable.
   *
   * It was written the other way round first — `Math.max(1080, panelTier)`,
   * with `any4k` allowed only to LOWER a panel that already claimed 2160 — and
   * that is a silent 1080p cap on the devices this app most has to get right.
   * The Apple TV lane measured it: on a real Apple TV 4K, every screen API in
   * the browser reports 1920x1080, because that is the UI PLANE the app is
   * composited on, not the output mode the television is driven at. The box is
   * decoding and outputting 2160p while `screen.height` says 1080. webOS and
   * Tizen browsers report a 1080 UI plane on 4K panels for the same reason.
   * A panel-derived ceiling therefore hands a 4K television the 1080p list and
   * nothing anywhere says why — which is EXACTLY the bug this file's header
   * exists against, one device's floor becoming the fleet's ceiling, arriving
   * through a different sensor.
   *
   * There is no way for a browser to tell an Apple TV 4K's 1080 UI plane from a
   * genuine 1080p monitor, so one of the two errors has to be chosen. Offering
   * a 1080p monitor a 4K file costs bandwidth and the compositor downscales it;
   * capping a 4K set at 1080p costs the picture and cannot be recovered. The
   * decoder is asked a question it can actually answer — decodingInfo at
   * 3840x2160, `supported && smooth` — so that is the authority.
   *
   * What each input is now allowed to do:
   *
   *   codec     DECIDES 2160. At least one codec that decodes 3840x2160
   *             SMOOTHLY, or the ceiling is not 4K. Without one a 4K row is a
   *             black screen with audio, the failure the Fire TV's
   *             decodesAt4k() exists to prevent.
   *   panel     may only RAISE 1080 to 1440, never cap a decoder. It is an
   *             advisory number and describe() labels it as one.
   *   memory    the AFTSS rule. <=1 GB is held to 1080p, and it still overrules
   *             a 4K decoder: that stick hangs outright on a 2160p decode.
   *   link      saveData or a 2g/3g bucket. A 4K file is 25-45 Mbit/s and the
   *             browser will buffer for ever rather than say so.
   *
   * The FLOOR is 1080, never the panel, and the harness proves why: the
   * headless runner reports screen 1280x720 at devicePixelRatio 1, so the panel
   * tier is 720 and a panel-only ceiling would filter every 1080p row out of
   * every CI run and off every 1366x768 laptop as well. Those machines play
   * 1080p perfectly — the compositor downscales for free, and a downscaled
   * 1080p source looks better than a 720p one. This is the same carve-out
   * DeviceCaps.brs makes for the 720p Roku UI: "a 720p UI still drives a 1080p
   * panel on many sets, so 1080p decode is allowed either way."
   */
  function ceiling(c) {
    /* Decode first, and on its own. A 4K decoder is a 4K device whatever the
       screen says it is. */
    var top = c.any4k ? 2160 : Math.min(1440, Math.max(1080, c.panelTier));
    /* The two real-device facts that still overrule a 4K decoder, in the order
       the Fire TV applies them. Both are measurements of the machine, not of
       the panel it happens to be plugged into. */
    if (top >= 1440 && c.lowMemory) top = 1080;
    if (top >= 1440 && (c.saveData || c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g')) top = 1080;
    return top;
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /* ──────────────────────────────────────────────────── reading a stream row */

  /*
   * THE TRAILING [pi]? IS THE WHOLE POINT OF THESE, and leaving it out is a bug
   * that passes every review because the regex looks obviously right.
   *
   * Caught by caps-hero.smoke.mjs on its first run, 3 Sep 2026. The patterns
   * were `\b(1080|fhd)\b` and friends. `\b` is a word boundary, and in
   * "1080p" the character after "1080" is "p", which IS a word character — so
   * there is no boundary there and the pattern never fired. Every row in the
   * fixture came back height 0:
   *
   *     1. 1080p mp4 h264 0
   *     2. 720p  mp4 h264 0
   *     3. 1080p mkv h264 0
   *
   * "1080p" is how essentially every release on every addon writes it, so the
   * resolution ceiling was measuring nothing at all. The two 4K rows still
   * dropped, which is what made it look like it worked — but only because their
   * `name` field happened to say "4K", and `\b4k\b` does have a boundary after
   * it. A test that had only counted "were the 4K rows removed" would have gone
   * green over a resolution filter that was doing nothing.
   */
  /**
   * A marker in a release name, anchored to the DELIMITERS around it.
   *
   * TWO BUGS LIVE AT THIS EXACT SPOT and they pull in opposite directions, so
   * neither a bare substring test nor `\b` is right on its own.
   *
   * A BARE SUBSTRING MATCHES INSIDE ORDINARY WORDS. `/ita/` is true of
   * "DIGITAL" — d-i-g-**ita**-l — which is on a large share of WEB-DL release
   * names, and `/rus/` is true of "Rust" and "Crusade". app.js has carried
   * exactly that test since the source list was written (`/rus|russian|ita|
   * italian|latino|french/`), so every AMZN DIGITAL release in the list was
   * being demoted as a foreign dub. That is the failure this helper exists for.
   *
   * `\b` FIXES THAT AND BREAKS UNDERSCORES. `_` is a word character in every
   * regex engine, so in `Some_Film_2026_1080p_ITA_WEB` there is no boundary
   * before `1080p` or before `ITA` and NOTHING matches — the same silent
   * nothing-detected failure the `[pi]?` note above records, just reached by a
   * different route. Underscore-delimited names are a minority of releases but
   * they are not rare, and a release whose height reads 0 sails straight past
   * the resolution ceiling.
   *
   * So the delimiter is named explicitly: anything that is not a letter or a
   * digit, or the end of the string. `.` `-` `_` `[` `]` and space all count,
   * and a letter or digit does not. Strictly more matches than `\b`, never
   * fewer, and no match inside a word.
   */
  function marker(alternatives) {
    return new RegExp('(?:^|[^a-z0-9])(?:' + alternatives + ')(?:[^a-z0-9]|$)', 'i');
  }

  var RES_WORDS = [
    [marker('2160[pi]?|4k|uhd'), 2160],
    [marker('1440[pi]?|2k'), 1440],
    [marker('1080[pi]?|fhd|fullhd'), 1080],
    [marker('720[pi]?|hd'), 720],
    [marker('480[pi]?|576[pi]?|360[pi]?|sd|dvdrip'), 480]
  ];

  /* The dub languages. Same anchoring, same reason, and this is the list the
     -1200 penalty in score() reads. */
  var FOREIGN = marker('rus|russian|ita|italian|latino|french|dublado|hindi|tamil|telugu');

  function detectHeight(blob) {
    for (var i = 0; i < RES_WORDS.length; i++) if (RES_WORDS[i][0].test(blob)) return RES_WORDS[i][1];
    /* No resolution word at all. 0, not a guess: RejectReason compares
       `height > maxHeight`, so an unlabelled release survives the filter and is
       judged on everything else — the same one-sided rule StreamRanker uses for
       untitled labels, and for the same reason. Most of them are fine. */
    return 0;
  }

  /* Delimiter-anchored for the reason marker() gives, and this one is a HARD
     GATE rather than a score: a codec that reads '' skips rejectReason's codec
     test entirely, so an HEVC file named `Movie_2026_HEVC_1080p` would be
     offered to a browser with no HEVC decoder and open as a spinner that never
     resolves. Detection failing open is the worst direction here. */
  var CODEC_AV1 = marker('av1|av01');
  var CODEC_HEVC = marker('hevc|h\\.?265|x265|hdr10\\+?');
  var CODEC_VP9 = marker('vp9');
  var CODEC_H264 = marker('avc|h\\.?264|x264');

  function detectCodec(blob) {
    if (CODEC_AV1.test(blob)) return 'av1';
    if (CODEC_HEVC.test(blob)) return 'hevc';
    if (CODEC_VP9.test(blob)) return 'vp9';
    if (CODEC_H264.test(blob)) return 'h264';
    return '';
  }

  /**
   * The CONTAINER, which is a web-only problem and the single biggest difference
   * between this ranker and the Roku's.
   *
   * A Roku Video node opens MKV. A browser <video> does not: Chrome sniffs some
   * Matroska files and plays them by accident, Safari opens none, and Firefox
   * plays only the WebM subset. AVI is dead everywhere. Since a debrid link
   * returns a great many .mkv remuxes, this is not a rare case.
   *
   * IT IS A DEMOTION, NOT A REJECTION, and that is the same call StreamRanker
   * makes about lossless audio: "rejecting them outright hid streams that do
   * play". Chrome really does open a large share of h264+aac MKVs, and a user on
   * Chrome would lose most of the 4K list to a rule written for Safari. So an
   * MKV sinks below every MP4 and is still there to click.
   */
  var BOX_MKV = marker('mkv|matroska');
  var BOX_AVI = marker('avi');
  var BOX_HLS = marker('m3u8|hls');
  var BOX_MP4 = marker('mp4');

  function detectContainer(blob) {
    if (BOX_MKV.test(blob)) return 'mkv';
    if (BOX_AVI.test(blob)) return 'avi';
    if (BOX_HLS.test(blob)) return 'hls';
    if (BOX_MP4.test(blob)) return 'mp4';
    return '';
  }

  function detectSizeGb(blob) {
    var gb = blob.match(/(\d+(?:[.,]\d+)?)\s*gb\b/i);
    if (gb) return parseFloat(gb[1].replace(',', '.')) || 0;
    var mb = blob.match(/(\d+(?:[.,]\d+)?)\s*mb\b/i);
    if (mb) return (parseFloat(mb[1].replace(',', '.')) || 0) / 1024;
    return 0;
  }

  function detectSeeders(blob) {
    var m = blob.match(/(?:👤|👥|seeders?:?|\bs:)\s*(\d+)/i);
    return m ? (parseInt(m[1], 10) || 0) : 0;
  }

  /**
   * An audio marker, and it needs a THIRD anchoring shape of its own.
   *
   * The old version of this list was left on `\b` with a comment explaining
   * that neither of the other two shapes could work, and that comment was
   * right about both of them:
   *
   *   marker()  requires a non-alphanumeric AFTER the tag, and the commonest
   *             spellings put a DIGIT there — "DDP5.1", "DD+5.1", "AAC2.0",
   *             "DD5.1". Every one of those would be missed.
   *   \b        matches those, and then misses everything in an
   *             underscore-delimited name, because `_` is a word character —
   *             `Some_Film_2026_DDP5.1_WEB` finds nothing at all. That is the
   *             same silent nothing-detected failure the two notes above this
   *             one already record, reached a third time by a third route.
   *
   * So the trailing anchor is a NEGATIVE LOOKAHEAD for a letter instead of a
   * required delimiter. A digit, a delimiter or the end of the string all pass;
   * another letter does not. "DDP5.1" matches, `_DDP_` matches, and "AACHEN"
   * does not. The leading anchor stays as marker() has it, so nothing matches
   * inside a word from the left either.
   *
   * IT IS A HARD GATE NOW, not a score, which is why the anchoring is worth
   * this much care. A missed match used to cost a ranking place. It now costs a
   * silent film — or, in the other direction, a good row removed.
   */
  function audioMarker(alternatives) {
    return new RegExp('(?:^|[^a-z0-9])(?:' + alternatives + ')(?![a-z])', 'i');
  }

  /* The delimiters release names put inside a multi-word tag: DTS-HD, DTS.HD,
     DTS HD, DTS_HD are all the same thing. */
  var A = '[-. _]?';

  /**
   * WORST FIRST, and first match wins.
   *
   * A name that lists two families — "DTS-HD.MA.5.1.AAC" happens — is read as
   * the undecodable one, because in those releases the lossless track is the
   * DEFAULT track and a browser plays the default. The alternative rule ("it
   * mentions AAC, so it is fine") is precisely the assumption the live
   * measurement refuted: rows 1, 3 and 4 of the Past Lives list all carried a
   * second track on paper and all decoded exactly 0 bytes of audio.
   *
   * ATMOS IS PLACED AFTER BOTH DOLBY FAMILIES on purpose. "DDP5.1.Atmos" is
   * E-AC-3 and "TrueHD.Atmos" is TrueHD, so both are already decided by the
   * time a bare "Atmos" can reach its own line — and a bare one is genuinely
   * ambiguous, which is what AUDIO_FAMILIES exists for.
   *
   * `dd` cannot swallow `ddp` or `dd+`: 'p' is a letter so the lookahead
   * blocks it, and `dd\+` is matched by the eac3 line one row earlier anyway.
   *
   * `mlp` IS NOT IN THE truehd LINE, and it must not be put back. It was, and
   * measured on 6 Sep 2026 it read "MLP.Equestria.Girls.2013.1080p.WEB-DL.
   * x264-GRP" as TrueHD — a My Little Pony release, h264 with almost certainly
   * an AAC track, removed from the list by the hardest gate in this file for a
   * title word. That is the fleet's-ceiling shape again, arriving through a
   * TITLE rather than through a device: three letters that name a franchise
   * are read as a codec and take a playable row away. Nothing is lost by
   * dropping it, because no scene release labels its audio "MLP" — they write
   * TrueHD or THD — and `mlp` still maps to truehd in MEASURED_AUDIO below,
   * where it is an exact ffprobe identifier and cannot collide with a title.
   */
  var AUDIO_WORDS = [
    ['truehd', audioMarker('true' + A + 'hd|thd')],
    ['dts',    audioMarker('dts(?:' + A + '(?:hd|x|es|ma))*|dca')],
    ['eac3',   audioMarker('e' + A + 'ac' + A + '3|ddp|dd\\+|ddplus|dolby' + A + 'digital' + A + 'plus')],
    ['ac3',    audioMarker('ac' + A + '3|dd|dolby' + A + 'digital')],
    ['atmos',  audioMarker('atmos')],
    ['flac',   audioMarker('flac')],
    ['opus',   audioMarker('opus')],
    ['vorbis', audioMarker('vorbis|ogg')],
    ['aac',    audioMarker('aac|he' + A + 'aac|aac' + A + 'lc|lc' + A + 'aac')],
    ['mp3',    audioMarker('mp3')],
    ['pcm',    audioMarker('l?pcm')]
  ];

  function detectAudio(blob) {
    for (var i = 0; i < AUDIO_WORDS.length; i++) if (AUDIO_WORDS[i][1].test(blob)) return AUDIO_WORDS[i][0];
    /* No audio tag at all, and '' means UNKNOWN — never "safe". The gate below
       removes a row only on a measured false, so an untagged release is still
       offered and simply gets none of the +200 a proven-decodable one gets.
       Rejecting unknowns would empty the list on every addon that writes bare
       titles, and most untagged files really are AAC. */
    return '';
  }

  /* An ffprobe/MediaInfo codec name from a measured sample, mapped onto the
     same families the release names use. Kept separate from AUDIO_WORDS
     because these are exact identifiers rather than marketing tags — there is
     nothing to anchor and nothing to guess.

     ALAC IS DELIBERATELY ABSENT and must not be added as a flac alias. Apple
     Lossless is a different codec with different support — Safari decodes it,
     Chrome does not, and Chrome DOES decode FLAC — so aliasing the two would
     hand Chrome a confident YES about a track it cannot play, which is the
     exact silent-picture failure this file was opened to fix. Unmapped means
     unknown, and unknown never removes a row. */
  var MEASURED_AUDIO = {
    aac: 'aac', aac_latm: 'aac', mp3: 'mp3', mp2: 'mp3', mp1: 'mp3',
    opus: 'opus', vorbis: 'vorbis', flac: 'flac',
    ac3: 'ac3', 'ac-3': 'ac3', eac3: 'eac3', 'e-ac-3': 'eac3', ec3: 'eac3', 'ec-3': 'eac3',
    dts: 'dts', dca: 'dts', dtshd: 'dts', truehd: 'truehd', mlp: 'truehd'
  };

  function measuredAudioKey(codec) {
    var c = String(codec || '').toLowerCase();
    if (MEASURED_AUDIO[c]) return MEASURED_AUDIO[c];
    if (c.indexOf('pcm') === 0) return 'pcm';
    return '';
  }

  /**
   * Which of the two probe maps this row will really be judged by.
   *
   * An HLS manifest that hls.js has to demux is a MediaSource question; a
   * debrid file the <video> opens by itself is an element question. Safari
   * opens .m3u8 natively and therefore takes the element path even for HLS,
   * which is exactly the browser where the two answers are most likely to
   * differ, so the native check comes first.
   */
  function audioPathFor(info, caps) {
    if (info.container === 'hls' && caps && !caps.hlsNative && caps.hlsJs) return 'mse';
    return 'file';
  }

  /**
   * true / false / null for one audio family on one path.
   *
   * null is not a soft false. It means the question was never asked — an
   * unrecognised tag, or a caps object built before this probe existed (a
   * cached one from a service worker that still has the old file). Everything
   * downstream treats null as "leave the row alone".
   */
  function audioSupports(key, path, caps) {
    if (!key || !caps) return null;
    var map = (path === 'mse') ? caps.audioMse : caps.audioFile;
    if (!map) return null;
    var fam = AUDIO_FAMILIES[key] || [key];
    var asked = false;
    for (var i = 0; i < fam.length; i++) {
      if (typeof map[fam[i]] !== 'boolean') continue;
      asked = true;
      if (map[fam[i]]) return true;
    }
    return asked ? false : null;
  }

  function audioVerdict(info, caps) {
    return audioSupports(info.audio, audioPathFor(info, caps), caps);
  }

  function isHttps(u) {
    return typeof u === 'string' && /^https:\/\//i.test(u);
  }

  function parseStream(s, caps, inspected) {
    var name = (s && s.name) || '';
    var title = (s && s.title) || (s && s.description) || '';
    var blob = (name + ' ' + title).toLowerCase();

    var info = {
      raw: s,
      url: (s && typeof s.url === 'string') ? s.url : '',
      infoHash: (s && s.infoHash) || '',
      label: name,
      title: title,
      blob: blob,
      height: detectHeight(blob),
      codec: detectCodec(blob),
      /* The URL is read too, and only for this. Plenty of addons put the
         extension nowhere but the link — the fixture's own 4K remux is titled
         "...REMUX.HEVC.TrueHD.Atmos-GRP" with the .mkv only in its url, and it
         came back container "?" until this was widened. The url stays OUT of
         the main blob: a CDN path full of digits would feed false 1080s and
         720s straight into detectHeight. */
      container: detectContainer(blob + ' ' + String((s && s.url) || '').toLowerCase()),
      audio: detectAudio(blob),
      sizeGb: detectSizeGb(blob),
      seeders: detectSeeders(blob),
      foreign: FOREIGN.test(blob),
      rejected: '',
      score: 0
    };
    // The caller validates the response mode, age and language choices. Raw
    // provider fields alone must never override the device's format checks.
    if (typeof inspected === 'function' && inspected(s)) {
      var evidence = s._mediaEvidence;
      var video = evidence && evidence.video;
      if (video && video.packets > 0 && video.width > 0 && video.height > 0) {
        info.height = Math.min(video.width, video.height);
        var measuredCodec = String(video.codec || '').toLowerCase();
        info.codec = ({ h264: 'h264', avc: 'h264', hevc: 'hevc', h265: 'hevc', av1: 'av1', vp9: 'vp9' })[measuredCodec] || '';
        var audio = Array.isArray(evidence.audio) ? evidence.audio.filter(function (track) { return track.packets > 0; }) : [];
        var english = audio.filter(function (track) { return /^(en|eng)(?:[-_]|$)/i.test(String(track.language || '')); });
        var selectedAudio = english.length ? english : audio;
        /* A MEASURED track list beats the release name, and here — unlike in a
           name — a second decodable track is a fact rather than a hope. Prefer
           the first track THIS browser decodes over the first track in the
           file, because stream-preferences.js really does switch tracks where
           the engine exposes them (hls.audioTrack, video.audioTracks), so a
           decodable track that exists is a track the viewer can reach. When
           none of them decode, the first one is kept and the gate below
           removes the row on it. */
        var measured = [];
        for (var t = 0; t < selectedAudio.length; t++) {
          var mk = measuredAudioKey(selectedAudio[t].codec);
          if (mk && measured.indexOf(mk) === -1) measured.push(mk);
        }
        var measuredPath = audioPathFor(info, caps);
        info.audio = measured[0] || '';
        for (var u = 0; u < measured.length; u++) {
          if (audioSupports(measured[u], measuredPath, caps) === true) { info.audio = measured[u]; break; }
        }
        if (english.length) info.foreign = false;
      }
    }

    /* THREE-VALUED ON PURPOSE. true: the browser was asked and said yes.
       false: it was asked and said no — the only value that may remove a row.
       null: nothing was asked, because the name carried no tag this file
       recognises. Silence about a file is not evidence against it. */
    info.audioPlayable = audioVerdict(info, caps);
    info.audioLabel = AUDIO_LABELS[info.audio] || '';
    /* Set by rankStreams when a row is kept DESPITE a false verdict, because
       rejecting it would have left the viewer with nothing at all. */
    info.audioSilent = false;
    info.playable = isHttps(info.url);
    info.score = score(info, caps);
    return info;
  }

  /* ────────────────────────────────────────────────────────── the hard gate */

  /**
   * Why this row must not be offered, or '' if it may be.
   *
   * Only facts about THIS device go here. Anything that is a preference — a
   * dubbing language, a lossless track, a big file on a slow link — is a score,
   * because a preference that removes rows hides streams that play.
   */
  function rejectReason(info, caps) {
    /* No URL and no torrent client. The Roku can send an infoHash through a
       debrid unrestrict when it is picked; a browser page cannot, and this app
       has no such call anywhere in it. Before this, a row with no url rendered
       like any other and openPlayer() was handed `undefined`. */
    if (!info.playable) return 'nourl';

    if (info.height && info.height > caps.maxHeight) return 'res';

    if (info.codec && caps[info.codec] === false) return 'codec';

    /* The codec decodes, but not at this size. The Fire TV's isSizeSupported
       check: an HEVC decoder that tops out at 1080p is a 1080p decoder. */
    if (info.height >= 2160 && info.codec && caps[info.codec + '4k'] === false) return 'codec4k';

    /* THE SILENT PICTURE. A measured false and nothing else — an unknown tag
       never reaches here, because audioPlayable is null for it.

       IT IS A GATE AND NOT A SCORE, which reverses the call the old -250/-700
       penalty made, and the reversal is a measurement rather than a change of
       taste. That penalty rested on "most of these MKVs carry a second AAC
       track", borrowed from StreamRanker's lossless-audio note. On the Roku
       that is true, because its player selects tracks. In a browser it is not:
       rows 1, 3 and 4 of the live Past Lives list decoded megabytes of video
       with webkitAudioDecodedByteCount at exactly 0 while row 2 decoded
       173,511 bytes in the same session. The second track was there on paper
       and the film was still silent.

       It is also the only gate in this function with a way back — see the
       fallback in rankStreams(). A silent picture beats no picture, so if
       removing these would empty the list they are kept and marked instead. */
    if (info.audioPlayable === false) return 'audio';

    if (info.sizeGb > caps.maxSizeGb) return 'size';

    return '';
  }

  /* ────────────────────────────────────────────────────────────── the score */

  /**
   * Higher is better. Read in this order because that is the order it matters:
   * a picture this machine can really draw, then how quickly it starts, then
   * everything a release name brags about.
   *
   * CALIBRATED FROM THE CAPS, NOT FROM A NUMBER. StreamRanker records that the
   * subtler half of the one-device bug was in the SCORING and not the filter:
   * 4K passed the filter on the 4K set and still ranked below 1080p, so
   * auto-play never chose it and the fix looked like it had not worked.
   */
  function score(info, caps) {
    var s = 0;

    /* Resolution, scaled to the ceiling THIS device measured. A 4K row on a
       1080p laptop is not "worse", it is absent — rejectReason already took it —
       so nothing here needs to punish it. */
    if (info.height) s += Math.min(info.height, caps.maxHeight) * 4;
    else s += 700; // unlabelled: below a labelled 720p, above nothing

    /* powerEfficient, finally used for what it is good for. Between two rows of
       the same height, the one whose codec the engine says a hardware decoder
       handles wins — that is a real difference in fan noise, battery and
       dropped frames, and it is the only signal a browser has for it. Small,
       because the measurement is unreliable enough (see the header) that it must
       break ties and never overturn a resolution. */
    if (info.codec && caps[info.codec + 'Hw']) s += 300;
    if (info.codec && caps[info.codec + 'Smooth']) s += 150;

    /* Container. A browser opens MP4 and HLS; MKV is a coin toss and AVI is
       nothing. The gap is deliberately large — larger than one resolution tier
       at 1080p — because an unopenable file is worth less than a smaller one
       that plays. */
    if (info.container === 'mp4' || info.container === 'hls') s += 600;
    else if (info.container === 'mkv') s -= 900;
    else if (info.container === 'avi') s -= 2000;

    /* Audio, from the probe rather than from a guess about the name.
       rejectReason() has already removed the measured-false rows, so the only
       ones that can arrive here carrying `false` are the ones the zero-source
       fallback put back — and those must sink under every row that is merely
       ugly. 60000 clears the widest gap this function can otherwise open (a
       2160p row scores 8640 before its bonuses) and still sits above the
       -100000 a dead link takes and the -1000000 a showAll reject takes, so
       the three stay in the right order: playable, then silent, then dead,
       then rejected.

       +200 for a PROVEN track and nothing for an unknown one. Unknown is the
       common case and must not be punished — but between two rows that are
       otherwise equal, the one whose audio this browser has already answered
       YES about is the safer click. */
    if (info.audioPlayable === true) s += 200;
    else if (info.audioPlayable === false) s -= 60000;

    /* A dub in a language nobody in this house reads. Carried over from the
       penaltyOf() that app.js has had inline since the source list was written;
       it was the only ranking this client had. */
    if (info.foreign) s -= 1200;

    /* Bitrate headroom. A 40 GB remux on a link the browser thinks is 5 Mbit is
       a spinner. It is not removed — maxSizeGb already removes the impossible
       ones — but it should not lead. */
    if (info.sizeGb && !caps.highBitrateOk && info.sizeGb > 12) s -= 500;

    if (info.seeders) s += Math.min(info.seeders, 200);

    return s;
  }

  /* ──────────────────────────────────────────────────────────── the ranking */

  /**
   * A raw /stream response in, the rows THIS browser can play out, best first.
   *
   * opts.deadLinks  urls the viewer long-pressed as broken. Sunk, never removed:
   *                 a dead link may come back tomorrow. Carried over from the
   *                 dead_links localStorage list app.js already keeps.
   * opts.showAll    keep the rejects, marked, at the bottom — the "show every
   *                 stream" escape hatch the Roku picker has.
   * opts.inspected  caller-validated fresh sample predicate. Measured video
   *                 dimensions and codecs then take priority over the name.
   * opts.cap        how many raw entries to parse at all. A popular title can
   *                 return well over a thousand and each one costs a handful of
   *                 regexes; 1200 is StreamRanker's measured number for its slow
   *                 device and there is no reason for the browser to differ.
   *
   * The result carries noteFor(rawStream): the one sentence to show a viewer
   * about that row, or '' when there is nothing to say. It is keyed on the raw
   * object because that is what the caller keeps — app.js maps the ranked list
   * down to `info.raw` before it renders, so by the time a row reaches the DOM
   * the info object is gone and only identity is left to look it up by.
   */
  function rankStreams(raw, caps, opts) {
    opts = opts || {};
    var dead = opts.deadLinks || [];
    var showAll = !!opts.showAll;
    var cap = opts.cap || 1200;
    var dropped = { nourl: 0, res: 0, codec: 0, codec4k: 0, audio: 0, size: 0, total: 0 };
    var out = [];

    if (!Array.isArray(raw)) return { streams: out, dropped: dropped, total: 0 };

    /* Which entries survive the cap matters more than the cap. A row with no
       URL cannot play in a browser at all, so it must never displace one that
       can — unconfigured addons return infoHash-only entries by the hundred and
       they would otherwise crowd out playable releases and LOWER the final
       count while the raw total went up. */
    var work = raw;
    if (raw.length > cap) {
      var withUrl = [];
      var rest = [];
      for (var i = 0; i < raw.length; i++) {
        if (raw[i] && isHttps(raw[i].url)) withUrl.push(raw[i]); else rest.push(raw[i]);
      }
      work = withUrl.concat(rest).slice(0, cap);
    }

    /* TWO PASSES, because the audio gate is the one rule here that cannot be
       decided from a single row. Every other reason is a fact about that file
       against this device; "would removing this leave the viewer with nothing"
       is a fact about the whole list. So: judge every row first, then let the
       fallback speak, then count and collect. */
    var rows = [];
    var playable = 0;
    for (var j = 0; j < work.length; j++) {
      var parsed = parseStream(work[j], caps, opts.inspected);
      var why = rejectReason(parsed, caps);
      if (!why) playable++;
      rows.push({ info: parsed, reason: why });
    }

    /* THE SAFE FALLBACK. A silent picture still beats nothing.
       Every source for a title really can be Dolby — a 2160p remux-only list
       is the normal shape for a new release on a debrid index — and a browser
       that cannot decode any of them must not be told there are no sources,
       because "No compatible stream available" on a title with 400 results is
       the message that makes somebody reinstall the app. The rows come back
       marked instead: score() has already sunk them by 60000 so they sit under
       anything playable, they carry audioSilent, and explainSource() has a
       sentence for them. Nothing else is ever readmitted this way — a file
       with no URL or a video codec that stalls the element gives the viewer a
       spinner, not a compromise. */
    if (!playable) {
      for (var f = 0; f < rows.length; f++) {
        if (rows[f].reason !== 'audio') continue;
        /* ASK AGAIN WITH THE AUDIO VERDICT SILENCED, rather than clearing the
           reason outright. rejectReason() returns the FIRST rule a row breaks
           and the audio rule sits ABOVE the size rule, so "audio" on a row can
           be hiding a second, unrelated ceiling underneath it. Measured
           6 Sep 2026: a 62.4 GB TrueHD remux, on a caps object with
           maxSizeGb 5, came back through this fallback with dropped.size 0 —
           the size gate never ran on it at all, and a viewer on a metered link
           was offered a 62 GB file. A silent picture beats no picture; a
           download this connection cannot finish does not. */
        var muted = rows[f].info.audioPlayable;
        rows[f].info.audioPlayable = null;
        var alsoBroken = rejectReason(rows[f].info, caps);
        rows[f].info.audioPlayable = muted;
        if (alsoBroken) { rows[f].reason = alsoBroken; continue; }
        rows[f].reason = '';
        rows[f].info.audioSilent = true;
        playable++;
      }
    }

    for (var g = 0; g < rows.length; g++) {
      var info = rows[g].info;
      var reason = rows[g].reason;
      if (!reason) {
        if (dead.indexOf(info.url) !== -1) info.score -= 100000;
        out.push(info);
      } else {
        dropped[reason] = (dropped[reason] || 0) + 1;
        dropped.total++;
        if (showAll) {
          info.rejected = reason;
          info.score -= 1000000;
          out.push(info);
        }
      }
    }

    out.sort(function (a, b) { return b.score - a.score; });

    /* Deduplicate AFTER sorting, so the copy that survives is the best-scoring
       one. Every addon indexes the same public torrents, so one release comes
       back a dozen times — that is most of why the list looks padded. */
    var seen = Object.create(null);
    var deduped = [];
    for (var k = 0; k < out.length; k++) {
      var key = dedupeKey(out[k]);
      if (seen[key]) continue;
      seen[key] = true;
      deduped.push(out[k]);
    }

    return { streams: deduped, dropped: dropped, total: raw.length, noteFor: noteLookup(deduped) };
  }

  /**
   * The per-row sentence, looked up by the raw object the caller kept.
   *
   * A linear scan and not a Map, for the same reason the rest of this file is
   * written in ES5: it is served unbundled to a webOS and a Tizen browser as
   * well as to Chrome. The cost is bounded anyway — the ranked list is at most
   * the 1200 cap and the caller asks once per RENDERED row, which is a few
   * dozen.
   */
  function noteLookup(list) {
    return function (rawStream) {
      for (var i = 0; i < list.length; i++) if (list[i].raw === rawStream) return explainSource(list[i]);
      return '';
    };
  }

  /* What each gate means in words a viewer can act on. Kept next to
     rejectReason's keys so that adding a gate without a sentence for it is
     visible here rather than silently rendering nothing. */
  var REJECT_TEXT = {
    nourl: 'it is a torrent hash with no direct link a browser can open',
    res: 'it is taller than this device can draw',
    codec: 'this browser has no decoder for its video',
    codec4k: 'this browser decodes that video codec only below 4K',
    size: 'it is too large for this connection'
  };

  /**
   * One sentence about one row, or '' when there is nothing worth saying.
   *
   * WHY THE PLAYER NEEDS THIS AT ALL. The audio gate removes rows that look
   * perfect in the list — a 2160p remux with the highest seed count is exactly
   * what a viewer expects to be offered — so a list that silently drops them
   * reads as a broken app. The one shape that must never be silent is the
   * fallback: a row kept BECAUSE nothing else played, which will produce a
   * picture with no sound. Being told that in advance is the difference
   * between a known limitation and a bug.
   */
  function explainSource(info) {
    if (!info) return '';
    if (info.audioSilent) {
      return 'No sound in this browser: ' + (info.audioLabel || 'this source\'s audio') +
        ' has no decoder here. Kept because every source for this title is the same.';
    }
    if (!info.rejected) return '';
    if (info.rejected === 'audio') {
      return 'Hidden: ' + (info.audioLabel || 'its audio') +
        ' has no decoder in this browser, so it would play as a silent picture.';
    }
    return REJECT_TEXT[info.rejected] ? 'Hidden: ' + REJECT_TEXT[info.rejected] + '.' : '';
  }

  function dedupeKey(info) {
    if (info.url) return 'u:' + info.url;
    return 'n:' + info.blob.replace(/[^a-z0-9]/g, '').slice(0, 80);
  }

  /* ────────────────────────────────────────────────────────────── trailers */

  /**
   * The trailer tier to ask the fleet for, mirroring the Fire TV's trailerCaps()
   * and the Roku's TrailerHeightWanted().
   *
   * WHY IT IS NOT JUST maxHeight. A trailer here autoplays behind the home
   * screen unasked, so it is spending bandwidth the viewer did not request. The
   * fleet's own tiers, measured 3 Sep 2026 against
   * https://fleet.lyreosai.com/trailer/play/dQw4w9WgXcQ?muxed=1&c=mp4 :
   *
   *     h=480   Content-Range .../11829048     11.8 MB
   *     h=720   Content-Range .../84426489     84.4 MB
   *     h=1080  Content-Range .../84426489     84.4 MB
   *     h=2160  Content-Range .../84426489     84.4 MB   (this title has no 4K)
   *
   * So the step from 480 to 720 is seven times the bytes for a picture playing
   * behind text. 1080 is the ceiling for an unattended preview even on a machine
   * that would happily take 2160 for a film — and the Roku makes the same call
   * for the same reason, holding Wi-Fi at 480 after an 84 MB progressive file
   * hung it at 13%.
   */
  function trailerHeight(caps) {
    if (!caps) return 480;
    if (caps.saveData) return 480;
    if (caps.effectiveType === 'slow-2g' || caps.effectiveType === '2g' || caps.effectiveType === '3g') return 480;
    if (caps.maxHeight >= 1080 && caps.highBitrateOk) return 1080;
    if (caps.maxHeight >= 1080) return 720;
    return 480;
  }

  /**
   * One fleet trailer URL, built the only correct way.
   *
   * `c=mp4` is not a preference. Above 1080p the fleet may serve VP9-in-WebM,
   * and while a browser decodes that happily, pinning MP4 keeps ONE url shape
   * across all six clients — the Roku cannot open VP9 inside an .mp4 and needs
   * the container decided before the fetch. A second shape here is a second
   * thing to keep in step.
   *
   * `muxed=1` is load-bearing: the plain route serves video-only plus a SEPARATE
   * audio track, because YouTube stopped muxing above 360p. A <video> given the
   * video-only stream plays in silence, which is exactly what the mute toggle
   * would then appear to be broken for.
   */
  function trailerUrl(fleetBase, ytId, caps) {
    if (!ytId) return '';
    var base = String(fleetBase || '').replace(/\/+$/, '');
    return base + '/trailer/play/' + encodeURIComponent(ytId) +
      '?muxed=1&c=mp4&h=' + trailerHeight(caps);
  }

  /* ─────────────────────────────────────────────────────────────── readout */

  /** Human-readable dump, for the console and for the smoke harness to assert on. */
  function describe(c) {
    var lines = [];
    lines.push('probe        ' + c.probeApi);
    /* Labelled ADVISORY on purpose. A reader who sees "panel 1080p" next to
       "max height 2160p" has to be told that is not a contradiction: on an
       Apple TV 4K the screen API reports the 1080 UI plane while the box
       outputs 2160, so the ceiling is taken from the decoder instead. */
    lines.push('panel        ' + c.panelPx + 'px  -> tier ' + c.panelTier + 'p  (advisory)');
    lines.push('max height   ' + c.maxHeight + 'p  (from ' + (c.any4k ? 'a 4K decoder' : 'no 4K decoder') + ')');
    lines.push('h264   ' + yn(c.h264) + '  smooth ' + yn(c.h264Smooth) + '  hw ' + yn(c.h264Hw) + '  4k ' + yn(c.h2644k));
    lines.push('hevc   ' + yn(c.hevc) + '  smooth ' + yn(c.hevcSmooth) + '  hw ' + yn(c.hevcHw) + '  4k ' + yn(c.hevc4k));
    lines.push('vp9    ' + yn(c.vp9) + '  smooth ' + yn(c.vp9Smooth) + '  hw ' + yn(c.vp9Hw) + '  4k ' + yn(c.vp94k));
    lines.push('av1    ' + yn(c.av1) + '  smooth ' + yn(c.av1Smooth) + '  hw ' + yn(c.av1Hw) + '  4k ' + yn(c.av14k));
    lines.push('hls          native ' + yn(c.hlsNative) + '   hls.js ' + yn(c.hlsJs));
    /* BOTH PATHS PRINTED, because they disagree and a reader who sees only one
       of them cannot tell a probe that ran from a probe that answered YES to
       everything. The four on the right of each line are the ones that decide
       whether a film has sound. */
    lines.push('audio probe  ' + (c.audioProbeApi || 'not probed'));
    lines.push('audio file   ' + audioLine(c.audioFile));
    lines.push('audio mse    ' + audioLine(c.audioMse));
    lines.push('memory       ' + (c.deviceMemory === null ? 'not reported' : c.deviceMemory + ' GB') + '   low ' + yn(c.lowMemory));
    lines.push('link         ' + (c.effectiveType || 'not reported') +
      '   downlink ' + (c.downlink === null ? '?' : c.downlink + ' Mbit') +
      '   saveData ' + yn(c.saveData) + '   high bitrate ' + yn(c.highBitrateOk));
    lines.push('max size     ' + c.maxSizeGb + ' GB');
    lines.push('trailer tier ' + trailerHeight(c) + 'p');
    return lines.join('\n');
  }

  function yn(b) { return b ? 'YES' : 'no'; }

  function audioLine(map) {
    var out = [];
    for (var i = 0; i < AUDIO_PROBES.length; i++) {
      var k = AUDIO_PROBES[i].key;
      out.push(k + ' ' + yn(map && map[k]));
    }
    return out.join('  ');
  }

  window.BlazingCaps = {
    probe: probe,
    describe: describe,
    rankStreams: rankStreams,
    parseStream: parseStream,
    rejectReason: rejectReason,
    /* The player's half of the audio gate. explainSource() turns one ranked row
       into the sentence to show beside it — see the noteFor() the ranking
       returns, which is the one-line hook a caller actually wants.
       audioSupports() and detectAudio() are exported so a harness can ask this
       browser the same question the ranking asked, rather than asserting
       against a table someone typed in. */
    explainSource: explainSource,
    audioSupports: audioSupports,
    detectAudio: detectAudio,
    AUDIO_LABELS: AUDIO_LABELS,
    trailerHeight: trailerHeight,
    trailerUrl: trailerUrl,
    prefersReducedMotion: prefersReducedMotion,
    TIERS: TIERS,
    /* The smoke harness needs a caps object it chose rather than the one this
       machine happens to have — a 4K desktop and a 1 GB phone cannot both be
       measured on one runner. Nothing in the app calls this. */
    _buildForTest: function (overrides) {
      var base = build({ file: {}, file4k: {}, mse: {} });
      for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
      base.any4k = !!(base.hevc4k || base.av14k || base.vp94k || base.h2644k);
      base.maxHeight = overrides.maxHeight || ceiling(base);
      return base;
    }
  };
})();
