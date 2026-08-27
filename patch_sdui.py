import re

with open('app.js', 'r') as f:
    app_js = f.read()

# Replace boot function
new_boot = """
async function loadSDUIRow(catalogInfo, section) {
  const track = $('.row-track', section);
  if (!catalogInfo.catalogSlug) {
    if (catalogInfo.id === 'continue') return loadContinueWatchingRow(section);
    section.remove();
    return [];
  }
  
  const fetchUrl = `${API_BASE}/catalog/tv/${catalogInfo.catalogSlug}.json`;
  
  try {
    const data = await fetchJSON(fetchUrl);
    const rawMetas = Array.isArray(data.metas) ? data.metas : (Array.isArray(data) ? data : []);
    
    const metas = rawMetas
      .map((item) => safeDiscoverMeta({ ...item, type: item.type || catalogInfo.type }))
      .filter(Boolean);
      
    if (!metas.length) {
      section.remove();
      return [];
    }
    track.replaceChildren(...metas.map(buildCard));
    return metas;
  } catch {
    section.remove();
    return [];
  }
}

async function loadContinueWatchingRow(section) {
  // Use existing logic for continue watching
  loadContinueWatching();
  section.remove(); // The existing logic creates its own row at the top
  return [];
}

async function boot() {
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

  rowsWrap.replaceChildren();
  state.featured = null;
  hero.classList.add('hero-loading');

  try {
    const inviteCode = localStorage.getItem('validInviteCode');
    const mode = inviteCode ? 'blazing' : 'safe';
    const uiRes = await fetch(`${API_BASE}/api/ui/home-config?mode=${mode}`);
    const uiConfig = await uiRes.json();
    
    // Apply UI config
    document.title = uiConfig.appName;
    const brandSpan = $('.brand-mark').nextElementSibling;
    if (brandSpan) brandSpan.textContent = uiConfig.appName;
    document.documentElement.style.setProperty('--accent', uiConfig.accentColor);
    document.documentElement.setAttribute('data-theme', uiConfig.theme);
    
    // Build rows from SDUI config
    const jobs = (uiConfig.homeRows || []).map((row) => {
      const catalogInfo = {
        id: row.id,
        type: row.type === 'cinematic_hero' ? 'movie' : 'series', // Default fallback
        name: row.label,
        catalogSlug: row.catalogSlug
      };
      
      const section = buildRowSkeleton(catalogInfo);
      if (row.type === 'cinematic_hero') {
        section.dataset.freshShelf = 'true';
      }
      rowsWrap.appendChild(section);
      
      return loadSDUIRow(catalogInfo, section);
    });
    
    const rows = await Promise.all(jobs);
    const first = rows.find((metas) => metas && metas.length)?.[0];
    if (first && !state.featured) setHero(first);
    else if (!state.featured) emptyHero('Nothing is available right now. Try again soon.');

  } catch (err) {
    console.error('SDUI Boot Error', err);
    emptyHero('Could not load Blazing configuration.');
  }

  applyRowFilter(state.route);
}
"""

boot_pattern = re.compile(r'async function boot\(\) \{.*?\n\}\n', re.DOTALL)
app_js = boot_pattern.sub(new_boot, app_js)

with open('app.js', 'w') as f:
    f.write(app_js)

with open('styles.css', 'a') as f:
    f.write('''
/* 10-foot UI D-pad magnetic focus engine */
@media (pointer: coarse), (hover: none) {
  .card:focus-visible, .primary-button:focus-visible, .secondary-button:focus-visible, button:focus-visible {
    transform: scale(1.08);
    box-shadow: 0 0 15px var(--accent-glow);
    outline: 3px solid var(--accent);
    outline-offset: 4px;
    z-index: 10;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
}

[data-theme="kids_warm"] {
  --bg: #1a1510;
  --surface: #261f1a;
  --text: #fffdfa;
  --accent: #FFD700;
  --accent-glow: rgba(255, 215, 0, 0.4);
}
''')

