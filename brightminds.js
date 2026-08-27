/* ============================================================
   BrightMinds Feature UIs — Phase 3
   1. AI Storybook Generator + Animated Reader
   2. NotebookLM Deep Dive Podcast Visualizer
   3. Living Family Tree Interactive Explorer
   ============================================================ */
'use strict';

const BM_API = 'https://addon.lyreosai.com';

/* ── Shared Utilities ──────────────────────────────────────── */
function bmFetch(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  return fetch(url, { signal: ctl.signal, ...opts }).finally(() => clearTimeout(t));
}

/* ── 1. AI STORYBOOK GENERATOR + READER ──────────────────── */
const Storybook = {
  currentStory: null,
  currentPage: 0,
  synth: window.speechSynthesis,
  reading: false,

  renderSection() {
    const sec = document.getElementById('brightminds-stories');
    if (!sec) return;
    sec.innerHTML = `
      <div class="bm-stories-layout">
        <div class="bm-panel bm-generator">
          <div class="page-heading">
            <p class="eyebrow">BrightMinds</p>
            <h1>📖 Your Personal Story</h1>
            <p>Enter 3 words and we'll create an illustrated 6-page adventure starring your child.</p>
          </div>
          <form id="story-form" class="bm-form">
            <div class="bm-form-row">
              <label for="story-hero">Hero's Name</label>
              <input id="story-hero" type="text" placeholder="e.g. Leo" maxlength="24" required />
            </div>
            <div class="bm-form-row">
              <label for="story-companion">Companion</label>
              <input id="story-companion" type="text" placeholder="e.g. Golden Retriever" maxlength="32" />
            </div>
            <div class="bm-form-row">
              <label for="story-world">World</label>
              <input id="story-world" type="text" placeholder="e.g. Dinosaur Planet" maxlength="32" required />
            </div>
            <div class="bm-form-row">
              <label for="story-age">Age Level</label>
              <select id="story-age">
                <option value="toddler">Toddler (2-4)</option>
                <option value="early" selected>Early Reader (5-7)</option>
                <option value="middle">Middle Grade (8-12)</option>
                <option value="teen">Teen (13+)</option>
              </select>
            </div>
            <button class="primary-button" type="submit" id="story-generate-btn">✨ Create My Story</button>
          </form>
          <p id="story-status" class="bm-status" role="status"></p>
          <div class="bm-story-library">
            <h2>My Story Library</h2>
            <div id="story-library-list" class="bm-library-grid"></div>
          </div>
        </div>

        <div class="bm-panel bm-reader" id="bm-reader" hidden>
          <div class="bm-reader-bar">
            <button class="icon-button" id="reader-close" aria-label="Close reader">✕</button>
            <span id="reader-title" class="bm-reader-title"></span>
            <button class="secondary-button" id="reader-narrate" aria-label="Read aloud">🔊 Read Aloud</button>
            <button class="secondary-button" id="reader-share" aria-label="Share story">📤 Share</button>
          </div>
          <div class="bm-book" id="bm-book">
            <div class="bm-page-art" id="bm-page-art"></div>
            <div class="bm-page-text" id="bm-page-text"></div>
            <div class="bm-page-nav">
              <button class="secondary-button" id="page-prev" aria-label="Previous page">← Prev</button>
              <span id="page-indicator" class="bm-page-indicator">Page 1 of 6</span>
              <button class="primary-button" id="page-next" aria-label="Next page">Next →</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('story-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.generate();
    });
    document.getElementById('reader-close').addEventListener('click', () => this.closeReader());
    document.getElementById('page-prev').addEventListener('click', () => this.turnPage(-1));
    document.getElementById('page-next').addEventListener('click', () => this.turnPage(1));
    document.getElementById('reader-narrate').addEventListener('click', () => this.toggleNarration());
    document.getElementById('reader-share').addEventListener('click', () => this.shareStory());

    this.loadLibrary();
  },

  async generate() {
    const hero = document.getElementById('story-hero')?.value?.trim();
    const companion = document.getElementById('story-companion')?.value?.trim();
    const world = document.getElementById('story-world')?.value?.trim();
    const age = document.getElementById('story-age')?.value;
    const status = document.getElementById('story-status');
    const btn = document.getElementById('story-generate-btn');
    if (!hero || !world) return;

    btn.disabled = true;
    btn.textContent = '⏳ Generating…';
    status.textContent = 'Creating your story. This takes about 10 seconds…';

    try {
      const res = await bmFetch(`${BM_API}/api/stories/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heroName: hero, companion, worldTheme: world, targetAge: age }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const story = await res.json();
      status.textContent = '🎉 Your story is ready!';
      this.openReader(story);
      this.loadLibrary();
    } catch (e) {
      status.textContent = `Couldn't generate story right now. Try again! (${e.message})`;
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Create My Story';
    }
  },

  async loadLibrary() {
    const list = document.getElementById('story-library-list');
    if (!list) return;
    try {
      const res = await bmFetch(`${BM_API}/api/stories/list`);
      const data = await res.json();
      const stories = data.stories || [];
      if (!stories.length) { list.innerHTML = '<p class="bm-empty">No stories yet — create your first one!</p>'; return; }
      list.innerHTML = '';
      stories.slice(0, 12).forEach((s) => {
        const card = document.createElement('button');
        card.className = 'bm-story-card';
        card.innerHTML = `
          <div class="bm-story-card-emoji">${s.coverEmoji || '📖'}</div>
          <div class="bm-story-card-title">${s.title || 'My Story'}</div>
          <div class="bm-story-card-meta">${s.heroName || ''} · ${(s.createdAt || '').slice(0, 10)}</div>
        `;
        card.addEventListener('click', () => this.openReader(s));
        list.appendChild(card);
      });
    } catch {
      list.innerHTML = '<p class="bm-empty">Couldn\'t load library.</p>';
    }
  },

  openReader(story) {
    this.currentStory = story;
    this.currentPage = 0;
    const reader = document.getElementById('bm-reader');
    if (reader) reader.hidden = false;
    document.getElementById('reader-title').textContent = story.title || 'My Story';
    this.renderPage();
  },

  closeReader() {
    const reader = document.getElementById('bm-reader');
    if (reader) reader.hidden = true;
    this.stopNarration();
    this.currentStory = null;
  },

  renderPage() {
    const s = this.currentStory;
    if (!s || !s.pages) return;
    const page = s.pages[this.currentPage] || {};
    const art = document.getElementById('bm-page-art');
    const text = document.getElementById('bm-page-text');
    const indicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('page-prev');
    const nextBtn = document.getElementById('page-next');

    const book = document.getElementById('bm-book');
    book.classList.add('bm-page-turning');
    setTimeout(() => book.classList.remove('bm-page-turning'), 400);

    const colors = ['#1a0533','#0a1a33','#001a0a','#33150a','#0a2033'];
    const bgColor = colors[this.currentPage % colors.length];
    art.style.background = bgColor;
    art.innerHTML = `<div class="bm-page-illustration">${page.illustrationEmojis || '🌟'}</div>`;

    text.innerHTML = `
      <p class="bm-page-number">Page ${this.currentPage + 1} of ${s.pages.length}</p>
      <p class="bm-page-content">${page.text || ''}</p>
    `;
    indicator.textContent = `Page ${this.currentPage + 1} of ${s.pages.length}`;
    prevBtn.disabled = this.currentPage === 0;
    nextBtn.textContent = this.currentPage === s.pages.length - 1 ? '🎉 The End' : 'Next →';
    nextBtn.disabled = false;
  },

  turnPage(direction) {
    if (!this.currentStory?.pages) return;
    const next = this.currentPage + direction;
    if (next < 0 || next >= this.currentStory.pages.length) return;
    this.currentPage = next;
    this.stopNarration();
    this.renderPage();
  },

  toggleNarration() {
    if (this.reading) { this.stopNarration(); return; }
    const page = this.currentStory?.pages?.[this.currentPage];
    if (!page?.text || !this.synth) return;
    const utt = new SpeechSynthesisUtterance(page.text);
    utt.rate = 0.85;
    utt.pitch = 1.1;
    utt.onend = () => { this.reading = false; document.getElementById('reader-narrate').textContent = '🔊 Read Aloud'; };
    this.synth.speak(utt);
    this.reading = true;
    document.getElementById('reader-narrate').textContent = '⏹ Stop';
  },

  stopNarration() {
    if (this.synth) this.synth.cancel();
    this.reading = false;
    const btn = document.getElementById('reader-narrate');
    if (btn) btn.textContent = '🔊 Read Aloud';
  },

  shareStory() {
    const s = this.currentStory;
    if (!s) return;
    const text = `My child just got their own personalized story: "${s.title}" — powered by BrightMinds!`;
    if (navigator.share) {
      navigator.share({ title: s.title, text }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(text);
      alert('Story link copied to clipboard!');
    }
  }
};

