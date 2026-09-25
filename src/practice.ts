import type { Actor, Messenger, PracticeInput, Question, ResultView } from './contracts';
import { PracticeRepository, type AttemptRow } from './repository';

const LEASE_MS = 30_000;
const INTERRUPTED_SECONDS = 1_800;

export interface PracticeOptions {
  now?: () => number;
  random?: () => number;
  id?: () => string;
}

function actorOf(input: PracticeInput): Actor {
  return { teamId: input.teamId, userId: input.userId, channelId: input.channelId };
}

function slackMs(ts: string): number {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid Slack post timestamp');
  return Math.round(seconds * 1_000);
}

function ctChoice(text: string): number | null {
  const value = text.trim();
  if (/^[1-4]$/.test(value)) return Number(value);
  const circled = ['①', '②', '③', '④'];
  const index = circled.indexOf(value);
  return index === -1 ? null : index + 1;
}

export class PracticeService {
  private readonly repo: PracticeRepository;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly id: () => string;

  constructor(db: D1Database, private readonly messenger: Messenger, options: PracticeOptions = {}) {
    this.repo = new PracticeRepository(db);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  async handle(input: PracticeInput): Promise<void> {
    const processingMs = this.now();
    if (!await this.repo.claimEvent(input.eventId, processingMs)) return;
    try {
      await this.process(input, processingMs);
    } catch (error) {
      // A failed delivery can be retried with the same Slack event ID.
      await this.repo.releaseEvent(input.eventId);
      throw error;
    }
  }

  async cleanup(nowMs = this.now()): Promise<void> {
    await this.repo.cleanup(nowMs);
  }

  private async process(input: PracticeInput, processingMs: number): Promise<void> {
    const actor = actorOf(input);
    if (input.kind === 'menu') {
      await this.messenger.menu(actor);
      return;
    }

    let active = await this.repo.active(actor);

    if (input.kind === 'request') {
      const lastTerminalMs = await this.repo.latestTerminalMs(actor);
      if (lastTerminalMs !== null && input.atMs <= lastTerminalMs) {
        await this.messenger.notice(actor, '이전 학습에서 누른 버튼입니다. 새 문제를 받으려면 다시 선택해 주세요.');
        return;
      }
    }

    // A button from an older message must never act on the current attempt.
    if (input.kind === 'reveal' && active?.id !== input.attemptId) {
      await this.messenger.notice(actor, '이전 문제의 버튼입니다. 현재 문제에서 답안을 확인해 주세요.');
      return;
    }

    if (active?.state === 'pending_result') {
      await this.retryResult(actor, active, input.eventId, processingMs, input.atMs);
      return;
    }

    if (input.kind === 'request') {
      if (active?.state === 'pending_question' &&
          active.claimed_ms !== null && active.claimed_ms < processingMs - LEASE_MS) {
        if (await this.repo.discardStalePending(active.id, processingMs - LEASE_MS)) {
          active = null;
        } else {
          active = await this.repo.active(actor);
        }
      }
      if (active) {
        await this.resurface(actor, active, input.atMs);
        return;
      }
      await this.newQuestion(actor, input, processingMs);
      return;
    }

    if (!active || active.state === 'pending_question') {
      await this.messenger.notice(actor, active
        ? '문제를 전송하는 중입니다. 잠시 후 다시 시도해 주세요.'
        : '진행 중인 문제가 없습니다. CS 질문 또는 CT 문제를 선택해 주세요.');
      return;
    }

    const question = await this.activeQuestion(actor, active, input.atMs);
    if (!question) return;
    if (input.atMs < active.started_ms!) {
      await this.messenger.notice(actor, '현재 문제가 전송되기 전의 입력입니다. 현재 문제에 다시 답해 주세요.');
      return;
    }
    let choice: number | null = null;
    if (input.kind === 'answer') {
      if (question.area === 'CT') {
        choice = ctChoice(input.text);
        if (choice === null) {
          await this.messenger.notice(actor, '답은 1~4 또는 ①~④ 중 하나만 보내 주세요. 현재 문제는 그대로 유지됩니다.');
          return;
        }
      } else if (!input.text.trim()) {
        await this.messenger.notice(actor, '답변을 입력하거나 바로 답안 보기 버튼을 눌러 주세요.');
        return;
      }
    }

    const mode = input.kind === 'answer' ? 'answer' : 'reveal';
    const claimed = await this.repo.claimResult(active.id, input.eventId, processingMs,
      input.atMs, mode, choice);
    if (!claimed) {
      const current = await this.repo.active(actor);
      if (current?.state === 'pending_result') {
        await this.retryResult(actor, current, input.eventId, processingMs, input.atMs);
      } else {
        await this.messenger.notice(actor, '이미 처리 중이거나 완료된 문제입니다. 새 문제를 선택해 주세요.');
      }
      return;
    }
    await this.sendResult(actor, { ...active, state: 'pending_result', ended_ms: input.atMs,
      mode, choice, claim_event_id: input.eventId, claimed_ms: processingMs }, question, input.eventId);
  }

  private async resurface(actor: Actor, attempt: AttemptRow, atMs: number): Promise<void> {
    if (attempt.state === 'pending_question') {
      await this.messenger.notice(actor, '문제를 전송하는 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    const question = await this.activeQuestion(actor, attempt, atMs);
    if (!question) return;
    // A repeated post is only a reminder; the first successful post remains the timer start.
    await this.messenger.question(actor, question, attempt.id);
  }

  private async newQuestion(actor: Actor, input: Extract<PracticeInput, { kind: 'request' }>,
    processingMs: number): Promise<void> {
    const question = await this.repo.unseen(actor, input.area, this.random);
    if (!question) {
      await this.messenger.notice(actor, `${input.area}의 검수 완료 문제를 모두 확인했습니다. 새 문제가 추가되면 다시 이용해 주세요.`);
      return;
    }
    const attempt: AttemptRow = {
      id: this.id(), team_id: actor.teamId, user_id: actor.userId,
      channel_id: actor.channelId, question_id: question.id,
      state: 'pending_question', requested_ms: processingMs, question_ts: null,
      started_ms: null, ended_ms: null, mode: null, choice: null,
      claim_event_id: input.eventId, claimed_ms: processingMs, result_sent_ms: null,
    };
    if (!await this.repo.createPending(attempt)) {
      const concurrent = await this.repo.active(actor);
      if (concurrent) await this.resurface(actor, concurrent, input.atMs);
      else await this.messenger.notice(actor, '요청이 동시에 처리되었습니다. 다시 선택해 주세요.');
      return;
    }
    let ts: string;
    try {
      ts = await this.messenger.question(actor, question, attempt.id);
    } catch (error) {
      await this.repo.discardPending(attempt.id, input.eventId);
      throw error;
    }
    // If Slack accepted the message but D1 fails, retain the claim for its
    // lease period; an immediate retry would send a duplicate question.
    const opened = await this.repo.openAfterPost(attempt, ts, slackMs(ts));
    if (!opened) throw new Error('Question state changed during Slack delivery');
  }

  private async retryResult(actor: Actor, attempt: AttemptRow, eventId: string,
    processingMs: number, atMs: number): Promise<void> {
    const claimed = await this.repo.reclaimResult(attempt.id, eventId, processingMs,
      processingMs - LEASE_MS);
    if (!claimed) {
      await this.messenger.notice(actor, '답안을 전송하는 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    const question = await this.activeQuestion(actor, attempt, atMs);
    if (!question) return;
    await this.sendResult(actor, attempt, question, eventId);
  }

  private async sendResult(actor: Actor, attempt: AttemptRow, question: Question,
    eventId: string): Promise<void> {
    if (attempt.started_ms === null || attempt.ended_ms === null || attempt.mode === null) {
      throw new Error('Incomplete result state');
    }
    const elapsedSeconds = Math.max(0, Math.round((attempt.ended_ms - attempt.started_ms) / 1_000));
    const view: ResultView = {
      question, mode: attempt.mode, elapsedSeconds,
      interrupted: elapsedSeconds > INTERRUPTED_SECONDS,
    };
    try {
      await this.messenger.result(actor, view);
    } catch (error) {
      await this.repo.releaseResult(attempt.id, eventId);
      throw error;
    }
    // Keep the lease if Slack succeeded but D1 failed. A later recovery may
    // repeat this result; Slack chat.postMessage has no atomic commit with D1.
    const closed = await this.repo.closeAfterResult(attempt.id, eventId,
      Math.max(this.now(), attempt.ended_ms));
    if (!closed) throw new Error('Result state changed during Slack delivery');
  }

  private async activeQuestion(actor: Actor, attempt: AttemptRow, atMs: number): Promise<Question | null> {
    const question = await this.repo.question(attempt.question_id);
    if (!question) {
      await this.repo.cancelUnavailable(attempt.id, Math.max(this.now(), atMs));
      await this.messenger.notice(actor, '이 문제는 제공이 중단되었습니다. 새 문제를 선택해 주세요.');
      return null;
    }
    return question;
  }
}
