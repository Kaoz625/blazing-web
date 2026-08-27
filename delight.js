'use strict';

/* ============================================================
   Phase 4: Google X Delight Features
   1. Circadian Display Engine
   2. QR-Code Companion Handoff
   3. Voice Control (Speech-to-Intent)
   4. Cinematic Parallax & Volumetric Fog
   ============================================================ */

const Delight = {
  init() {
    this.initCircadian();
    this.initVoiceControl();
    this.initParallax();
    
    // Inject QR and Voice UI elements globally
    this.injectUI();
  },

  /* ── 1. Circadian Display Engine ────────────────────────── */
  initCircadian() {
    const applyCircadian = () => {
      const hour = new Date().getHours();
      const isNight = hour >= 19 || hour < 6; // 7 PM to 6 AM
      document.documentElement.classList.toggle('circadian-night', isNight);
    };
    applyCircadian();
    setInterval(applyCircadian, 60000); // Check every minute
  },

  /* ── 2. QR Companion Handoff ────────────────────────────── */
  showQRHandOff(url, title) {
    let modal = document.getElementById('qr-modal');
    if (!modal) {
      modal = document.createElement('dialog');
      modal.id = 'qr-modal';
      modal.className = 'bm-dialog';
      modal.innerHTML = `
        <div class="bm-dialog-content" style="text-align: center;">
          <h2 id="qr-title">Send to Phone</h2>
          <p style="margin-bottom: 24px; color: var(--muted);">Scan this code to continue watching on your phone.</p>
          <img id="qr-img" src="" alt="QR Code" style="border-radius: 16px; margin-bottom: 24px;" />
          <br>
          <button class="primary-button" onclick="document.getElementById('qr-modal').close()">Done</button>
        </div>
      `;
      document.body.appendChild(modal);
    }
    
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}&bgcolor=141416&color=FFD700`;
    document.getElementById('qr-title').textContent = `Send "${title}" to Phone`;
    document.getElementById('qr-img').src = qrUrl;
    modal.showModal();
  },

  /* ── 3. Voice Control ───────────────────────────────────── */
  initVoiceControl() {
    if (!('webkitSpeechRecognition' in window)) return;

    this.recognition = new webkitSpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = false;

    this.recognition.onstart = () => {
      const btn = document.getElementById('voice-btn');
      if(btn) btn.classList.add('recording');
    };

    this.recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      console.log('Voice Intent:', transcript);
      
      // Simple intent parsing
      const t = transcript.toLowerCase();
      if (t.includes('play') || t.includes('watch') || t.includes('find')) {
        const query = t.replace(/(play|watch|find|show me)/, '').trim();
        if (query) {
          // Open search and populate
          window.location.hash = 'search';
          const input = document.getElementById('search-input');
          if (input) {
            input.value = query;
            input.dispatchEvent(new Event('input')); // trigger search
          }
        }
      } else if (t.includes('home')) {
        document.querySelector('[data-view="home"]')?.click();
      } else if (t.includes('family')) {
        document.querySelector('[data-view="family"]')?.click();
      } else if (t.includes('stories')) {
        document.querySelector('[data-view="stories"]')?.click();
      }
    };

    this.recognition.onend = () => {
      const btn = document.getElementById('voice-btn');
      if(btn) btn.classList.remove('recording');
    };
  },

  startVoice() {
    if (this.recognition) {
      try { this.recognition.start(); } catch(e){}
    } else {
      alert("Voice control isn't supported on this browser.");
    }
  },

  /* ── 4. Cinematic Parallax & UI Injection ───────────────── */
  initParallax() {
    document.addEventListener('mousemove', (e) => {
      const heroArt = document.querySelector('.hero-art');
      if (!heroArt) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 20;
      const y = (e.clientY / window.innerHeight - 0.5) * 20;
      heroArt.style.transform = `scale(1.05) translate(${x}px, ${y}px)`;
    });
  },

  injectUI() {
    // Add voice button to topnav
    const topnav = document.querySelector('.topnav');
    if (topnav && !document.getElementById('voice-btn')) {
      const vBtn = document.createElement('button');
      vBtn.id = 'voice-btn';
      vBtn.className = 'icon-button';
      vBtn.innerHTML = '🎙️';
      vBtn.title = "Voice Control";
      vBtn.onclick = () => this.startVoice();
      topnav.appendChild(vBtn);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => Delight.init());

// Expose QR handoff globally so Detail screen can call it
window.showQRHandOff = (url, title) => Delight.showQRHandOff(url, title);