/* ── 2. NOTEBOOKLM DEEP DIVE PODCAST VISUALIZER ──────────── */
const PodcastStudio = {
  currentPodcast: null,
  audioEl: null,
  transcriptInterval: null,

  renderSection() {
    const sec = document.getElementById('brightminds-podcasts');
    if (!sec) return;
    sec.innerHTML = `
      <div class="bm-podcast-layout">
        <div class="bm-panel bm-podcast-gen">
          <div class="page-heading">
            <p class="eyebrow">Deep Dive Studio</p>
            <h1>🎙️ BrightMinds Podcast</h1>
            <p>Enter any topic. Two AI hosts will have a real conversation about it.</p>
          </div>
          <form id="podcast-form" class="bm-form">
            <div class="bm-form-row">
              <label for="podcast-topic">Topic</label>
              <input id="podcast-topic" type="text" placeholder="e.g. Why is the sky blue?" maxlength="120" required />
            </div>
            <div class="bm-form-row">
              <label for="podcast-level">Knowledge Level</label>
              <select id="podcast-level">
                <option value="eli5">🧒 ELI5 (Kid-Friendly)</option>
                <option value="teen" selected>📚 Teen</option>
                <option value="adult">🎓 Adult</option>
                <option value="expert">🔬 Expert</option>
              </select>
            </div>
            <button class="primary-button" type="submit" id="podcast-gen-btn">🎙️ Generate Podcast</button>
          </form>
          <p id="podcast-status" class="bm-status" role="status"></p>
          <div class="bm-podcast-library">
            <h2>Episode Library</h2>
            <div id="podcast-library-list" class="bm-library-grid"></div>
          </div>
        </div>

        <div class="bm-panel bm-visualizer" id="bm-visualizer" hidden>
          <div class="bm-vis-header">
            <button class="icon-button" id="vis-close" aria-label="Close">✕</button>
            <span id="vis-title" class="bm-reader-title"></span>
          </div>
          <div class="bm-hosts">
            <div class="bm-host" id="host-alex">
              <div class="bm-host-avatar" id="avatar-alex">🧑‍💼</div>
              <div class="bm-host-name">Alex</div>
              <div class="bm-sound-bars" id="bars-alex">
                <span></span><span></span><span></span><span></span><span></span>
              </div>
            </div>
            <div class="bm-host" id="host-sam">
              <div class="bm-host-avatar" id="avatar-sam">👩‍🔬</div>
              <div class="bm-host-name">Sam</div>
              <div class="bm-sound-bars" id="bars-sam">
                <span></span><span></span><span></span><span></span><span></span>
              </div>
            </div>
          </div>
          <div class="bm-controls">
            <button class="secondary-button" id="vis-play" aria-label="Play">▶ Play</button>
          </div>
          <div class="bm-transcript" id="vis-transcript">
            <div id="transcript-lines"></div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('podcast-form').addEventListener('submit', (e) => { e.preventDefault(); this.generate(); });
    document.getElementById('vis-close').addEventListener('click', () => this.closeVisualizer());
    document.getElementById('vis-play').addEventListener('click', () => this.togglePlay());

    this.loadLibrary();
  },

  async generate() {
    const topic = document.getElementById('podcast-topic')?.value?.trim();
    const level = document.getElementById('podcast-level')?.value;
    const status = document.getElementById('podcast-status');
    const btn = document.getElementById('podcast-gen-btn');
    if (!topic) return;

    btn.disabled = true;
    btn.textContent = '⏳ Generating podcast…';
    status.textContent = 'Alex and Sam are preparing their deep dive. About 15–30 seconds…';

    try {
      const res = await bmFetch(`${BM_API}/api/studio/podcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, targetAudience: level, durationMinutes: 5 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const podcast = await res.json();
      status.textContent = '✅ Episode ready!';
      this.openVisualizer(podcast);
      this.loadLibrary();
    } catch (e) {
      status.textContent = `Couldn't generate podcast. (${e.message})`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🎙️ Generate Podcast';
    }
  },

  async loadLibrary() {
    const list = document.getElementById('podcast-library-list');
    if (!list) return;
    try {
      const res = await bmFetch(`${BM_API}/api/studio/list`);
      const data = await res.json();
      const pods = data.podcasts || [];
      if (!pods.length) { list.innerHTML = '<p class="bm-empty">No episodes yet — generate your first deep dive!</p>'; return; }
      list.innerHTML = '';
      pods.slice(0, 8).forEach((p) => {
        const card = document.createElement('button');
        card.className = 'bm-story-card';
        card.innerHTML = `
          <div class="bm-story-card-emoji">🎙️</div>
          <div class="bm-story-card-title">${p.topic || 'Deep Dive'}</div>
          <div class="bm-story-card-meta">${p.targetAudience || ''} · ${(p.createdAt || '').slice(0, 10)}</div>
        `;
        card.addEventListener('click', () => this.openVisualizer(p));
        list.appendChild(card);
      });
    } catch {
      list.innerHTML = '<p class="bm-empty">Couldn\'t load episodes.</p>';
    }
  },

  openVisualizer(podcast) {
    this.currentPodcast = podcast;
    const vis = document.getElementById('bm-visualizer');
    if (vis) vis.hidden = false;
    document.getElementById('vis-title').textContent = `Deep Dive: ${podcast.topic || 'Unknown'}`;

    const lines = document.getElementById('transcript-lines');
    const script = podcast.script || podcast.transcript || [];
    if (Array.isArray(script) && script.length) {
      lines.innerHTML = script.map((line, i) => `
        <div class="transcript-line" data-idx="${i}" data-host="${line.host || 'alex'}">
          <span class="tl-host">${line.host === 'sam' ? '👩‍🔬 Sam' : '🧑‍💼 Alex'}</span>
          <span class="tl-text">${line.text || ''}</span>
        </div>
      `).join('');
    } else {
      lines.innerHTML = '<p class="bm-empty">Transcript generating…</p>';
    }
  },

  closeVisualizer() {
    const vis = document.getElementById('bm-visualizer');
    if (vis) vis.hidden = true;
    this.stopPlay();
    this.currentPodcast = null;
  },

  togglePlay() {
    const btn = document.getElementById('vis-play');
    if (this.reading) {
      this.stopPlay();
      btn.textContent = '▶ Play';
    } else {
      this.simulateNarration();
      btn.textContent = '⏸ Pause';
    }
  },

  stopPlay() {
    this.stopSoundBars();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this.reading = false;
  },

  startSoundBars() {
    clearInterval(this.transcriptInterval);
    this.transcriptInterval = setInterval(() => {
      ['bars-alex', 'bars-sam'].forEach((id) => {
        const bars = document.getElementById(id);
        if (!bars) return;
        bars.querySelectorAll('span').forEach((s) => {
          s.style.height = `${8 + Math.random() * 28}px`;
        });
      });
    }, 120);
  },

  stopSoundBars() {
    clearInterval(this.transcriptInterval);
    ['bars-alex', 'bars-sam'].forEach((id) => {
      const bars = document.getElementById(id);
      if (!bars) return;
      bars.querySelectorAll('span').forEach((s) => { s.style.height = '4px'; });
    });
  },

  simulateNarration() {
    const lines = this.currentPodcast?.script || [];
    if (!lines.length || !window.speechSynthesis) return;
    let idx = 0;
    this.reading = true;
    const readNext = () => {
      if (!this.reading) return;
      if (idx >= lines.length) { this.stopPlay(); document.getElementById('vis-play').textContent = '▶ Replay'; return; }
      const line = lines[idx++];
      const el = document.querySelector(`.transcript-line[data-idx="${idx - 1}"]`);
      if (el) {
        document.querySelectorAll('.transcript-line.active').forEach(l => l.classList.remove('active'));
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      const utt = new SpeechSynthesisUtterance(line.text || '');
      utt.rate = 0.9;
      const hostId = line.host === 'sam' ? 'bars-sam' : 'bars-alex';
      this.activateBars(hostId);
      utt.onend = readNext;
      window.speechSynthesis.speak(utt);
    };
    this.startSoundBars();
    readNext();
  },

  activateBars(activeId) {
    ['bars-alex', 'bars-sam'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('bm-bars-active', id === activeId);
    });
  },
};

