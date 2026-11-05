'use strict';

const topicButtons = [...document.querySelectorAll('[data-topic]')];
const videoCards = [...document.querySelectorAll('[data-category]')];
const feedButtons = [...document.querySelectorAll('[data-feed-state]')];
const state = { feed: 'after', mode: 'general', topics: new Set(['movie-reviews', 'celebrity-gossip']) };
const timer = { duration: 25 * 60, remaining: 25 * 60, running: false, active: false, endAt: 0, interval: null };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const feedGrid = document.querySelector('#video-grid');

function renderFeed(animate = true) {
  const canAnimate = animate && !reducedMotion.matches && typeof feedGrid.animate === 'function';
  const previous = new Map();
  let previousHeight = 0;
  if (canAnimate) {
    for (const card of videoCards) {
      card.getAnimations().forEach((animation) => animation.cancel());
      if (!card.hidden) previous.set(card, card.getBoundingClientRect());
    }
    feedGrid.getAnimations().forEach((animation) => animation.cancel());
    previousHeight = feedGrid.getBoundingClientRect().height;
  }
  const filtered = state.feed === 'after';
  const focusing = state.mode === 'focus';
  let hidden = 0;
  for (const card of videoCards) {
    card.hidden = filtered && (focusing ? card.dataset.category !== 'guitar' : state.topics.has(card.dataset.category));
    if (card.hidden) hidden++;
  }
  for (const button of feedButtons) button.setAttribute('aria-pressed', String(button.dataset.feedState === state.feed));
  for (const button of topicButtons) {
    const selected = state.topics.has(button.dataset.topic);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('span').textContent = selected ? '×' : '+';
  }
  document.querySelector('.topic-controls').hidden = focusing;
  document.querySelector('.focus-topic').hidden = !focusing;
  document.querySelector('#filter-label').textContent = focusing ? 'Here to learn' : 'Topics to hide';
  document.querySelector('#filter-status').textContent = !filtered ? 'Your feed, before filtering' : focusing ? '1 video for your focus' : `${hidden} distraction${hidden === 1 ? '' : 's'} cleared`;
  if (canAnimate) {
    const nextHeight = feedGrid.getBoundingClientRect().height;
    if (Math.abs(previousHeight - nextHeight) > 1) {
      feedGrid.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
    for (const card of videoCards) {
      if (card.hidden) continue;
      const before = previous.get(card);
      const after = card.getBoundingClientRect();
      const x = before ? before.left - after.left : 0;
      const y = before ? before.top - after.top : 8;
      if (!before || Math.abs(x) > 1 || Math.abs(y) > 1) {
        card.animate([{ transform: `translate(${x}px, ${y}px)`, opacity: before ? 1 : 0 }, { transform: 'translate(0, 0)', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
    }
  }
}

for (const button of feedButtons) button.addEventListener('click', () => { state.feed = button.dataset.feedState; renderFeed(); });
for (const button of topicButtons) button.addEventListener('click', () => {
  const topic = button.dataset.topic;
  if (state.topics.has(topic)) state.topics.delete(topic); else state.topics.add(topic);
  renderFeed();
});

function renderTimer() {
  const seconds = Math.max(0, timer.remaining);
  const minutes = Math.floor(seconds / 60);
  document.querySelector('#timer').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  document.querySelector('#focus-button-label').textContent = timer.running ? 'Pause focus' : timer.active ? 'Resume focus' : 'Start focus';
  document.querySelector('#focus-end').hidden = !timer.active;
}

function endFocus(message = 'Session ended. The example feed is back in General mode.') {
  clearInterval(timer.interval);
  timer.interval = null;
  timer.running = false;
  timer.active = false;
  timer.remaining = timer.duration;
  state.mode = 'general';
  renderTimer();
  renderFeed();
  document.querySelector('#focus-note').textContent = message;
}

function tick() {
  timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  if (timer.remaining === 0) {
    endFocus('Your 25-minute session is complete. Take a little breathing room.');
    return;
  }
  renderTimer();
}

document.querySelector('#focus-toggle').addEventListener('click', () => {
  if (timer.running) {
    timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    clearInterval(timer.interval);
    timer.interval = null;
    timer.running = false;
    state.mode = 'general';
    document.querySelector('#focus-note').textContent = 'Focus paused. The example feed is back in General mode.';
  } else {
    timer.active = true;
    timer.running = true;
    timer.endAt = Date.now() + timer.remaining * 1000;
    timer.interval = setInterval(tick, 250);
    state.mode = 'focus';
    state.feed = 'after';
    document.querySelector('#focus-note').textContent = 'Focus is on. The example feed now keeps guitar videos.';
  }
  renderTimer();
  renderFeed();
});
document.querySelector('#focus-end').addEventListener('click', () => endFocus());
document.querySelector('#general-preview').addEventListener('click', () => {
  endFocus('General mode is on in the example feed.');
  state.feed = 'after';
  state.topics = new Set(['movie-reviews', 'celebrity-gossip']);
  renderFeed();
  document.querySelector('#your-feed').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer.running) tick(); });

const layoutSwitches = [...document.querySelectorAll('[data-hide]')];
function renderLayout() {
  const preview = document.querySelector('.layout-preview');
  const canAnimate = !reducedMotion.matches && typeof preview.animate === 'function';
  if (canAnimate) preview.getAnimations().forEach((animation) => animation.cancel());
  const previousHeight = canAnimate ? preview.getBoundingClientRect().height : 0;
  let hidden = 0;
  for (const input of layoutSwitches) {
    document.querySelector(`[data-layout-region="${input.dataset.hide}"]`).hidden = input.checked;
    if (input.checked) hidden++;
  }
  document.querySelector('#layout-status').textContent = hidden === 3
    ? 'All three distractions tucked away. Turn a hide switch off to compare.'
    : hidden === 0 ? 'All three sections are visible. Turn a hide switch on to clear some space.'
      : `${hidden} section${hidden === 1 ? '' : 's'} hidden in this preview.`;
  if (canAnimate) {
    const nextHeight = preview.getBoundingClientRect().height;
    if (Math.abs(previousHeight - nextHeight) > 1) preview.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], { duration: 280, easing: 'ease-out' });
    for (const region of preview.querySelectorAll('[data-layout-region]:not([hidden])')) {
      region.getAnimations().forEach((animation) => animation.cancel());
      region.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'ease-out' });
    }
  }
}
for (const input of layoutSwitches) input.addEventListener('change', renderLayout);

