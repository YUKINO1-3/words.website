CREATE TABLE users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 credential_version INTEGER NOT NULL DEFAULT 0,
 ai_key TEXT NOT NULL DEFAULT '', ai_url TEXT NOT NULL DEFAULT '', ai_model TEXT NOT NULL DEFAULT ''
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, credential_version INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
CREATE INDEX attempts_expiry ON auth_attempts(until_at);
CREATE TABLE spaces (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version INTEGER NOT NULL DEFAULT 0, epoch TEXT NOT NULL, settings TEXT NOT NULL
);
-- Every read/modify/write batch begins with this guard. D1 rolls back the whole
-- batch if another invocation changed the workspace after the initial read.
CREATE TABLE write_guards (user_id INTEGER PRIMARY KEY REFERENCES spaces(user_id) ON DELETE CASCADE, expected_version INTEGER NOT NULL);
CREATE TRIGGER guard_workspace BEFORE INSERT ON write_guards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE user_id=NEW.user_id AND version=NEW.expected_version)
 THEN RAISE(ABORT, 'workspace_conflict') END;
 UPDATE spaces SET version=version+1 WHERE user_id=NEW.user_id;
END;
CREATE TABLE vocabularies (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, UNIQUE(user_id,name), UNIQUE(user_id,id));
CREATE TABLE words (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 word TEXT NOT NULL COLLATE NOCASE, zh TEXT NOT NULL DEFAULT '', en TEXT NOT NULL DEFAULT '',
 phonetic TEXT NOT NULL DEFAULT '', pos TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '',
 translation TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 usage TEXT NOT NULL DEFAULT '', ai_fields TEXT NOT NULL DEFAULT '[]',
 UNIQUE(user_id,word), UNIQUE(user_id,id)
);
CREATE TABLE vocabulary_words (
 user_id INTEGER NOT NULL, vocabulary_id INTEGER NOT NULL, word_id INTEGER NOT NULL,
 PRIMARY KEY(user_id,vocabulary_id,word_id),
 FOREIGN KEY(user_id,vocabulary_id) REFERENCES vocabularies(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,word_id) REFERENCES words(user_id,id) ON DELETE CASCADE
);
CREATE TABLE cards (
 user_id INTEGER NOT NULL, word_id INTEGER NOT NULL,
 json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, due TEXT NOT NULL,
 reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,word_id), FOREIGN KEY(user_id,word_id) REFERENCES words(user_id,id) ON DELETE CASCADE
);
CREATE INDEX cards_due ON cards(user_id,due);
CREATE TABLE daily_plans (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, new_goal INTEGER NOT NULL, review_goal INTEGER NOT NULL, new_done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,day));
CREATE TABLE review_logs (
 user_id INTEGER NOT NULL, event_id TEXT NOT NULL, word_id INTEGER NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
 rating INTEGER NOT NULL, is_new INTEGER NOT NULL, seconds INTEGER NOT NULL, mode TEXT NOT NULL,
 log TEXT NOT NULL, result TEXT NOT NULL, answer_correct INTEGER CHECK(answer_correct IN (0,1) OR answer_correct IS NULL),
 PRIMARY KEY(user_id,event_id), FOREIGN KEY(user_id,word_id) REFERENCES words(user_id,id) ON DELETE CASCADE
);
CREATE INDEX reviews_day ON review_logs(user_id,day);
CREATE INDEX reviews_word ON review_logs(user_id,word_id);
-- Preserves time totals when a word and its review logs are deleted.
CREATE TABLE study_sessions (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY(user_id,id));
CREATE TABLE import_logs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL, filename TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX imports_user ON import_logs(user_id,id);
CREATE TABLE ai_generation_cache (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(user_id,key));
CREATE TABLE ai_usage (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,day));
