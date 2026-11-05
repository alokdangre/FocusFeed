/**
 * FocusFeed Landing Page Interactive Script
 */

document.addEventListener('DOMContentLoaded', () => {
  initNavbarScroll();
  initSimulator();
});

function initNavbarScroll() {
  const header = document.getElementById('mainHeader');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 40) {
      header.classList.add('py-3');
      header.classList.remove('py-4');
      header.style.background = 'rgba(6, 7, 9, 0.88)';
      header.style.borderBottomColor = 'rgba(255, 255, 255, 0.1)';
    } else {
      header.classList.add('py-4');
      header.classList.remove('py-3');
      header.style.background = 'rgba(6, 7, 9, 0.65)';
      header.style.borderBottomColor = 'rgba(255, 255, 255, 0.05)';
    }
  });
}

/**
 * Feed Simulator Data & Logic
 */
const mockFeed = [
  {
    id: 1,
    title: "Why You Can't Stop Watching: The Dark Psychology of Dopamine Loops",
    channel: "Veritasium Minds",
    duration: "24:18",
    views: "1.8M views",
    topics: ["Psychology", "Deep Work", "Neuroscience"],
    type: "signal",
    gradient: "from-indigo-900 to-slate-900"
  },
  {
    id: 2,
    title: "10 CELEBRITY DRAMAS THAT WENT TOO FAR!! (SHOCKING EVIDENCE)",
    channel: "TeaTime Reacts",
    duration: "11:02",
    views: "4.2M views",
    topics: ["Celebrity Gossip", "Drama", "Reaction"],
    type: "noise",
    gradient: "from-red-900 to-amber-900"
  },
  {
    id: 3,
    title: "Building a Fault-Tolerant Distributed Consensus Engine in Rust",
    channel: "Jon Gjengset Deep Dives",
    duration: "1:42:05",
    views: "210K views",
    topics: ["Rust Architecture", "Distributed Systems", "Software Engineering"],
    type: "focus",
    gradient: "from-amber-950 to-stone-900"
  },
  {
    id: 4,
    title: "I SPENT 100 HOURS IN A GIANT BURGER PIT TO WIN $50,000",
    channel: "HypeBeast Vlogs",
    duration: "14:50",
    views: "8.9M views",
    topics: ["Sensational", "Entertainment", "Stunts"],
    type: "noise",
    gradient: "from-fuchsia-950 to-pink-900"
  },
  {
    id: 5,
    title: "Denis Villeneuve Analyzes the Visual Geometry of Dune Part Two",
    channel: "Vanity Cinema",
    duration: "18:40",
    views: "940K views",
    topics: ["Cinematography 35mm", "Film Analysis", "Art Direction"],
    type: "signal",
    gradient: "from-slate-900 to-amber-950"
  },
  {
    id: 6,
    title: "High-Performance Concurrency Patterns with Async Rust Channels",
    channel: "Systems Architect Pro",
    duration: "38:12",
    views: "85K views",
    topics: ["Rust Architecture", "Async Concurrency", "Performance"],
    type: "focus",
    gradient: "from-amber-900/60 to-black"
  }
];

let currentMode = 'focus'; // 'chaos' | 'general' | 'focus'

function initSimulator() {
  const chaosBtn = document.getElementById('simChaosBtn');
  const generalBtn = document.getElementById('simGeneralBtn');
  const focusBtn = document.getElementById('simFocusBtn');

  if (!chaosBtn || !generalBtn || !focusBtn) return;

  chaosBtn.addEventListener('click', () => setSimulatorMode('chaos'));
  generalBtn.addEventListener('click', () => setSimulatorMode('general'));
  focusBtn.addEventListener('click', () => setSimulatorMode('focus'));

  renderFeed();
}