for (const details of document.querySelectorAll('.faq-list details')) {
  const summary = details.querySelector('summary');
  const answer = details.querySelector('.faq-answer');
  let expanded = details.open;
  let animation = null;
  summary.addEventListener('click', (event) => {
    event.preventDefault();
    const startHeight = details.open ? answer.getBoundingClientRect().height : 0;
    if (animation) animation.cancel();
    expanded = !expanded;
    if (reducedMotion.matches || typeof answer.animate !== 'function') {
      answer.style.removeProperty('overflow');
      animation = null;
      details.open = expanded;
      return;
    }
    details.open = true;
    const endHeight = expanded ? answer.scrollHeight : 0;
    answer.style.overflow = 'hidden';
    animation = answer.animate([{ height: `${startHeight}px`, opacity: startHeight ? 1 : 0 }, { height: `${endHeight}px`, opacity: expanded ? 1 : 0 }], { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    animation.onfinish = () => {
      details.open = expanded;
      answer.style.removeProperty('overflow');
      animation = null;
    };
  });
}

const dialog = document.querySelector('#install-dialog');
let dialogTrigger = null;
let dialogClosing = false;
function closeDialog() {
  if (dialogClosing || !dialog.open) return;
  if (reducedMotion.matches || typeof dialog.animate !== 'function') {
    dialog.close();
    return;
  }
  dialogClosing = true;
  dialog.classList.add('is-closing');
  const animation = dialog.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 180, easing: 'ease-in' });
  animation.onfinish = () => dialog.close();
}
for (const button of document.querySelectorAll('[data-install]')) button.addEventListener('click', () => {
  dialogTrigger = button.closest('.mobile-menu') ? document.querySelector('.mobile-menu summary') : button;
  document.querySelector('.mobile-menu').open = false;
  dialog.showModal();
  document.body.classList.add('dialog-open');
});
dialog.addEventListener('close', () => {
  dialogClosing = false;
  dialog.classList.remove('is-closing');
  document.body.classList.remove('dialog-open');
  if (dialogTrigger?.offsetParent !== null) dialogTrigger?.focus();
  else document.querySelector('.mobile-menu summary').focus();
});
dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
dialog.querySelector('.dialog-close').addEventListener('click', (event) => { event.preventDefault(); closeDialog(); });
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
});
for (const link of document.querySelectorAll('.mobile-menu a')) link.addEventListener('click', () => { document.querySelector('.mobile-menu').open = false; });

renderFeed(false);
renderLayout();
renderTimer();
