import type { Actor, Area, Question } from './contracts';

export interface AttemptRow {
  id: string;
  team_id: string;
  user_id: string;
  channel_id: string;
  question_id: string;
  state: 'pending_question' | 'open' | 'pending_result' | 'closed' | 'cancelled';
  requested_ms: number;
  question_ts: string | null;
  started_ms: number | null;
  ended_ms: number | null;
  mode: 'answer' | 'reveal' | null;
  choice: number | null;
  claim_event_id: string | null;
  claimed_ms: number | null;
  result_sent_ms: number | null;
}

interface QuestionRow {
  id: string;
  area: Area;
  subject: string;
  prompt: string;
  options_json: string | null;
  answer: number | null;
  explanation: string;
  key_points_json: string;
  version: number;
}

function questionFromRow(row: QuestionRow): Question {
  return {
    id: row.id,
    area: row.area,
    subject: row.subject,
    prompt: row.prompt,
    options: row.options_json === null ? null : JSON.parse(row.options_json) as string[],
    answer: row.answer,
    explanation: row.explanation,
    keyPoints: JSON.parse(row.key_points_json) as string[],
    version: row.version,
  };
}

export class PracticeRepository {
  constructor(private readonly db: D1Database) {}

  async claimEvent(eventId: string, nowMs: number): Promise<boolean> {
    const result = await this.db.prepare('INSERT OR IGNORE INTO inbound_events (event_id, received_ms) VALUES (?, ?)')
      .bind(eventId, nowMs).run();
    return result.meta.changes === 1;
  }

  async releaseEvent(eventId: string): Promise<void> {
    await this.db.prepare('DELETE FROM inbound_events WHERE event_id = ?').bind(eventId).run();
  }

  async active(actor: Actor): Promise<AttemptRow | null> {
    return await this.db.prepare(`SELECT * FROM attempts
      WHERE team_id = ? AND user_id = ? AND channel_id = ?
        AND state IN ('pending_question', 'open', 'pending_result')
      LIMIT 1`).bind(actor.teamId, actor.userId, actor.channelId).first<AttemptRow>();
  }

  async latestTerminalMs(actor: Actor): Promise<number | null> {
    const row = await this.db.prepare(`SELECT MAX(COALESCE(result_sent_ms, ended_ms)) AS last_ms FROM attempts
      WHERE team_id = ? AND user_id = ? AND channel_id = ?
        AND state IN ('closed', 'cancelled')`)
      .bind(actor.teamId, actor.userId, actor.channelId).first<{ last_ms: number | null }>();
    return row?.last_ms ?? null;
  }

  async question(id: string): Promise<Question | null> {
    const row = await this.db.prepare("SELECT * FROM questions WHERE id = ? AND status = 'reviewed'")
      .bind(id).first<QuestionRow>();
    return row ? questionFromRow(row) : null;
  }

  // COUNT + indexed ID order avoids an ORDER BY RANDOM() sort over the bank.
  // A finite count also distinguishes exhausted content from a transient miss.
  async unseen(actor: Actor, area: Area, random: () => number): Promise<Question | null> {
    const where = `q.area = ? AND q.status = 'reviewed' AND NOT EXISTS (
      SELECT 1 FROM seen_questions s
      WHERE s.team_id = ? AND s.user_id = ? AND s.question_id = q.id)`;
    const args = [area, actor.teamId, actor.userId];
    const count = await this.db.prepare(`SELECT COUNT(*) AS n FROM questions q WHERE ${where}`)
      .bind(...args).first<{ n: number }>();
    if (!count || count.n === 0) return null;
    const offset = Math.min(count.n - 1, Math.max(0, Math.floor(random() * count.n)));
    const row = await this.db.prepare(`SELECT q.* FROM questions q WHERE ${where}
      ORDER BY q.id LIMIT 1 OFFSET ?`).bind(...args, offset).first<QuestionRow>();
    return row ? questionFromRow(row) : null;
  }

