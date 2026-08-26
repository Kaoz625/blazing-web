import re
import os

app_js = open('app.js').read()
index_html = open('index.html').read()
styles_css = open('styles.css').read()

# 1. Stream Health Badges (app.js & styles.css)
styles_css += """
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: 800; font-size: 11px; margin-right: 6px; }
.badge-4k { background: #8a2be2; color: #fff; }
.badge-1080 { background: #007bff; color: #fff; }
.badge-720 { background: #28a745; color: #fff; }
.badge-sd { background: #6c757d; color: #fff; }
.stream-meta { font-size: 11px; color: var(--muted); margin-top: 4px; display: flex; gap: 8px; }
"""
stream_html_replacement = r"""
      let qualityBadge = 'badge-sd';
      if (/4k|2160/i.test(q)) qualityBadge = 'badge-4k';
      else if (/1080/i.test(q)) qualityBadge = 'badge-1080';
      else if (/720/i.test(q)) qualityBadge = 'badge-720';
      
      const sizeMatch = title.match(/(?:\b\d+(?:\.\d+)?\s*(?:GB|MB)\b)/i);
      const seedMatch = title.match(/(?:👤|👥|S:|Seeders?:?)\s*(\d+)/i);
      const size = sizeMatch ? sizeMatch[0] : '';
      const seeders = seedMatch ? `👤 ${seedMatch[1]}` : '';
      
      row.innerHTML = `
        <div class="stream-info">
          <div class="stream-q"><span class="badge ${qualityBadge}">${q}</span></div>
          <div class="stream-title">${title}</div>
          <div class="stream-meta"><span>${size}</span><span>${seeders}</span></div>
        </div>
      `;
"""
# Use manual replace instead of re.sub
start_idx = app_js.find('row.innerHTML = `')
if start_idx != -1:
    end_idx = app_js.find('`;', start_idx) + 2
    app_js = app_js[:start_idx] + stream_html_replacement.strip() + app_js[end_idx:]

# 2. AI Story Search
index_html = index_html.replace(
    '<form id="search-form" class="search-form" role="search">',
    '<form id="search-form" class="search-form" role="search">\n        <button type="button" id="ai-search-toggle" class="secondary-button" style="width: auto;">🤖 AI</button>'
)
app_js = app_js.replace(
    "const searchView = $('#search-view');",
    "const searchView = $('#search-view');\nlet aiSearchActive = false;"
)
search_logic = """
  if (aiSearchActive) {
    status.textContent = 'Searching with AI...';
    try {
      const res = await fetch(`${API_BASE}/api/ai-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      const metas = (Array.isArray(data.results) ? data.results : []).map(safeMeta).filter(Boolean);
      if (metas.length) {
        target.appendChild(buildResultRow('AI Results', metas));
        status.textContent = `Found ${metas.length} AI results.`;
      } else {
        status.textContent = 'No titles found via AI.';
      }
    } catch {
      status.textContent = 'AI search failed.';
    }
    return;
  }
"""
app_js = app_js.replace("status.textContent = 'Searching all sources…';", search_logic + "\n  status.textContent = 'Searching all sources…';")

app_js += """
const aiToggle = $('#ai-search-toggle');
if (aiToggle) {
  aiToggle.addEventListener('click', () => {
    aiSearchActive = !aiSearchActive;
    aiToggle.style.background = aiSearchActive ? 'var(--accent)' : '';
    $('#search-input').placeholder = aiSearchActive ? 'Describe a plot or storyline...' : 'Search movies and shows';
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search-input')) {
    e.preventDefault();
    if (state.route !== 'search') showRoute('search');
    else $('#search-input').focus();
  }
});
"""

# 3. Continue Watching row & 4. Profile Picker & 6. Cloud Sync
# Profiles
index_html = index_html.replace(
    '<main id="app-main">',
    """
  <dialog id="profile-picker" class="detail-dialog" style="padding: 24px; text-align: center;">
    <h2>Who's Watching?</h2>
    <div id="profile-list" style="display: flex; gap: 16px; justify-content: center; margin-top: 24px; flex-wrap: wrap;"></div>
  </dialog>
  <main id="app-main">
"""
)

boot_patch = """
  const profileId = localStorage.getItem('profileId');
  if (!profileId) {
    try {
      const pRes = await fetch(`${API_BASE}/api/profiles`);
      const pData = await pRes.json();
      if (pData.profiles && pData.profiles.length > 1) {
        const d = $('#profile-picker');
        const l = $('#profile-list');
        pData.profiles.forEach(p => {
          const b = document.createElement('button');
          b.className = 'primary-button';
          b.textContent = p.name;
          b.onclick = () => { localStorage.setItem('profileId', p.id); d.close(); loadContinueWatching(); };
          l.appendChild(b);
        });
        d.showModal();
      } else if (pData.profiles && pData.profiles.length === 1) {
        localStorage.setItem('profileId', pData.profiles[0].id);
        loadContinueWatching();
      }
    } catch (e) {}
  } else {
    loadContinueWatching();
  }
"""
app_js = app_js.replace("rowsWrap.replaceChildren();", boot_patch + "\n  rowsWrap.replaceChildren();")

