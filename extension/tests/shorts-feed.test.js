"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { dom } = require("./dom-harness");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ALLOWED = 'data-focusfeed-shorts-allowed';
function setup(t, options = {}) {
  const h = dom('<ytd-shorts><ytd-reel-video-renderer is-active video-id="first123456"><h2>First Short</h2><div id="shorts-player"><video></video></div></ytd-reel-video-renderer><div id="navigation-button-down"><button>Next</button></div></ytd-shorts>', '/shorts/first123456');
  h.load('video-model.js', 'shorts-queue.js', 'shorts-feed.js');
  const card = h.document.querySelector('ytd-reel-video-renderer'), media = h.media(card.querySelector('video'));
  const owned = new WeakSet(), clicks = [], retries = [];
  let state = { enabled: true, hideShorts: false, revision: 1 };
  function current() { return { card, context: card, video: { videoId: card.getAttribute('video-id'), title: card.querySelector('h2').textContent, isShort: true } }; }
  const controller = h.context.FocusFeedShortsFeed.create({ current,
    pause(node) { node.querySelectorAll('video').forEach(v => { if (!v.paused) { owned.add(v); v.pause(); } }); },
    resume(node) { node.querySelectorAll('video').forEach(v => { if (owned.has(v)) { owned.delete(v); v.play(); } }); },
    retry: id => retries.push(id), requestScan() {}, lookup: options.lookup, extract: node => ({ videoId: node.querySelector('a').getAttribute('href').split('/').pop(), title: node.textContent, isShort: true }) });
  const button = h.document.querySelector('button'); button.addEventListener('click', () => { clicks.push(current().video.videoId); if (options.next) options.next(h, card); });
  function render(action, reason = 'model') { controller.render(card, current().video, action, reason); }
  function change(values) { state = { ...state, ...values, revision: state.revision + 1 }; controller.configure(state); }
  controller.configure(state); t.after(() => { controller.stop(); h.cleanup(); });
  return { ...h, controller, card, media, clicks, retries, render, change, current };
}
test('pending Shorts remain concealed; rejected Shorts advance once without a filtered-card overlay', async t => {
  const h = setup(t); h.render('pending');
  assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.media.paused, true);
  assert.equal(h.document.querySelector('ytd-shorts').hasAttribute(ALLOWED), false);
  h.render('hide'); h.render('hide'); await sleep(20);
  assert.deepEqual(h.clicks, ['first123456']);
  assert.equal(h.document.querySelector('.focusfeed-playback'), null);
  assert.doesNotMatch(h.document.querySelector('.focusfeed-shorts-status').textContent, /First Short|filtered/i);
  h.render('hide'); await sleep(20); assert.equal(h.clicks.length, 1);
});
test('only an allowed Short is revealed and resumed', t => {
  const h = setup(t); h.render('show');
  assert.equal(h.card.hasAttribute(ALLOWED), true); assert.equal(h.document.querySelector('#shorts-player').hasAttribute(ALLOWED), true);
  assert.equal(h.document.querySelector('ytd-shorts').hasAttribute(ALLOWED), true);
  assert.equal(h.media.paused, false); assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
});
test('a reused renderer loses approval in the mutation microtask before the delayed content scan', async t => {
  const h = setup(t); h.render('show');
  h.card.setAttribute('video-id', 'second12345'); h.card.querySelector('h2').textContent = 'Second Short';
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.media.paused, true);
  h.render('hide'); await sleep(20); assert.deepEqual(h.clicks, ['second12345']);
});
test('late scheduled skips cannot advance a different Short', async t => {
  const h = setup(t); h.render('hide');
  h.card.setAttribute('video-id', 'second12345'); h.location.pathname = '/shorts/second12345';
  h.render('show'); await sleep(20); assert.equal(h.clicks.length, 0); assert.equal(h.media.paused, false);
});
test('several rejected Shorts each advance once, and the allowed successor stops skipping', async t => {
  const h = setup(t, { next(_h, card) { const id = card.getAttribute('video-id'); card.setAttribute('video-id', id === 'first123456' ? 'second12345' : 'allowed1234'); } });
  h.render('hide'); await sleep(20); h.render('hide'); await sleep(20); h.render('show'); await sleep(20);
  assert.deepEqual(h.clicks, ['first123456', 'second12345']); assert.equal(h.media.paused, false); assert.equal(h.card.hasAttribute(ALLOWED), true);
});
test('errors stay concealed with retry and do not trigger automatic skips', async t => {
  const h = setup(t); h.render('pending', 'check_failed'); await sleep(20);
  assert.equal(h.media.paused, true); assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.clicks.length, 0);
  h.document.querySelector('.focusfeed-shorts-status button').click(); assert.deepEqual(h.retries, ['first123456']);
});
test('navigation, pausing filtering and Hide Shorts cancel queued skips', async t => {
  for (const kind of ['navigate', 'pause', 'hide']) {
    const h = setup(t); h.render('hide');
    if (kind === 'navigate') h.controller.suspend();
    else h.change(kind === 'pause' ? { enabled: false } : { hideShorts: true });
    await sleep(20); assert.equal(h.clicks.length, 0, kind);
  }
});
test('missing or disabled Next controls do not create a click loop', async t => {
  const h = setup(t); h.document.querySelector('button').setAttribute('disabled', ''); h.render('hide');
  await sleep(600); h.render('hide'); await sleep(20);
  assert.equal(h.clicks.length, 0); assert.equal(h.card.hasAttribute(ALLOWED), false);
});
test('an already loaded successor can be scrolled into view without smooth animation', async t => {
  const h = setup(t); h.document.querySelector('#navigation-button-down').remove();
  const next = h.document.createElement('ytd-reel-video-renderer'); let call;
  next.scrollIntoView = options => { call = options; }; h.card.parentNode.appendChild(next);
  h.render('hide'); await sleep(20); assert.equal(call.behavior, 'instant'); assert.equal(call.block, 'start');
});
test('CSS conceals startup and unapproved Shorts rather than relying on a delayed overlay', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'youtube.css'), 'utf8');
  const h = dom('<ytd-shorts><ytd-reel-video-renderer><h2>Private title</h2></ytd-reel-video-renderer></ytd-shorts>');
  h.document.documentElement.setAttribute('data-focusfeed-shorts-filtering', '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(match => /visibility:\s*hidden\s*!important/.test(match[2]));
  assert.ok(rules.some(match => h.document.querySelector('h2').matches(match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim())));
  h.document.documentElement.removeAttribute('data-focusfeed-shorts-filtering'); h.document.documentElement.setAttribute('data-focusfeed-initializing', '');
  assert.ok(rules.some(match => h.document.querySelector('h2').matches(match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()))); h.cleanup();
});
test('a Next control enabled after initial discovery retries still advances the concealed Short', async t => {
  const h = setup(t), button = h.document.querySelector('button'); button.setAttribute('disabled', '');
  h.render('hide'); await sleep(600); assert.equal(h.clicks.length, 0);
  button.removeAttribute('disabled'); await sleep(300);
  assert.equal(h.clicks.length, 1); assert.equal(h.card.hasAttribute(ALLOWED), false);
});
test('the captured Next video button works without a navigation container ID', async t => {
  const h = setup(t), container = h.document.querySelector('#navigation-button-down'), button = container.querySelector('button');
  container.removeAttribute('id');
  button.className = 'ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextSizeXl ytSpecButtonShapeNextIconButton';
  button.setAttribute('title', ''); button.setAttribute('aria-label', 'Next video');
  const unrelated = h.document.createElement('button'); unrelated.setAttribute('aria-label', 'Next video'); let unrelatedClicks = 0;
  unrelated.addEventListener('click', () => unrelatedClicks++);
  h.document.body.insertBefore(unrelated, h.document.querySelector('ytd-shorts'));
  h.render('hide'); await sleep(20);
  assert.deepEqual(h.clicks, ['first123456']); assert.equal(unrelatedClicks, 0);
  assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.media.paused, true);
  h.render('hide'); await sleep(20); assert.equal(h.clicks.length, 1);
});
test('the accessible-label fallback ignores a disabled Next video button', async t => {
  const h = setup(t), container = h.document.querySelector('#navigation-button-down'), button = container.querySelector('button');
  container.removeAttribute('id'); button.setAttribute('aria-label', 'Next video'); button.setAttribute('aria-disabled', 'true');
  h.render('hide'); await sleep(20);
  assert.equal(h.clicks.length, 0); assert.equal(h.card.hasAttribute(ALLOWED), false);
});
test('changing the media source of a prepared allowed Short does not blank it again', async t => {
  const h = setup(t); h.controller.remember(h.current().video, 'show', 'model'); h.render('show');
  h.media.setAttribute('src', 'blob:hydrated-source'); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.card.hasAttribute(ALLOWED), true); assert.equal(h.media.paused, false);
  assert.equal(h.document.querySelector('.focusfeed-shorts-status'), null);
});
test('internal navigation preserves approved content while suppressing queued skip actions', async t => {
  const h = setup(t); h.render('show'); h.controller.transition(true);
  assert.equal(h.card.hasAttribute(ALLOWED), true);
  h.render('hide'); await sleep(20); assert.equal(h.clicks.length, 0);
  h.controller.transition(false); await sleep(20); assert.equal(h.clicks.length, 1);
});
test('a run of loaded prepared rejections jumps directly to the next prepared allowed renderer', async t => {
  const videos = { middle12345: { videoId: 'middle12345', title: 'Rejected successor', isShort: true },
    allowed1234: { videoId: 'allowed1234', title: 'Allowed successor', isShort: true } };
  const h = setup(t, { lookup: id => videos[id] }); let target;
  for (const id of Object.keys(videos)) {
    const renderer = h.document.createElement('ytd-reel-video-renderer'); renderer.setAttribute('video-id', id);
    renderer.scrollIntoView = options => { target = { id, behavior: options.behavior }; }; h.card.parentElement.appendChild(renderer);
    h.controller.remember(videos[id], id === 'allowed1234' ? 'show' : 'hide', 'model');
  }
  h.render('hide'); await sleep(20);
  assert.deepEqual(target, { id: 'allowed1234', behavior: 'instant' });
  assert.equal(h.clicks.length, 0); assert.equal(h.card.hasAttribute(ALLOWED), false);
});
test('a Short removed earlier in the visit cannot be restored by a new filter decision', async t => {
  const h = setup(t); h.controller.remember(h.current().video, 'hide', 'model'); h.render('hide'); await sleep(20);
  h.controller.configure({ enabled: true, hideShorts: false, revision: 2 }, { scope: 'updated-topics' });
  h.controller.remember(h.current().video, 'show', 'model'); h.render('show');
  assert.equal(h.card.hasAttribute(ALLOWED), false, 'removed visit history wins over a new allowed decision');
  assert.equal(h.media.paused, true);
});
test('a policy change with the same settings revision revokes the old reveal permission', t => {
  const h = setup(t); h.render('show');
  h.controller.configure({ enabled: true, hideShorts: false, revision: 1 }, { scope: 'new-local-policy' });
  assert.equal(h.card.hasAttribute(ALLOWED), false);
});
test('backtracking into a removed Short uses Previous and never forces Next', async t => {
  const h = setup(t); h.controller.remember(h.current().video, 'hide', 'model'); h.render('hide'); await sleep(20);
  h.card.setAttribute('video-id', 'later123456'); h.card.querySelector('h2').textContent = 'Allowed later Short';
  h.render('show'); let previousClicks = 0;
  const previous = h.document.createElement('button'); previous.setAttribute('aria-label', 'Previous video');
  previous.addEventListener('click', () => previousClicks++); h.card.parentElement.appendChild(previous);
  const up = new h.window.Event('wheel', { bubbles: true }); Object.defineProperty(up, 'deltaY', { value: -100 }); h.card.dispatchEvent(up);
  h.controller.beginUpdate();
  h.controller.configure({ enabled: true, hideShorts: false, revision: 2 }, { scope: 'updated topics during backward navigation' });
  h.render('show');
  h.card.setAttribute('video-id', 'first123456'); h.card.querySelector('h2').textContent = 'First Short';
  h.render('show'); await sleep(20);
  assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(previousClicks, 1);
  assert.equal(h.clicks.length, 1, 'no additional Next click when revisiting removed history');
});
test('inactive removed slots collapse, while a recycled slot follows its new video identity', async t => {
  const h = setup(t); const previous = h.document.createElement('ytd-reel-video-renderer'); previous.setAttribute('video-id', 'old12345678');
  h.card.parentElement.insertBefore(previous, h.card); h.controller.remember({ videoId: 'old12345678', title: 'Old Short', isShort: true }, 'hide', 'model');
  h.render('show'); await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.hasAttribute('data-focusfeed-shorts-removed'), true);
  assert.equal(previous.hasAttribute('data-focusfeed-shorts-current'), false);
  assert.equal(h.card.hasAttribute('data-focusfeed-shorts-removed'), false);
  previous.setAttribute('video-id', 'new12345678'); await Promise.resolve(); await Promise.resolve();
  assert.equal(previous.hasAttribute('data-focusfeed-shorts-removed'), false);
  assert.equal(h.media.paused, false);
});
test('the synchronous update barrier revokes reveal permission and rejects old show callbacks', t => {
  const h = setup(t); h.render('show'); h.controller.beginUpdate();
  assert.equal(h.card.hasAttribute(ALLOWED), false); h.controller.remember(h.current().video, 'show', 'model'); h.render('show');
  assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.media.paused, true);
});
test('a cached rejection consumed on entering Shorts becomes removed visit history immediately', async t => {
  const h = setup(t); h.location.pathname = '/'; h.controller.configure({ enabled: true, hideShorts: false, revision: 1 });
  h.controller.remember(h.current().video, 'hide', 'model'); h.location.pathname = '/shorts/first123456';
  h.controller.prepare(); await sleep(20);
  h.controller.configure({ enabled: true, hideShorts: false, revision: 2 }, { scope: 'different topics' });
  h.render('show'); assert.equal(h.card.hasAttribute(ALLOWED), false); assert.equal(h.media.paused, true);
});
