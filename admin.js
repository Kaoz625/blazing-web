import { getConfig } from './locker.js';

export async function initAdmin() {
  const adminView = document.getElementById('admin-view');
  if (!adminView) return;

  const urlParams = new URLSearchParams(window.location.search);
  const deviceId = urlParams.get('deviceId');
  
  const linkingPanel = document.getElementById('admin-linking');
  const activityPanel = document.getElementById('admin-activity');
  const approveBtn = document.getElementById('admin-approve-btn');
  const linkText = document.getElementById('admin-link-text');
  const activityList = document.getElementById('admin-activity-list');
  
  // Wait for the user to be logged in (we need ADMIN_TOKEN)
  const cfg = getConfig();
  const fleetUrl = cfg.fleet || 'http://localhost:7020';
  
  if (deviceId) {
    linkingPanel.hidden = false;
    linkText.textContent = `Approve device ID: ${deviceId}?`;
    
    approveBtn.onclick = async () => {
      approveBtn.disabled = true;
      approveBtn.textContent = "Approving...";
      try {
        const token = prompt("Enter Admin Token:");
        if (!token) throw new Error("Cancelled");
        
        const res = await fetch(`${fleetUrl}/admin/devices/${deviceId}/approve`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (res.ok) {
          approveBtn.textContent = "Approved!";
          setTimeout(() => {
            window.location.search = ''; // clear deviceId from URL
          }, 1500);
        } else {
          const err = await res.json();
          throw new Error(err.error || 'Failed');
        }
      } catch (err) {
        alert("Error: " + err.message);
        approveBtn.disabled = false;
        approveBtn.textContent = "Approve Device";
      }
    };
  } else {
    linkingPanel.hidden = true;
  }
  
  // Fetch activity
  async function fetchActivity() {
    if (adminView.hidden) return; // Only fetch if visible
    
    try {
      // In a real app we'd store the admin token in localStorage.
      const token = localStorage.getItem('adminToken');
      if (!token) return;
      
      const res = await fetch(`${fleetUrl}/admin/activity`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        renderActivity(data.activity);
      }
    } catch (e) {
      console.error("[Admin] Failed to fetch activity", e);
    }
  }
  
  function renderActivity(activity) {
    if (!activity || activity.length === 0) {
      activityList.innerHTML = "<p>No active watchers.</p>";
      return;
    }
    
    activityList.innerHTML = activity.map(act => {
      const prog = act.progress[0]; // Just showing the most recent
      if (!prog) return '';
      return `
        <div class="card">
          <img src="${prog.poster}" alt="Poster" style="width:100%; border-radius:8px;">
          <h3>${prog.title}</h3>
          <p>Profile: ${act.name}</p>
          <p>${prog.progress}% watched</p>
        </div>
      `;
    }).join('');
  }
  
  // Set up polling for activity when visible
  
  // Fetch upscale requests
  async function fetchUpscaleRequests() {
    if (adminView.hidden) return;
    
    const list = document.getElementById('admin-upscale-list');
    try {
      const res = await fetch('https://upscale.lyreosai.com/api/upscale/list');
      if (res.ok) {
        renderUpscale(await res.json());
        return;
      }
      // SAY SO. This panel is the admin's diagnostic surface, and `if (res.ok)`
      // with no else meant a missing endpoint looked identical to an empty
      // queue. /api/upscale/list is in fact a 404 right now — the service's own
      // spec at /openapi.json lists only POST /api/search,
      // /api/upscale/request, /api/upscale/approve and /api/clone. So this
      // panel cannot fill until the backend adds it, and it now says that
      // rather than showing a blank box that reads as "nothing queued".
      if (list) {
        list.innerHTML = "<p>The upscale service has no /api/upscale/list endpoint yet (HTTP " +
          res.status + "), so the queue cannot be listed here.</p>";
      }
    } catch (e) {
      console.error("[Admin] Failed to fetch upscale requests", e);
      if (list) list.innerHTML = "<p>Could not reach the upscale service.</p>";
    }
  }

  function renderUpscale(data) {
    const list = document.getElementById('admin-upscale-list');
    if (!list) return;
    
    
    const requests = data.requests || [];
    if (requests.length === 0) {
      list.innerHTML = "<p>No upscale requests yet.</p>";
      return;
    }
    
    list.innerHTML = requests.map(req => {
      const users = req.requested_by || [];
      return \`
        <div class="card" style="padding: 1rem;">
          <h3 style="margin-top: 0;">${req.title}</h3>
          <p><strong>Type:</strong> ${req.media_type}</p>
          <p><strong>Requests:</strong> ${req.request_count || 1}</p>
          <p><strong>Users IP:</strong><br>${users.join('<br>')}</p>
        </div>
      \`;
    }).join('');
  }
  setInterval(fetchUpscaleRequests, 10000);
  fetchUpscaleRequests();

  setInterval(fetchActivity, 10000);
  
  // Listen for admin token button if needed
  window.setAdminToken = () => {
    const t = prompt("Enter Admin Token:");
    if (t) {
      localStorage.setItem('adminToken', t);
      fetchActivity();
    }
  };
}

initAdmin();
