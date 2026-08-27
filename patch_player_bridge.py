import re

with open('app.js', 'r') as f:
    app_js = f.read()

new_open_player = """
const Platform = {
  isRoku:    !!window.Roku,
  isTizen:   !!window.tizen,
  isAndroid: !!window.AndroidBridge,
  isAppleTV: !!window.webkit?.messageHandlers?.avplayer,
  isWeb:     true
};

function openPlayer(title, rawUrl) {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return;
  
  if (Platform.isAppleTV) {
    window.webkit.messageHandlers.avplayer.postMessage({ url });
    return;
  }
  if (Platform.isAndroid) {
    window.AndroidBridge.postMessage(JSON.stringify({ cmd: 'play', url, title }));
    return;
  }
  if (Platform.isTizen) {
    if (window.webapis && window.webapis.avplay) {
      // Basic tizen setup
      window.webapis.avplay.open(url);
      window.webapis.avplay.play();
    }
    return;
  }
  if (Platform.isRoku) {
    window.location = `blazeos://play?url=${encodeURIComponent(url)}`;
    return;
  }

  // Fallback to web HTML5 video
  const session = (playSession += 1);
  playerTitle.textContent = title;
  player.hidden = false;
  document.body.classList.add('no-scroll');

  setPlayerState('loading');
  watchPlayerLoad(session, url, true);

  video.src = url;
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
      });
  }

  const play = video.play();
  if (play && typeof play.catch === 'function') play.catch(() => {});
}
"""

app_js = re.sub(r'function openPlayer\(title, rawUrl\) \{.*?(?=function startSync)', new_open_player, app_js, flags=re.DOTALL)

with open('app.js', 'w') as f:
    f.write(app_js)