  async createPending(attempt: AttemptRow): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO attempts
      (id, team_id, user_id, channel_id, question_id, state, requested_ms, claim_event_id, claimed_ms)
      VALUES (?, ?, ?, ?, ?, 'pending_question', ?, ?, ?)`)
      .bind(attempt.id, attempt.team_id, attempt.user_id, attempt.channel_id,
        attempt.question_id, attempt.requested_ms, attempt.claim_event_id, attempt.claimed_ms).run();
    return result.meta.changes === 1;
  }

  async discardPending(id: string, eventId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM attempts
      WHERE id = ? AND state = 'pending_question' AND claim_event_id = ?`)
      .bind(id, eventId).run();
  }

  async discardStalePending(id: string, beforeMs: number): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM attempts
      WHERE id = ? AND state = 'pending_question' AND claimed_ms < ?`)
      .bind(id, beforeMs).run();
    return result.meta.changes === 1;
  }

  async openAfterPost(attempt: AttemptRow, ts: string, startedMs: number): Promise<boolean> {
    // The seen write is conditional on the same claim, in one D1 transaction.
    // INSERT OR IGNORE keeps retries from replacing the original seen time.
    const [opened, seen] = await this.db.batch([
      this.db.prepare(`UPDATE attempts SET state = 'open', question_ts = ?, started_ms = ?,
        claim_event_id = NULL, claimed_ms = NULL
        WHERE id = ? AND state = 'pending_question' AND claim_event_id = ?`)
        .bind(ts, startedMs, attempt.id, attempt.claim_event_id),
      this.db.prepare(`INSERT OR IGNORE INTO seen_questions
        (team_id, user_id, question_id, seen_ms)
        SELECT team_id, user_id, question_id, ? FROM attempts WHERE id = ? AND state = 'open'`)
        .bind(startedMs, attempt.id),
    ]);
    void seen;
    return opened.meta.changes === 1;
  }

  async claimResult(attemptId: string, eventId: string, nowMs: number,
    endedMs: number, mode: 'answer' | 'reveal', choice: number | null): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE attempts
      SET state = 'pending_result', ended_ms = ?, mode = ?, choice = ?,
          claim_event_id = ?, claimed_ms = ?
      WHERE id = ? AND state = 'open' AND started_ms <= ?`)
      .bind(endedMs, mode, choice, eventId, nowMs, attemptId, endedMs).run();
    return result.meta.changes === 1;
  }

  async reclaimResult(attemptId: string, eventId: string, nowMs: number,
    beforeMs: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE attempts
      SET claim_event_id = ?, claimed_ms = ?
      WHERE id = ? AND state = 'pending_result'
        AND (claim_event_id IS NULL OR claimed_ms < ?)`)
      .bind(eventId, nowMs, attemptId, beforeMs).run();
    return result.meta.changes === 1;
  }

  async releaseResult(attemptId: string, eventId: string): Promise<void> {
    await this.db.prepare(`UPDATE attempts SET claim_event_id = NULL, claimed_ms = NULL
      WHERE id = ? AND state = 'pending_result' AND claim_event_id = ?`)
      .bind(attemptId, eventId).run();
  }

  async closeAfterResult(attemptId: string, eventId: string, sentMs: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE attempts SET state = 'closed',
      result_sent_ms = ?, claim_event_id = NULL, claimed_ms = NULL
      WHERE id = ? AND state = 'pending_result' AND claim_event_id = ?`)
      .bind(sentMs, attemptId, eventId).run();
    return result.meta.changes === 1;
  }

  async cancelUnavailable(attemptId: string, endedMs: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE attempts
      SET state = 'cancelled', ended_ms = ?, claim_event_id = NULL, claimed_ms = NULL
      WHERE id = ? AND state IN ('open', 'pending_result')`).bind(endedMs, attemptId).run();
    return result.meta.changes === 1;
  }

  async cleanup(nowMs: number): Promise<void> {
    const day = 86_400_000;
    const ninetyDaysAgo = nowMs - 90 * day;
    const oneDayAgo = nowMs - day;
    await this.db.batch([
      this.db.prepare('DELETE FROM attempts WHERE requested_ms < ?').bind(ninetyDaysAgo),
      this.db.prepare('DELETE FROM seen_questions WHERE seen_ms < ?').bind(ninetyDaysAgo),
      this.db.prepare('DELETE FROM inbound_events WHERE received_ms < ?').bind(oneDayAgo),
    ]);
  }
}
