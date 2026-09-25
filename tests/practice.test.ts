import { describe, expect, it, vi } from 'vitest';
import type { Actor, Messenger, PracticeInput, Question, ResultView } from '../src/contracts';
import { PracticeService } from '../src/practice';
import { addQuestion, testDatabase } from './sqlite';

const actor: Actor = { teamId: 'T1', userId: 'U1', channelId: 'D1' };
const base = { ...actor, atMs: 1_700_000_043_000 };

function fixture() {
  const { db, sqlite } = testDatabase();
  const questions: Array<{ question: Question; attemptId: string }> = [];
  const results: ResultView[] = [];
  const notices: string[] = [];
  const messenger: Messenger = {
    menu: vi.fn(async () => {}),
    notice: vi.fn(async (_actor, text) => { notices.push(text); }),
    question: vi.fn(async (_actor, question, attemptId) => {
      questions.push({ question, attemptId });
      return '1700000000.250';
    }),
    result: vi.fn(async (_actor, view) => { results.push(view); }),
  };
  let nowMs = 1_700_000_040_000;
  let nextId = 1;
  const service = new PracticeService(db, messenger, {
    now: () => nowMs, random: () => 0, id: () => `A${nextId++}`,
  });
  return { sqlite, questions, results, notices, messenger, service,
    setNow(value: number) { nowMs = value; } };
}