function setSimulatorMode(mode) {
  currentMode = mode;
  
  const chaosBtn = document.getElementById('simChaosBtn');
  const generalBtn = document.getElementById('simGeneralBtn');
  const focusBtn = document.getElementById('simFocusBtn');
  const badge = document.getElementById('simFocusFeedBadge');
  const badgeLabel = document.getElementById('simBadgeLabel');
  const blockedCount = document.getElementById('simBlockedCount');

  // Reset button states
  [chaosBtn, generalBtn, focusBtn].forEach(btn => {
    btn.className = "px-6 py-2.5 rounded-full text-xs font-semibold text-slate-400 hover:text-white transition-all";
  });

  if (mode === 'chaos') {
    chaosBtn.className = "px-6 py-2.5 rounded-full text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.3)] transition-all";
    badge.className = "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20";
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-400"></span><span>FocusFeed · Off</span>`;
    blockedCount.innerText = "0";
  } else if (mode === 'general') {
    generalBtn.className = "px-6 py-2.5 rounded-full text-xs font-semibold bg-slate-200 text-black shadow-[0_0_15px_rgba(255,255,255,0.3)] transition-all";
    badge.className = "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-200 border border-slate-700";
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-300"></span><span>FocusFeed · General (Filtering Active)</span>`;
    blockedCount.innerText = "8";
  } else if (mode === 'focus') {
    focusBtn.className = "px-6 py-2.5 rounded-full text-xs font-semibold bg-amber-500 text-black shadow-[0_0_15px_rgba(245,158,11,0.4)] transition-all";
    badge.className = "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30";
    badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span><span>FocusFeed · Focus 45m</span>`;
    blockedCount.innerText = "14";
  }

  renderFeed();
}

function renderFeed() {
  const grid = document.getElementById('feedGrid');
  if (!grid) return;

  grid.innerHTML = '';

  mockFeed.forEach(item => {
    const card = document.createElement('div');
    card.className = "sim-video-card flex flex-col";

    let isBlocked = false;
    let blockReason = "";

    if (currentMode === 'general') {
      if (item.type === 'noise') {
        isBlocked = true;
        blockReason = `Filtered by General Rule: "${item.topics[0]}"`;
      }
    } else if (currentMode === 'focus') {
      if (item.type !== 'focus') {
        isBlocked = true;
        blockReason = item.type === 'noise' 
          ? `Noise removed during Focus Sprint` 
          : `Non-focus topic withheld for 45m`;
      }
    }

    if (isBlocked) {
      card.innerHTML = `
        <div class="sim-video-thumb bg-gradient-to-br ${item.gradient} opacity-20">
          <div class="text-xs font-mono text-slate-500">Thumbnail hidden</div>
        </div>
        <div class="p-4 flex-1 flex flex-col justify-center items-center text-center bg-black/60 border-t border-white/5">
          <div class="w-6 h-6 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center text-xs mb-2">✕</div>
          <p class="text-xs font-mono text-amber-300/80 mb-1">${blockReason}</p>
          <span class="text-[10px] text-slate-500 font-mono">Restores when session ends</span>
        </div>
      `;
      card.style.opacity = "0.5";
    } else {
      card.style.opacity = "1";
      const isHighPriority = item.type === 'focus' && currentMode === 'focus';

      card.innerHTML = `
        <div class="sim-video-thumb bg-gradient-to-br ${item.gradient}">
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="w-10 h-10 rounded-full bg-black/50 border border-white/20 flex items-center justify-center">
              <svg class="w-4 h-4 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <span class="absolute bottom-2 right-2 text-[10px] font-mono bg-black/80 px-1.5 py-0.5 rounded text-white border border-white/10">${item.duration}</span>
          ${isHighPriority ? '<span class="absolute top-2 left-2 text-[10px] font-mono bg-amber-500 text-black px-2 py-0.5 rounded-full font-bold">100% MATCH</span>' : ''}
        </div>
        <div class="p-4 flex-1 flex flex-col justify-between">
          <div>
            <h4 class="text-sm font-semibold text-white line-clamp-2 leading-snug mb-2">${item.title}</h4>
            <p class="text-xs text-slate-400 font-light mb-1">${item.channel}</p>
            <p class="text-[11px] text-slate-500 font-mono">${item.views}</p>
          </div>
          <div class="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-1">
            ${item.topics.map(t => `<span class="text-[10px] font-mono text-slate-400 bg-white/5 px-1.5 py-0.5 rounded">${t}</span>`).join('')}
          </div>
        </div>
      `;
    }

    grid.appendChild(card);
  });
}

