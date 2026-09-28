import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { PracticeRepository } from '../src/repository';
import { addQuestion, testDatabase } from './sqlite';

const actor = { teamId: 'T1', userId: 'U1', channelId: 'D1' };

describe('PracticeRepository', () => {
  it('upgrades a populated 0001 database to 0002 without losing attempts', () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    addQuestion(sqlite, 'cs-a', 'CS');
    sqlite.prepare(`INSERT INTO attempts
      (id, team_id, user_id, channel_id, question_id, state, requested_ms,
       question_ts, started_ms, ended_ms, mode, result_sent_ms)
      VALUES ('A1','T1','U1','D1','cs-a','closed',1000,'1.000',1000,2000,'reveal',2100)`).run();
    sqlite.prepare(`INSERT INTO attempts
      (id, team_id, user_id, channel_id, question_id, state, requested_ms,
       question_ts, started_ms)
      VALUES ('A2','T1','U1','D1','cs-a','open',3000,'3.000',3000)`).run();
    const before = sqlite.prepare('SELECT * FROM attempts ORDER BY id').all();
    sqlite.exec(readFileSync(new URL('../migrations/0002_cancelled_attempts.sql', import.meta.url), 'utf8'));
    expect(sqlite.prepare('SELECT * FROM attempts ORDER BY id').all()).toEqual(before);
    expect(sqlite.prepare("UPDATE attempts SET state = 'cancelled', ended_ms = 4000 WHERE id = 'A2'").run().changes)
      .toBe(1);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    sqlite.close();
  });

  it('draws only reviewed unseen questions and reports finite exhaustion', async () => {
    const { db, sqlite } = testDatabase();
    addQuestion(sqlite, 'cs-a', 'CS', 'draft');
    addQuestion(sqlite, 'cs-b', 'CS', 'reviewed');
    addQuestion(sqlite, 'cs-c', 'CS', 'disabled');
    addQuestion(sqlite, 'ct-a', 'CT', 'reviewed');
    const repo = new PracticeRepository(db);
    expect((await repo.unseen(actor, 'CS', () => 0))?.id).toBe('cs-b');
    sqlite.prepare('INSERT INTO seen_questions VALUES (?, ?, ?, ?)')
      .run(actor.teamId, actor.userId, 'cs-b', 1000);
    expect(await repo.unseen(actor, 'CS', () => 0)).toBeNull();
    expect((await repo.unseen({ ...actor, userId: 'U2' }, 'CS', () => 0))?.id).toBe('cs-b');
    expect((await repo.unseen(actor, 'CT', () => 0))?.id).toBe('ct-a');
  });

  it('keeps one active attempt by database constraint and prunes by retention policy', async () => {
    const { db, sqlite } = testDatabase();
    addQuestion(sqlite, 'cs-a', 'CS');
    const repo = new PracticeRepository(db);
    const attempt = {
      id: 'A1', team_id: 'T1', user_id: 'U1', channel_id: 'D1', question_id: 'cs-a',
      state: 'pending_question' as const, requested_ms: 1000, question_ts: null,
      started_ms: null, ended_ms: null, mode: null, choice: null,
      claim_event_id: 'E1', claimed_ms: 1000, result_sent_ms: null,
    };
    expect(await repo.createPending(attempt)).toBe(true);
    expect(await repo.createPending({ ...attempt, id: 'A2', claim_event_id: 'E2' })).toBe(false);
    expect(await repo.claimEvent('E1', 1000)).toBe(true);
    expect(await repo.claimEvent('E1', 1000)).toBe(false);
    expect(await repo.openAfterPost(attempt, '1.250', 1250)).toBe(true);
    expect(sqlite.prepare('SELECT seen_ms FROM seen_questions').get()).toEqual({ seen_ms: 1250 });
    expect(await repo.claimResult('A1', 'E2', 2000, 1249, 'answer', null)).toBe(false);
    expect(sqlite.prepare('SELECT state FROM attempts').get()).toEqual({ state: 'open' });
    const ninetyOneDays = 91 * 86_400_000;
    await repo.cleanup(ninetyOneDays);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM seen_questions').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inbound_events').get()).toEqual({ n: 0 });
  });
});