describe('PracticeService', () => {
  it('starts from the successful Slack post, keeps an active CS question, and never stores answer text', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'cs-1', 'CS');
    const request: PracticeInput = { ...base, kind: 'request', area: 'CS', eventId: 'E1' };
    await f.service.handle(request);
    await f.service.handle({ ...request, eventId: 'E2' });
    expect(f.questions).toHaveLength(2);
    expect(f.questions[0].attemptId).toBe(f.questions[1].attemptId);
    expect(f.sqlite.prepare('SELECT started_ms AS n FROM attempts').get()).toEqual({ n: 1_700_000_000_250 });

    await f.service.handle({ ...base, kind: 'answer', eventId: 'E3', text: '민감한 개인 답변' });
    expect(f.results).toMatchObject([{ mode: 'answer', elapsedSeconds: 43, interrupted: false }]);
    const row = f.sqlite.prepare('SELECT state, mode, choice FROM attempts').get();
    expect(row).toEqual({ state: 'closed', mode: 'answer', choice: null });
    expect(JSON.stringify(row)).not.toContain('민감한');
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM seen_questions').get()).toEqual({ n: 1 });
    await f.service.handle({ ...base, atMs: base.atMs + 1,
      kind: 'request', area: 'CS', eventId: 'E4' });
    expect(f.notices.at(-1)).toContain('모두 확인');
  });

  it('validates CT choices, rejects a stale reveal, and flags a long attempt', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'ct-1', 'CT');
    await f.service.handle({ ...base, kind: 'request', area: 'CT', eventId: 'E1' });
    await f.service.handle({ ...base, kind: 'answer', text: '5', eventId: 'E2' });
    expect(f.results).toHaveLength(0);
    expect(f.notices.at(-1)).toContain('1~4');
    await f.service.handle({ ...base, kind: 'reveal', attemptId: 'old', eventId: 'E3' });
    expect(f.results).toHaveLength(0);
    expect(f.sqlite.prepare('SELECT state FROM attempts').get()).toEqual({ state: 'open' });
    await f.service.handle({ ...base, atMs: 1_700_001_802_000,
      kind: 'answer', text: ' ② ', eventId: 'E4' });
    expect(f.results).toMatchObject([{ mode: 'answer', interrupted: true }]);
    expect(f.sqlite.prepare('SELECT choice FROM attempts').get()).toEqual({ choice: 2 });
  });

  it('recovers failed question and result posts without consuming or losing a problem', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'ct-1', 'CT');
    const originalQuestion = f.messenger.question;
    f.messenger.question = vi.fn().mockRejectedValueOnce(new Error('Slack unavailable'))
      .mockImplementation(originalQuestion);
    const request: PracticeInput = { ...base, kind: 'request', area: 'CT', eventId: 'E1' };
    await expect(f.service.handle(request)).rejects.toThrow('Slack unavailable');
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM seen_questions').get()).toEqual({ n: 0 });
    await f.service.handle(request);
    const attemptId = f.questions[0].attemptId;

    const originalResult = f.messenger.result;
    f.messenger.result = vi.fn().mockRejectedValueOnce(new Error('Slack unavailable'))
      .mockImplementation(originalResult);
    const reveal: PracticeInput = { ...base, kind: 'reveal', attemptId, eventId: 'E2' };
    await expect(f.service.handle(reveal)).rejects.toThrow('Slack unavailable');
    expect(f.sqlite.prepare('SELECT state FROM attempts').get()).toEqual({ state: 'pending_result' });
    await f.service.handle(reveal);
    expect(f.results).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT state FROM attempts').get()).toEqual({ state: 'closed' });
    await f.service.handle(reveal);
    expect(f.results).toHaveLength(1);
  });

  it('does not create two active attempts for concurrent requests', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'cs-1', 'CS');
    addQuestion(f.sqlite, 'cs-2', 'CS');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.messenger.question;
    f.messenger.question = vi.fn(async (...args: Parameters<Messenger['question']>) => {
      await gate;
      return original(...args);
    });
    const first = f.service.handle({ ...base, kind: 'request', area: 'CS', eventId: 'E1' });
    // Wait until the first request owns the DB attempt before sending the second.
    await vi.waitFor(() => expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 }));
    await f.service.handle({ ...base, kind: 'request', area: 'CS', eventId: 'E2' });
    expect(f.notices.at(-1)).toContain('전송하는 중');
    release();
    await first;
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state != 'closed'").get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM seen_questions').get()).toEqual({ n: 1 });
  });

  it('ignores an old answer that arrives after a newer question was posted', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'cs-1', 'CS');
    addQuestion(f.sqlite, 'cs-2', 'CS');
    await f.service.handle({ ...base, kind: 'request', area: 'CS', eventId: 'E1' });
    await f.service.handle({ ...base, kind: 'reveal', attemptId: 'A1', eventId: 'E2' });
    f.messenger.question = vi.fn(async (_actor, question, attemptId) => {
      f.questions.push({ question, attemptId });
      return '1700000050.000';
    });
    f.setNow(1_700_000_050_000);
    await f.service.handle({ ...base, atMs: 1_700_000_050_000,
      kind: 'request', area: 'CS', eventId: 'E3' });
    await f.service.handle({ ...base, atMs: 1_700_000_001_000,
      kind: 'answer', text: '늦게 도착한 답', eventId: 'E4' });
    expect(f.results).toHaveLength(1);
    expect(f.notices.at(-1)).toContain('전송되기 전');
    expect(f.sqlite.prepare("SELECT state FROM attempts WHERE id = 'A2'").get()).toEqual({ state: 'open' });
  });

  it('serializes competing answer and reveal events with a database CAS', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'ct-1', 'CT');
    await f.service.handle({ ...base, kind: 'request', area: 'CT', eventId: 'E1' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.messenger.result;
    f.messenger.result = vi.fn(async (...args: Parameters<Messenger['result']>) => {
      await gate;
      return original(...args);
    });
    const answer = f.service.handle({ ...base, kind: 'answer', text: '2', eventId: 'E2' });
    await vi.waitFor(() => expect(f.sqlite.prepare('SELECT state FROM attempts').get())
      .toEqual({ state: 'pending_result' }));
    await f.service.handle({ ...base, kind: 'reveal', attemptId: 'A1', eventId: 'E3' });
    expect(f.notices.at(-1)).toContain('전송하는 중');
    release();
    await answer;
    expect(f.results).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT mode FROM attempts').get()).toEqual({ mode: 'answer' });
  });

  it('does not reveal content withdrawn while an attempt is open', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'ct-1', 'CT');
    await f.service.handle({ ...base, kind: 'request', area: 'CT', eventId: 'E1' });
    f.sqlite.prepare("UPDATE questions SET status = 'disabled' WHERE id = 'ct-1'").run();
    await f.service.handle({ ...base, kind: 'answer', text: '2', eventId: 'E2' });
    expect(f.results).toHaveLength(0);
    expect(f.notices.at(-1)).toContain('제공이 중단');
    expect(f.sqlite.prepare('SELECT state FROM attempts').get()).toEqual({ state: 'cancelled' });
  });

  it('rejects a delayed old request after completion and accepts a later choice', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'cs-1', 'CS');
    addQuestion(f.sqlite, 'cs-2', 'CS');
    await f.service.handle({ ...base, kind: 'request', area: 'CS', eventId: 'E1' });
    await f.service.handle({ ...base, kind: 'reveal', attemptId: 'A1', eventId: 'E2' });
    await f.service.handle({ ...base, atMs: base.atMs - 1,
      kind: 'request', area: 'CS', eventId: 'E3' });
    expect(f.questions).toHaveLength(1);
    expect(f.notices.at(-1)).toContain('이전 학습');
    await f.service.handle({ ...base, atMs: base.atMs + 1,
      kind: 'request', area: 'CS', eventId: 'E4' });
    expect(f.questions).toHaveLength(2);
  });

  it('uses cancellation processing time to reject requests that arrived late', async () => {
    const f = fixture();
    addQuestion(f.sqlite, 'cs-1', 'CS');
    addQuestion(f.sqlite, 'cs-2', 'CS');
    await f.service.handle({ ...base, kind: 'request', area: 'CS', eventId: 'E1' });
    f.sqlite.prepare("UPDATE questions SET status = 'disabled' WHERE id = 'cs-1'").run();
    f.setNow(1_700_000_100_000);
    await f.service.handle({ ...base, atMs: 1_700_000_050_000,
      kind: 'answer', text: '오래된 답변', eventId: 'E2' });
    expect(f.sqlite.prepare("SELECT ended_ms AS n FROM attempts WHERE id = 'A1'").get())
      .toEqual({ n: 1_700_000_100_000 });
    await f.service.handle({ ...base, atMs: 1_700_000_070_000,
      kind: 'request', area: 'CS', eventId: 'E3' });
    expect(f.questions).toHaveLength(1);
    expect(f.notices.at(-1)).toContain('이전 학습');
  });
});
