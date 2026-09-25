import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWorker, type Env } from '../src/index';

const env = { SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'fake-token', SLACK_TEAM_ID: 'T1' } as Env;
function request(payload: unknown, valid = true, path = '/slack/events') {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', valid ? env.SLACK_SIGNING_SECRET : 'wrong').update(`v0:${timestamp}:${body}`).digest('hex');
  return new Request(`https://example.test${path}`, { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}`,
  } });
}

describe('Worker entrypoint', () => {
  it('authenticates Slack URL verification before echoing a challenge', async () => {
    const worker = createWorker(() => ({ handle: vi.fn(), cleanup: vi.fn() }));
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const response = await worker.fetch(request({ type: 'url_verification', challenge: 'challenge-123' }), env, ctx);
    expect(await response.json()).toEqual({ challenge: 'challenge-123' });
    expect((await worker.fetch(request({ type: 'url_verification', challenge: 'challenge-123' }, false), env, ctx)).status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('acknowledges before asynchronous Slack processing finishes', async () => {
    let finish!: () => void;
    const handle = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const worker = createWorker(() => ({ handle, cleanup: vi.fn() }));
    const promises: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { promises.push(p); } } as unknown as ExecutionContext;
    const response = await worker.fetch(request({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: {
      type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', text: '시작', ts: `${Math.floor(Date.now() / 1000)}.001`,
    } }), env, ctx);
    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'menu', userId: 'U1' }));
    expect(promises).toHaveLength(1);
    finish();
    await Promise.all(promises);
  });
  it('never queues foreign-team input or unexpected routes', async () => {
    const handle = vi.fn();
    const worker = createWorker(() => ({ handle, cleanup: vi.fn() }));
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    await worker.fetch(request({ type: 'event_callback', team_id: 'T2', event_id: 'Ev1', event: { type: 'message', user: 'U1', channel: 'D1', channel_type: 'im', text: '3', ts: '1750000000.001' } }), env, ctx);
    expect(handle).not.toHaveBeenCalled();
    expect((await worker.fetch(request({}, true, '/wrong'), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request('https://example.test/health'), env, ctx)).status).toBe(200);
  });
});
