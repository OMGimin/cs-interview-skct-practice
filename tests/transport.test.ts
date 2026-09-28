import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifySlackRequest } from '../src/security';
import { normalizePayload } from '../src/payload';
import { SlackMessenger } from '../src/slack';
import type { Question } from '../src/contracts';

const now = 1_750_000_000_000;
const secret = 'test-only-signing-secret';
function signed(body: string, timestamp = String(now / 1000)) {
  return new Headers({
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
  });
}

describe('Slack request authentication', () => {
  it('accepts original raw body and rejects a tampered body', async () => {
    const body = 'payload=%7B%22text%22%3A%22hello%22%7D';
    expect(await verifySlackRequest(body, signed(body), secret, now)).toBe(true);
    expect(await verifySlackRequest(body + 'x', signed(body), secret, now)).toBe(false);
  });
  it('rejects expired, future and malformed signatures', async () => {
    for (const timestamp of [String(now / 1000 - 301), String(now / 1000 + 301), 'NaN']) {
      expect(await verifySlackRequest('{}', signed('{}', timestamp), secret, now)).toBe(false);
    }
    expect(await verifySlackRequest('{}', new Headers(), secret, now)).toBe(false);
    expect(await verifySlackRequest('{}', signed('{}'), '', now)).toBe(false);
  });
});

const message = {
  type: 'event_callback', team_id: 'T1', event_id: 'Ev1',
  event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: '3', ts: '1750000000.125' },
};
describe('inbound user isolation', () => {
  it('maps a DM to an answer using Slack event time', () => {
    expect(normalizePayload(message, 'T1')).toEqual({
      teamId: 'T1', userId: 'U1', channelId: 'D1', eventId: 'event:Ev1',
      atMs: 1_750_000_000_125, kind: 'answer', text: '3',
    });
  });
  it('ignores other teams, public channels, bot loops, edits and threaded replies', () => {
    expect(normalizePayload(message, 'T2')).toBeNull();
    for (const change of [{ channel_type: 'channel' }, { channel: 'C1' }, { bot_id: 'B1' }, { subtype: 'message_changed' }, { thread_ts: '1' }]) {
      expect(normalizePayload({ ...message, event: { ...message.event, ...change } }, 'T1')).toBeNull();
    }
    for (const payload of [null, {}, { type: 'event_callback', event: null }, { type: 'block_actions', actions: [{}] }]) {
      expect(normalizePayload(payload, 'T1')).toBeNull();
    }
  });
  it('keeps the attempt ID and deduplicatable action timestamp', () => {
    const input = normalizePayload({ type: 'block_actions', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'D1' },
      actions: [{ action_id: 'practice_reveal', value: 'attempt-123', action_ts: '1750000001.5' }] }, 'T1');
    expect(input).toMatchObject({ kind: 'reveal', attemptId: 'attempt-123', atMs: 1_750_000_001_500 });
    expect(input?.eventId).toBe('action:T1:U1:1750000001.5:practice_reveal');
  });
  it('opens the menu for Slack app_home_opened integer microsecond timestamps', () => {
    expect(normalizePayload({ type: 'event_callback', team_id: 'T1', event_id: 'EvHome', event: {
      type: 'app_home_opened', user: 'U1', channel: 'D1', tab: 'messages', event_ts: '1515449522000016',
    } }, 'T1')).toMatchObject({ kind: 'menu', atMs: 1515449522000 });
  });
});

const actor = { teamId: 'T1', userId: 'U1', channelId: 'D1' };
const question: Question = { id: 'ct-1', area: 'CT', subject: '수리', prompt: '20,000원의 15% 할인 가격은?', options: ['15,000원', '16,000원', '17,000원', '18,000원'], answer: 3, explanation: '20,000 × 0.85 = 17,000원', keyPoints: [], version: 1 };
describe('Slack message delivery', () => {
  it('returns Slack server timestamp and exposes no solution in a question', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, ts: '1750000002.001' }));
    const messenger = new SlackMessenger('fake-token', fetcher);
    expect(await messenger.question(actor, question, 'attempt-123')).toBe('1750000002.001');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.channel).toBe('D1');
    expect(JSON.stringify(body)).not.toContain('20,000 ×');
    expect(body.blocks.at(-1).elements[0].value).toBe('attempt-123');
    expect(body.text).toContain(question.prompt);
  });
  it('returns the numbered solution and next buttons without grading', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, ts: '1750000002.001' }));
    await new SlackMessenger('fake-token', fetcher).result(actor, { question, mode: 'reveal', elapsedSeconds: 42, interrupted: false });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.text).toContain('③ 17,000원');
    expect(body.text).toContain('42초');
    expect(body.blocks.at(-1).elements.map((b: { action_id: string }) => b.action_id)).toEqual(['practice_cs', 'practice_ct']);
  });
  it('treats Slack ok:false and HTTP failures as delivery failures', async () => {
    for (const response of [Response.json({ ok: false, error: 'channel_not_found' }), new Response('no', { status: 503 })]) {
      const fetcher = vi.fn().mockResolvedValue(response);
      await expect(new SlackMessenger('fake-token', fetcher).menu(actor)).rejects.toThrow();
    }
  });
});
