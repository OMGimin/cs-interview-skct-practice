-- Rebuild because SQLite cannot change an existing CHECK constraint in place.
-- Copy every attempt before dropping the old table, including pending deliveries.
CREATE TABLE attempts_next (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions(id),
  state TEXT NOT NULL CHECK (state IN ('pending_question', 'open', 'pending_result', 'closed', 'cancelled')),
  requested_ms INTEGER NOT NULL,
  question_ts TEXT,
  started_ms INTEGER,
  ended_ms INTEGER,
  mode TEXT CHECK (mode IN ('answer', 'reveal')),
  choice INTEGER CHECK (choice BETWEEN 1 AND 4),
  claim_event_id TEXT,
  claimed_ms INTEGER,
  result_sent_ms INTEGER,
  CHECK (started_ms IS NULL OR question_ts IS NOT NULL),
  CHECK (state != 'closed' OR result_sent_ms IS NOT NULL)
);

INSERT INTO attempts_next
  (id, team_id, user_id, channel_id, question_id, state, requested_ms,
   question_ts, started_ms, ended_ms, mode, choice, claim_event_id,
   claimed_ms, result_sent_ms)
SELECT id, team_id, user_id, channel_id, question_id, state, requested_ms,
       question_ts, started_ms, ended_ms, mode, choice, claim_event_id,
       claimed_ms, result_sent_ms
FROM attempts;

DROP TABLE attempts;
ALTER TABLE attempts_next RENAME TO attempts;

CREATE UNIQUE INDEX one_active_attempt
  ON attempts(team_id, user_id, channel_id)
  WHERE state IN ('pending_question', 'open', 'pending_result');
CREATE INDEX attempts_retention ON attempts(state, requested_ms);
CREATE INDEX attempts_recent_terminal
  ON attempts(team_id, user_id, channel_id, state, ended_ms);
