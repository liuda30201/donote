'use strict';

/** D01 creates only schema_migrations; this is the first versioned application migration. */
const SECURITY_MIGRATION = {
  version: 1,
  name: 'account-security-foundation',
  sql: `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      security_version INTEGER NOT NULL DEFAULT 1 CHECK (security_version > 0),
      login_policy TEXT NOT NULL DEFAULT 'standard' CHECK (login_policy IN ('standard', 'strict')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER,
      deleted_at INTEGER,
      storage_quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_quota_bytes >= 0),
      storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
      UNIQUE (username)
    ) STRICT;
    CREATE INDEX users_active_username ON users(username) WHERE deleted_at IS NULL;
    CREATE TRIGGER users_id_immutable BEFORE UPDATE OF id ON users
      WHEN NEW.id <> OLD.id BEGIN SELECT RAISE(ABORT, 'immutable user ID'); END;

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_hash TEXT NOT NULL,
      device_label TEXT,
      ip_address TEXT,
      is_ephemeral INTEGER NOT NULL DEFAULT 0 CHECK (is_ephemeral IN (0, 1)),
      auth_strength TEXT NOT NULL CHECK (auth_strength IN ('password', 'totp', 'webauthn')),
      security_version INTEGER NOT NULL CHECK (security_version > 0),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      idle_expires_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      CHECK (idle_expires_at >= created_at AND expires_at >= created_at)
    ) STRICT;
    CREATE INDEX sessions_user_active ON sessions(user_id, revoked_at, expires_at);
    CREATE INDEX sessions_token ON sessions(token_hash);

    CREATE TABLE login_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      challenge_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('login', 'reauth', 'enroll')),
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      action TEXT,
      target_id TEXT,
      security_version INTEGER NOT NULL CHECK (security_version > 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      CHECK (expires_at >= created_at)
    ) STRICT;
    CREATE INDEX login_challenges_active ON login_challenges(challenge_hash, expires_at, consumed_at);

    CREATE TABLE operation_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      grant_hash TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      target_id TEXT,
      security_version INTEGER NOT NULL CHECK (security_version > 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      CHECK (expires_at >= created_at)
    ) STRICT;
    CREATE INDEX operation_grants_lookup ON operation_grants(grant_hash, expires_at, consumed_at);

    CREATE TABLE recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      revoked_at INTEGER
    ) STRICT;
    CREATE INDEX recovery_codes_user ON recovery_codes(user_id, consumed_at, revoked_at);

    CREATE TABLE totp_credentials (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_secret TEXT NOT NULL,
      last_counter INTEGER NOT NULL DEFAULT -1,
      enabled_at INTEGER
    ) STRICT;

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      target_id TEXT,
      actor_session_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      ip_address TEXT,
      auth_strength TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX audit_created ON audit_log(created_at);
    CREATE INDEX audit_actor ON audit_log(actor_id, created_at);
  `
};

const EMAIL_MIGRATION = {
  version: 2,
  name: 'user-verification-preferences-and-email',
  sql: `
    CREATE TABLE verification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL CHECK (method IN ('password','email','totp')),
      email TEXT,
      email_verified_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE email_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('login','bind','reauth')),
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      security_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    ) STRICT;
    CREATE INDEX email_challenges_user ON email_challenges(user_id,purpose,created_at);
    CREATE TABLE email_session_proofs (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      security_version INTEGER NOT NULL,
      verified_at INTEGER NOT NULL
    ) STRICT;
  `
};
const REGISTRATION_MIGRATION = {
  version: 3,
  name: 'public-email-registration-challenges',
  sql: `
    CREATE TABLE registration_challenges (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      source_hash TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
      consumed_at INTEGER
    ) STRICT;
    CREATE INDEX registration_challenges_active ON registration_challenges(token_hash, expires_at, consumed_at);
    CREATE INDEX registration_challenges_email ON registration_challenges(email, created_at);
    CREATE INDEX registration_challenges_source ON registration_challenges(source_hash, created_at);
  `
};
// Rebuild the parent table with foreign keys temporarily disabled by the migrator.
const EMAIL_LOGIN_MIGRATION = {
  version: 4,
  name: 'unique-email-login-and-repeatable-display-usernames',
  rebuildForeignKeys: true,
  sql: `
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
      security_version INTEGER NOT NULL DEFAULT 1 CHECK (security_version > 0),
      login_policy TEXT NOT NULL DEFAULT 'standard' CHECK (login_policy IN ('standard', 'strict')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      disabled_at INTEGER,
      deleted_at INTEGER,
      storage_quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_quota_bytes >= 0),
      storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0)
    ) STRICT;
    INSERT INTO users_new (id,username,display_name,password_hash,role,must_change_password,security_version,login_policy,created_at,updated_at,disabled_at,deleted_at,storage_quota_bytes,storage_bytes)
      SELECT id,username,display_name,password_hash,role,must_change_password,security_version,login_policy,created_at,updated_at,disabled_at,deleted_at,storage_quota_bytes,storage_bytes FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    CREATE INDEX users_active_username ON users(username) WHERE deleted_at IS NULL;
    CREATE TRIGGER users_id_immutable BEFORE UPDATE OF id ON users
      WHEN NEW.id <> OLD.id BEGIN SELECT RAISE(ABORT, 'immutable user ID'); END;
    CREATE TABLE legacy_login_names (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO legacy_login_names SELECT username,id FROM users;
    CREATE UNIQUE INDEX verification_email_unique ON verification_preferences(email COLLATE NOCASE) WHERE email IS NOT NULL;
    UPDATE registration_challenges SET blocked=1 WHERE consumed_at IS NULL;
  `
};
const ACCOUNT_MIGRATIONS = [SECURITY_MIGRATION, EMAIL_MIGRATION, REGISTRATION_MIGRATION, EMAIL_LOGIN_MIGRATION];
module.exports = { SECURITY_MIGRATION, EMAIL_MIGRATION, REGISTRATION_MIGRATION, EMAIL_LOGIN_MIGRATION, ACCOUNT_MIGRATIONS };
