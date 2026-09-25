import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse, type Request as RuntimeRequest } from 'miniflare';

// Runs the built Worker and actual local D1. All outbound network is intercepted.
// No Slack workspace, token, paid service or existing local DB is used.
const messages: Array<{ text: string; blocks: Array<Record<string, any>> }> = [];
const secret = 'runtime-test-only-secret';
let slackClockMs = Date.now() + 10_000;
const slackTimestamp = () => ((slackClockMs += 100) / 1000).toFixed(6);
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: 'dist/index.js',
  compatibilityDate: '2025-09-25',
  d1Databases: ['DB'],
  bindings: { SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: 'fake-runtime-token', SLACK_TEAM_ID: 'T1' },
  outboundService: async (request: RuntimeRequest) => {
    assert.equal(request.url, 'https://slack.com/api/chat.postMessage');
    messages.push(await request.json() as typeof messages[number]);
    return RuntimeResponse.json({ ok: true, ts: slackTimestamp() });
  },
}));

async function until(predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(25);
  }
  throw new Error(`Runtime operation timed out. Captured sample message summaries: ${messages.map(m => m.text.slice(0, 100)).join(' | ')}`);
}

let eventNumber = 0;
async function send(payload: unknown, form = false) {
  const body = form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  const response = await mf.dispatchFetch(`https://example.test/slack/${form ? 'interactions' : 'events'}`, {
    method: 'POST', body, headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}`,
    },
  });
  assert.equal(response.status, 200);
  return response;
}
function action(actionId: string, value: string) {
  return { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'D1' },
    actions: [{ action_id: actionId, value, action_ts: slackTimestamp() }] };
}
function message(text: string) {
  return { type: 'event_callback', team_id: 'T1', event_id: `Ev${++eventNumber}`, event: {
    type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text,
    ts: slackTimestamp(),
  } };
}

try {
  const db = await mf.getD1Database('DB');
  for (const filename of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    const migration = readFileSync(`migrations/${filename}`, 'utf8');
    await db.batch(migration.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  const seed = readFileSync('content/seed.sql', 'utf8');
  await db.batch(seed.split('\n').filter(line => line.startsWith('INSERT INTO')).map(line => db.prepare(line)));
  const eligible = await db.prepare("SELECT count(*) AS n FROM questions WHERE status='reviewed'").first<{ n: number }>();
  assert.equal(eligible?.n, 12, 'Seed must contain 12 independently reviewed sample questions');
  assert.equal((await mf.dispatchFetch('https://example.test/health')).status, 200);
  const challenge = await send({ type: 'url_verification', challenge: 'runtime-challenge' });
  assert.deepEqual(await challenge.json(), { challenge: 'runtime-challenge' });
  await send(message('시작'));
  await until(() => messages.length === 1);
  assert.equal(messages[0].blocks.at(-1)?.elements.length, 2);

  const request = action('practice_ct', 'CT');
  await send(request, true);
  await until(async () => !!await db.prepare("SELECT id FROM attempts WHERE state='open'").first());
  assert.equal(messages.length, 2);
  const attempt = await db.prepare("SELECT id FROM attempts WHERE state='open'").first<{ id: string }>();
  assert.ok(attempt);
  await send(request, true); // Slack retry of exactly the same click.
  await setTimeout(150);
  assert.equal(messages.length, 2);
  await send(message('9'));
  await until(() => messages.length === 3);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM attempts WHERE state='open'").first<{ n: number }>())?.n, 1);
  await send(action('practice_reveal', attempt.id), true);
  await until(async () => !!await db.prepare("SELECT id FROM attempts WHERE state='closed'").first());
  assert.ok(messages.at(-1)?.text.includes('정답:'));

  await send(action('practice_cs', 'CS'), true);
  await until(async () => !!await db.prepare("SELECT id FROM attempts WHERE state='open'").first());
  const privateAnswer = '내 CS 답변 원문은 자체 DB에 저장되면 안 됩니다.';
  await send(message(privateAnswer));
  await until(async () => (await db.prepare("SELECT count(*) AS n FROM attempts WHERE state='closed'").first<{ n: number }>())?.n === 2);
  assert.ok(messages.at(-1)?.text.includes('핵심 개념'));
  assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM attempts').all()).includes(privateAnswer));
  console.log('Runtime smoke passed: signed HTTP → Worker → local D1 → intercepted Slack, CT/CS flows, dedup, invalid choice, privacy.');
} finally {
  await mf.dispose();
}
