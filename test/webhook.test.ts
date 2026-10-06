import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { classifyUserAgent } from '../src/classify.js';
import { monthsSince } from '../src/months.js';
import { safeEqual, shouldDispatch, verifySignature } from '../src/webhook.js';
import { workflowFix } from '../src/workflow.js';

const BOT = 'assemble-referee[bot]';

test('webhook signatures are verified against the raw body', async () => {
  const body = '{"action":"opened"}';
  const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(await verifySignature('s3cret', body, good), true);
  assert.equal(await verifySignature('s3cret', `${body} `, good), false);
  assert.equal(await verifySignature('wrong', body, good), false);
  assert.equal(await verifySignature('s3cret', body, null), false);
  assert.equal(await verifySignature('s3cret', body, 'sha1=abc'), false);
  assert.equal(await verifySignature('', body, good), false);
});

test('constant-time compare', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('only relevant events start a referee run, never the referee\'s own', () => {
  assert.equal(shouldDispatch('issue_comment', { sender: { login: 'alice' } }, BOT), true);
  assert.equal(shouldDispatch('pull_request', { sender: { login: 'alice' } }, BOT), true);
  assert.equal(shouldDispatch('issue_comment', { sender: { login: BOT } }, BOT), false);
  assert.equal(shouldDispatch('ping', {}, BOT), false);
  assert.equal(shouldDispatch(null, {}, BOT), false);
  assert.equal(shouldDispatch('star', { sender: { login: 'alice' } }, BOT), false);
});

test('check events count only when CI finishes', () => {
  const done = { action: 'completed', check_run: { app: { slug: 'github-actions' } }, sender: { login: 'github-actions[bot]' } };
  assert.equal(shouldDispatch('check_run', done, BOT), true);
  assert.equal(shouldDispatch('check_run', { ...done, action: 'created' }, BOT), false);
  assert.equal(shouldDispatch('check_run', { ...done, check_run: { app: { slug: 'assemble-referee' } } }, BOT), false);
  assert.equal(shouldDispatch('check_suite', { action: 'completed', check_suite: { app: { slug: 'github-actions' } } }, BOT), true);
});

test('user agents are classified coarsely', () => {
  assert.equal(classifyUserAgent('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)'), 'ai_agent');
  assert.equal(classifyUserAgent('Claude-User/1.0'), 'ai_agent');
  assert.equal(classifyUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'), 'ai_crawler');
  assert.equal(classifyUserAgent('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'), 'ai_crawler');
  assert.equal(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'search_crawler');
  assert.equal(classifyUserAgent('python-requests/2.32.3'), 'programmatic');
  assert.equal(classifyUserAgent('curl/8.7.1'), 'programmatic');
  assert.equal(classifyUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), 'browser');
  assert.equal(classifyUserAgent(''), 'unknown');
  assert.equal(classifyUserAgent(null), 'unknown');
});

test('a workflow GitHub disabled for inactivity is re-enabled; one the operator disabled is left alone', () => {
  assert.equal(workflowFix('disabled_inactivity'), 'enable');
  assert.equal(workflowFix('active'), 'leave');
  assert.equal(workflowFix('disabled_manually'), 'warn');
  assert.equal(workflowFix(undefined), 'warn');
});

test('event-log months span launch to now', () => {
  assert.deepEqual(monthsSince('2026-11-20T00:00:00Z', new Date('2027-02-03T00:00:00Z')), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthsSince('2026-11-20T00:00:00Z', new Date('2026-10-01T00:00:00Z')), []);
  assert.deepEqual(monthsSince('garbage', new Date()), []);
});
