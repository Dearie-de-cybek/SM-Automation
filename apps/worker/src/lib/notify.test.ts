import assert from 'node:assert/strict';
import test from 'node:test';

import { TELEGRAM_MESSAGE_MAX } from '@sm/core/telegram/api';
import { buildContentReadyMessage, buildKnowledgeReadyMessage, buildReplySentMessage } from './notify';

test('notification drafts stay plain-text, concise, and preview-safe', () => {
  const knowledge = buildKnowledgeReadyMessage({
    title: '  Price   list  ',
    pages: 1,
    chunks: 4,
    knowledgeUrl: 'https://app.example/knowledge',
  });
  assert.match(knowledge.text, /Price list/);
  assert.match(knowledge.text, /1 page · 4 passages/);
  assert.equal(knowledge.disableWebPagePreview, true);

  const content = buildContentReadyMessage({ goal: '', postCount: 1, postsUrl: 'https://app.example/posts' });
  assert.equal(content.text.includes('Goal:'), false);
  assert.match(content.text, /1 new post idea/);
});

test('reply notification keeps a readable separator and clamps Telegram length', () => {
  const reply = buildReplySentMessage({
    channel: 'Instagram',
    authorName: 'Ada',
    replyText: 'Thanks for asking',
    permalink: 'https://example.test/comment',
  });
  assert.match(reply.text, /To: Ada\n\nThanks for asking/);

  const huge = buildContentReadyMessage({
    goal: 'x'.repeat(10_000),
    postCount: 2,
    postsUrl: 'https://app.example/posts',
  });
  assert.ok(huge.text.length <= TELEGRAM_MESSAGE_MAX);
});