app_js += """
async function loadContinueWatching() {
  const profileId = localStorage.getItem('profileId');
  if (!profileId) return;
  try {
    const res = await fetch(`${API_BASE}/api/sync/progress/recent?profileId=${profileId}`);
    const data = await res.json();
    if (data.items && data.items.length) {
      const section = buildRowSkeleton({ id: 'continue-watching', name: 'Continue Watching', type: 'mixed' });
      rowsWrap.prepend(section);
      const track = $('.row-track', section);
      const metas = data.items.map(safeDiscoverMeta).filter(Boolean);
      track.replaceChildren(...metas.map(m => {
        const c = buildCard(m);
        if (m.progress) {
          const bar = document.createElement('div');
          bar.className = 'progress-bar';
          bar.innerHTML = `<div class="progress-fill" style="width: ${Math.min(100, (m.progress.position / m.progress.duration) * 100)}%"></div>`;
          c.appendChild(bar);
        }
        return c;
      }));
    }
  } catch (e) {}
}
"""

styles_css += """
.progress-bar { position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(255,255,255,0.2); }
.progress-fill { height: 100%; background: var(--accent); }
"""

sync_logic = """
let syncInterval = null;
function startSync(meta) {
  stopSync();
  syncInterval = setInterval(() => {
    if (!video.duration || video.paused) return;
    const profileId = localStorage.getItem('profileId');
    if (!profileId) return;
    fetch(`${API_BASE}/api/sync/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imdbId: meta.id, position: video.currentTime, duration: video.duration, profileId })
    }).catch(()=>{});
  }, 30000);
}
function stopSync() {
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = null;
}
"""
app_js += "\n" + sync_logic

index_html = index_html.replace(
    '<div id="player-spinner" class="spinner big" hidden></div>',
    '<div id="player-spinner" class="spinner big" hidden></div>\n      <button id="resume-btn" class="primary-button" hidden style="position: absolute; bottom: 60px; z-index: 10;">Resume</button>'
)

app_js = app_js.replace("video.src = finalUrl;\n  video.load();", """
  video.src = finalUrl;
  video.load();
  startSync({ id: state.selected?.id });
  const profileId = localStorage.getItem('profileId');
  if (profileId && state.selected?.id) {
    fetch(`${API_BASE}/api/sync/progress/${state.selected.id}?profileId=${profileId}`)
      .then(r => r.json())
      .then(d => {
        if (d.position && d.position > 60) {
          const b = $('#resume-btn');
          b.hidden = false;
          b.textContent = `Resume from ${Math.floor(d.position / 60)}:${Math.floor(d.position % 60).toString().padStart(2, '0')}?`;
          b.onclick = () => { video.currentTime = d.position; b.hidden = true; };
          setTimeout(() => { b.hidden = true; }, 10000);
        }
      }).catch(()=>{});
  }
""")

app_js = app_js.replace("function closePlayer() {", "function closePlayer() {\n  stopSync();\n  if($('#resume-btn')) $('#resume-btn').hidden = true;")

# 5. Glassmorphism detail overlay
styles_css = styles_css.replace(
    ".detail-dialog { width: min(900px, calc(100% - 24px)); max-height: min(760px, calc(100vh - 24px)); overflow: hidden; padding: 0; border: 1px solid rgba(255,255,255,.1); border-radius: 24px; color: var(--text); background: var(--surface); box-shadow: 0 30px 100px rgba(0,0,0,.75); }",
    ".detail-dialog { width: min(900px, calc(100% - 24px)); max-height: min(760px, calc(100vh - 24px)); overflow: hidden; padding: 0; border: 1px solid rgba(255,255,255,.1); border-radius: 24px; color: var(--text); background: rgba(20,20,22,0.4); backdrop-filter: blur(20px); box-shadow: 0 30px 100px rgba(0,0,0,.75); }"
)

styles_css = styles_css.replace(
    ".detail-card::after { content: \"\"; position: absolute; inset: 0; z-index: -1; background: linear-gradient(90deg, rgba(20,20,22,.99), rgba(20,20,22,.78) 54%, rgba(20,20,22,.22)); }",
    ".detail-card::after { content: \"\"; position: absolute; inset: 0; z-index: -1; background: linear-gradient(90deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.65) 45%, rgba(0,0,0,.3) 100%); }"
)

open('app.js', 'w').write(app_js)
open('index.html', 'w').write(index_html)
open('styles.css', 'w').write(styles_css)

