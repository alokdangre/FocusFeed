"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
require('../video-model.js'); require('../shorts-queue.js');
function video(id) { return { videoId: id, title: 'Short ' + id, isShort: true }; }
test('removed visit IDs survive new policies, repeated offers and prepared-cache eviction', () => {
  const queue = FocusFeedShortsQueue.create(); queue.beginVisit(); queue.commitPolicy('first topics');
  queue.offer('removed'); queue.remember(video('removed'), 'hide', 'model');
  for (let i = 0; i < 400; i++) { queue.offer('next-' + i); queue.remember(video('next-' + i), 'show', 'model'); }
  queue.commitPolicy('updated topics'); queue.offer('removed'); queue.remember(video('removed'), 'show', 'model');
  assert.equal(queue.isRemoved('removed'), true); assert.equal(queue.ids().includes('removed'), false);
  assert.equal(queue.decision(video('removed')).action, 'hide');
});
test('an update barrier ignores old results and invalidates current-policy scores', () => {
  const queue = FocusFeedShortsQueue.create(); queue.beginVisit(); queue.commitPolicy('first');
  queue.remember(video('ready'), 'show', 'model'); queue.beginUpdate();
  queue.remember(video('late'), 'hide', 'model');
  assert.equal(queue.decision(video('ready')), null); assert.equal(queue.isRemoved('late'), false);
  queue.commitPolicy('second'); assert.equal(queue.decision(video('ready')), null);
  queue.remember(video('late'), 'show', 'model'); assert.equal(queue.decision(video('late')).action, 'show');
});
test('an explicitly new Shorts visit can reconsider previously removed IDs', () => {
  const queue = FocusFeedShortsQueue.create(); queue.beginVisit(); queue.commitPolicy('same');
  queue.offer('removed'); queue.remember(video('removed'), 'hide', 'model'); queue.endVisit();
  queue.beginVisit(); queue.commitPolicy('same'); assert.equal(queue.offer('removed'), true);
  queue.remember(video('removed'), 'show', 'model'); assert.equal(queue.decision(video('removed')).action, 'show');
});
test('failures and Hide Shorts are not permanent removals from a visit', () => {
  const queue = FocusFeedShortsQueue.create(); queue.beginVisit(); queue.commitPolicy('topics');
  queue.offer('pending'); queue.remember(video('pending'), 'pending', 'check_failed');
  queue.offer('global-hide'); queue.remember(video('global-hide'), 'hide', 'shorts_block');
  assert.equal(queue.stats().removed, 0); assert.equal(queue.ids().length, 2);
});
