/**
 * Emby (Killah.TV) + Seerr (killahrequest.online) — through the FLEET.
 *
 * THIS FILE HOLDS NO CREDENTIALS AND KNOWS NO EMBY HOSTNAME, and that is the
 * whole point of it. It is client-side JavaScript served from a public CDN:
 * anything in here is readable by anyone who opens the page. The first version
 * of this file called `authenticate('<user>', '<password>')` with the real Emby
 * login as literals, and built poster URLs ending `&api_key=<server token>`.
 *
 * It also could not work. The page is HTTPS, Emby is plain http:// — the browser
 * blocks that as mixed content, so every row was permanently empty.
 *
 * So the fleet does all of it: it holds the password, it proxies the posters and
 * the video, and it answers over HTTPS. Every call below is a plain GET or POST
 * to fleet.lyreosai.com with no secret attached.
 */
(function () {
  const BASE = (window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com').replace(/\/+$/, '');

  const getJson = async (path, timeoutMs = 15000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`${BASE}${path}`, { signal: controller.signal });
      if (!r.ok) throw new Error(`${path} -> ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };

  // Every read answers an empty list instead of throwing. An Emby outage must
  // cost one hidden row on the home screen, never a broken page.
  const metasOf = async (path) => {
    try {
      const data = await getJson(path);
      return Array.isArray(data && data.metas) ? data.metas : [];
    } catch (e) {
      console.warn('[emby]', path, e && e.message);
      return [];
    }
  };

  window.BlazingEmby = {
    base: BASE,
    health: () => getJson('/emby/health').catch(() => ({ ok: true, emby: false, seerr: false })),
    latest: (type, limit = 12) =>
      metasOf(`/emby/latest/${type === 'series' ? 'series' : 'movie'}?limit=${Number(limit) || 12}`),
    livetv: (limit = 12) => metasOf(`/emby/livetv?limit=${Number(limit) || 12}`),
    search: (q, type) =>
      metasOf(`/emby/search?q=${encodeURIComponent(q)}${type ? `&type=${encodeURIComponent(type)}` : ''}`),
    // The ONLY URL a player is ever given. The fleet forwards Range, so seeking works.
    streamUrl: (embyId) => `${BASE}/emby/stream/${encodeURIComponent(embyId)}`,

    seerrSearch: async (q) => {
      try {
        const data = await getJson(`/seerr/search?q=${encodeURIComponent(q)}`);
        return Array.isArray(data && data.results) ? data.results : [];
      } catch (e) {
        console.warn('[seerr] search', e && e.message);
        return null; // null means "the search itself failed", which is not "no results".
      }
    },

    // The one call that may fail loudly: someone pressed a button and is waiting.
    seerrRequest: async (tmdbId, mediaType) => {
      const r = await fetch(`${BASE}/seerr/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tmdbId, mediaType }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || data.error) {
        throw new Error((data && data.error) || `request failed (${r.status})`);
      }
      return data;
    },
  };
})();