/* ── 3. LIVING FAMILY TREE EXPLORER ──────────────────────── */
const FamilyTree = {
  treeData: null,
  selectedMember: null,

  renderSection() {
    const sec = document.getElementById('brightminds-family');
    if (!sec) return;
    sec.innerHTML = `
      <div class="bm-family-layout">
        <div class="bm-panel bm-family-sidebar">
          <div class="page-heading">
            <p class="eyebrow">Heritage Vault</p>
            <h1>🌳 Family Tree</h1>
            <p>Your living family archive. Tap any member to see their story.</p>
          </div>
          <button class="primary-button" id="add-member-btn">+ Add Family Member</button>
          <div id="family-add-form" class="bm-form" hidden>
            <div class="bm-form-row">
              <label for="fm-name">Name</label>
              <input id="fm-name" type="text" placeholder="Full name" required />
            </div>
            <div class="bm-form-row">
              <label for="fm-relation">Relation</label>
              <input id="fm-relation" type="text" placeholder="e.g. Grandmother" />
            </div>
            <div class="bm-form-row">
              <label for="fm-birth">Birth Year</label>
              <input id="fm-birth" type="number" placeholder="e.g. 1945" min="1800" max="2025" />
            </div>
            <div class="bm-form-row">
              <label for="fm-bio">Their Story</label>
              <textarea id="fm-bio" rows="4" placeholder="Write a short bio or memory…" maxlength="1000"></textarea>
            </div>
            <button class="primary-button" type="button" id="fm-save-btn">💾 Save Member</button>
            <button class="secondary-button" type="button" id="fm-cancel-btn">Cancel</button>
            <p id="fm-status" class="bm-status" role="status"></p>
          </div>
          <div id="family-tree-visual" class="bm-tree-visual"></div>
        </div>

        <div class="bm-panel bm-member-detail" id="bm-member-detail">
          <div class="bm-member-placeholder">
            <div class="bm-placeholder-icon">👨‍👩‍👧‍👦</div>
            <p>Select a family member to see their story, milestones, and oral history.</p>
          </div>
        </div>
      </div>
    `;

    document.getElementById('add-member-btn').addEventListener('click', () => {
      const form = document.getElementById('family-add-form');
      form.hidden = !form.hidden;
    });
    document.getElementById('fm-save-btn').addEventListener('click', () => this.saveMember());
    document.getElementById('fm-cancel-btn').addEventListener('click', () => {
      document.getElementById('family-add-form').hidden = true;
    });

    this.loadTree();
  },

  async loadTree() {
    const visual = document.getElementById('family-tree-visual');
    if (!visual) return;
    visual.innerHTML = '<p class="bm-status">Loading your family tree…</p>';
    try {
      const res = await bmFetch(`${BM_API}/api/family/tree`);
      const data = await res.json();
      this.treeData = data;
      this.renderTree(data);
    } catch {
      visual.innerHTML = '<p class="bm-empty">Couldn\'t load family tree. Add your first member!</p>';
    }
  },

  renderTree(data) {
    const visual = document.getElementById('family-tree-visual');
    if (!visual) return;
    const members = data.members || [];
    if (!members.length) {
      visual.innerHTML = '<p class="bm-empty">No members yet. Add your first family member above!</p>';
      return;
    }

    const generations = {};
    members.forEach((m) => {
      const gen = this.estimateGeneration(m);
      if (!generations[gen]) generations[gen] = [];
      generations[gen].push(m);
    });

    visual.innerHTML = '';
    const genLabels = { 0: '🌟 You & Siblings', 1: '👨‍👩‍👧 Parents', 2: '👴👵 Grandparents', 3: '🏛️ Great-Grandparents', 4: '📜 Ancestors' };

    Object.keys(generations).sort().forEach((gen) => {
      const genDiv = document.createElement('div');
      genDiv.className = 'bm-generation';
      const label = document.createElement('h3');
      label.className = 'bm-gen-label';
      label.textContent = genLabels[gen] || `Generation ${gen}`;
      genDiv.appendChild(label);

      const row = document.createElement('div');
      row.className = 'bm-gen-row';
      generations[gen].forEach((member) => {
        const card = document.createElement('button');
        card.className = 'bm-member-card';
        card.dataset.memberId = member.id;
        card.innerHTML = `
          <div class="bm-member-avatar">${member.avatar || this.initials(member.name)}</div>
          <div class="bm-member-name">${member.name || 'Unknown'}</div>
          <div class="bm-member-years">${member.birthYear || ''}${member.deathYear ? `–${member.deathYear}` : ''}</div>
        `;
        card.addEventListener('click', () => this.showMember(member));
        row.appendChild(card);
      });
      genDiv.appendChild(row);
      visual.appendChild(genDiv);
    });
  },

  showMember(member) {
    this.selectedMember = member;
    const detail = document.getElementById('bm-member-detail');
    if (!detail) return;

    const milestones = (member.milestones || []).map(m => `<li>${m}</li>`).join('');
    const oralHistory = member.oralHistoryUrl
      ? `<div class="bm-oral-history">
           <h3>🎙 Oral History</h3>
           <audio controls src="${member.oralHistoryUrl}" class="bm-audio-player"></audio>
         </div>` : '';

    detail.innerHTML = `
      <div class="bm-member-profile">
        <div class="bm-profile-header">
          <div class="bm-profile-avatar-large">${member.avatar || this.initials(member.name)}</div>
          <div class="bm-profile-info">
            <h2>${member.name || 'Family Member'}</h2>
            <p class="eyebrow">${member.relation || ''} ${member.birthYear ? `· Born ${member.birthYear}` : ''}</p>
          </div>
        </div>
        ${member.bio ? `<div class="bm-bio"><h3>Their Story</h3><p>${member.bio}</p></div>` : ''}
        ${milestones ? `<div class="bm-milestones"><h3>🏆 Milestones</h3><ul>${milestones}</ul></div>` : ''}
        ${oralHistory}
        <div class="bm-transmute-wrap">
          <h3>🧠 Explain Their Era</h3>
          <select id="transmute-level" class="quality-select">
            <option value="eli5">🧒 For a 5-year-old</option>
            <option value="teen" selected>📚 For a teen</option>
            <option value="adult">🎓 For an adult</option>
            <option value="expert">🔬 Expert level</option>
          </select>
          <button class="secondary-button" id="transmute-btn">Explain their time period ➜</button>
          <p id="transmute-result" class="bm-transmute-result"></p>
        </div>
      </div>
    `;

    document.getElementById('transmute-btn')?.addEventListener('click', () => this.transmuteMemberEra(member));
  },

  async transmuteMemberEra(member) {
    const level = document.getElementById('transmute-level')?.value || 'teen';
    const result = document.getElementById('transmute-result');
    if (!result || !member.birthYear) return;
    result.textContent = 'Loading explanation…';
    try {
      const era = `Life in the ${Math.floor(member.birthYear / 10) * 10}s during ${member.name}'s time`;
      const res = await bmFetch(`${BM_API}/api/studio/transmute?concept=${encodeURIComponent(era)}&level=${level}`);
      const data = await res.json();
      result.textContent = data.explanation || data.result || 'Explanation ready!';
    } catch {
      result.textContent = 'Could not load explanation right now.';
    }
  },

  async saveMember() {
    const name = document.getElementById('fm-name')?.value?.trim();
    const relation = document.getElementById('fm-relation')?.value?.trim();
    const birthYear = parseInt(document.getElementById('fm-birth')?.value || '0') || undefined;
    const bio = document.getElementById('fm-bio')?.value?.trim();
    const status = document.getElementById('fm-status');
    if (!name) { status.textContent = 'Please enter a name.'; return; }
    const btn = document.getElementById('fm-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await bmFetch(`${BM_API}/api/family/member`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, relation, birthYear, bio }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status.textContent = `✅ ${name} added to your family tree!`;
      document.getElementById('family-add-form').hidden = true;
      ['fm-name','fm-relation','fm-birth','fm-bio'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      this.loadTree();
    } catch (e) {
      status.textContent = `Couldn't save. (${e.message})`;
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Save Member';
    }
  },

  estimateGeneration(member) {
    const r = (member.relation || '').toLowerCase();
    if (/great.grand/i.test(r)) return 3;
    if (/grand/i.test(r)) return 2;
    if (/parent|mother|father|mom|dad/i.test(r)) return 1;
    if (member.birthYear) {
      const age = new Date().getFullYear() - member.birthYear;
      if (age > 70) return 3;
      if (age > 45) return 2;
      if (age > 20) return 1;
    }
    return 0;
  },

  initials(name) {
    return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }
};

/* ── Public Mount Functions ─────────────────────────────── */
window.mountStorybook = function() {
  const sec = document.getElementById('brightminds-stories');
  if (sec) Storybook.renderSection();
}

window.mountPodcastStudio = function() {
  const sec = document.getElementById('brightminds-podcasts');
  if (sec) PodcastStudio.renderSection();
}

window.mountFamilyTree = function() {
  const sec = document.getElementById('brightminds-family');
  if (sec) FamilyTree.renderSection();
}
