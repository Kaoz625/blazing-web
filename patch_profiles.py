import re

with open('app.js', 'r') as f:
    app_js = f.read()

# Replace profile picker logic
new_profile_picker = """
      if (pData.profiles && pData.profiles.length > 1) {
        const d = $('#profile-picker');
        const l = $('#profile-list');
        
        // Fetch recent progress for all profiles (we'll fetch for each sequentially)
        for (const p of pData.profiles) {
          const b = document.createElement('button');
          b.className = 'primary-button';
          b.style.display = 'flex';
          b.style.flexDirection = 'column';
          b.style.alignItems = 'center';
          b.style.padding = '16px';
          b.style.height = 'auto';
          
          let resumeText = '';
          try {
            const progRes = await fetch(`${API_BASE}/api/sync/progress/recent?profileId=${p.id}`);
            const progData = await progRes.json();
            if (progData.recent && progData.recent.length > 0) {
              const lastItem = progData.recent[0];
              resumeText = `RESUME:\\n${lastItem.name || 'Unknown'}`;
            }
          } catch (e) { console.error('Failed to get progress for', p.id); }

          b.innerHTML = `<strong>${p.name}</strong><span style="font-size:12px;opacity:0.8;margin-top:8px;white-space:pre-wrap;">${resumeText}</span>`;
          b.onclick = () => { localStorage.setItem('profileId', p.id); d.close(); loadContinueWatching(); };
          l.appendChild(b);
        }
        d.showModal();
      }
"""

app_js = app_js.replace("""
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
      }
""", new_profile_picker.strip())

with open('app.js', 'w') as f:
    f.write(app_js)
