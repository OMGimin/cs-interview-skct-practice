CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL CHECK (area IN ('CS', 'CT')),
  subject TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT,
  answer INTEGER CHECK (answer BETWEEN 1 AND 4),
  explanation TEXT NOT NULL,
  key_points_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'disabled')),
  CHECK ((area = 'CS' AND options_json IS NULL AND answer IS NULL) OR
         (area = 'CT' AND options_json IS NOT NULL AND answer IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS questions_eligible ON questions(area, status, id);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions(id),
  state TEXT NOT NULL CHECK (state IN ('pending_question', 'open', 'pending_result', 'closed')),
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

CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt
  ON attempts(team_id, user_id, channel_id)
  WHERE state != 'closed';
CREATE INDEX IF NOT EXISTS attempts_retention ON attempts(state, requested_ms);

CREATE TABLE IF NOT EXISTS seen_questions (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions(id),
  seen_ms INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id, question_id)
);
CREATE INDEX IF NOT EXISTS seen_retention ON seen_questions(seen_ms);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_id TEXT PRIMARY KEY,
  received_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_retention ON inbound_events(received_ms);
