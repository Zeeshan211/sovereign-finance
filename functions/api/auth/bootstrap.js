// One-shot bootstrap: creates auth tables (idempotent, safe to call multiple times).
// POST /api/auth/bootstrap   body: { "secret": "liquidityos-setup" }
// Remove this file once tables are confirmed created.

const SECRET = 'liquidityos-setup';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    if (body.secret !== SECRET) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }

    const stmts = [
      // Migration 01 — households + users + account_permissions
      `CREATE TABLE IF NOT EXISTS households (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        owner_user_id TEXT NOT NULL,
        settings      TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        household_id  TEXT NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        full_name     TEXT NOT NULL,
        display_name  TEXT,
        role          TEXT NOT NULL DEFAULT 'owner'
          CHECK(role IN ('owner','admin','member','view_only')),
        status        TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','invited','suspended','deleted')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        preferences   TEXT,
        FOREIGN KEY (household_id) REFERENCES households(id)
      )`,
      `CREATE TABLE IF NOT EXISTS account_permissions (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        can_read            INTEGER NOT NULL DEFAULT 1,
        can_write           INTEGER NOT NULL DEFAULT 1,
        can_admin           INTEGER NOT NULL DEFAULT 0,
        granted_at          TEXT NOT NULL DEFAULT (datetime('now')),
        granted_by_user_id  TEXT,
        UNIQUE(account_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_account_perms_user ON account_permissions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_account_perms_account ON account_permissions(account_id)`,
      // Seed — idempotent
      `INSERT INTO households (id, name, owner_user_id)
       VALUES ('hh_owner', 'My Household', 'user_owner')
       ON CONFLICT DO NOTHING`,
      `INSERT INTO users (id, household_id, email, full_name, role, status)
       VALUES ('user_owner', 'hh_owner', 'owner@local', 'Owner', 'owner', 'active')
       ON CONFLICT DO NOTHING`,

      // Migration 02 — sessions + login_attempts + password_reset + 2fa
      `CREATE TABLE IF NOT EXISTS sessions (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL,
        token_hash         TEXT NOT NULL,
        refresh_token_hash TEXT,
        device_label       TEXT,
        ip_address         TEXT,
        user_agent         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at     TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at         TEXT NOT NULL,
        revoked_at         TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        email          TEXT,
        ip_address     TEXT,
        success        INTEGER NOT NULL DEFAULT 0,
        attempted_at   TEXT NOT NULL DEFAULT (datetime('now')),
        user_agent     TEXT,
        failure_reason TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        used_at    TEXT,
        ip_address TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE TABLE IF NOT EXISTS user_2fa (
        user_id                TEXT PRIMARY KEY,
        totp_secret_encrypted  TEXT,
        backup_codes_encrypted TEXT,
        enabled_at             TEXT,
        last_used_at           TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, attempted_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_address, attempted_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token_hash)`,

      // Migration 13 — auth_rate_limits
      `CREATE TABLE IF NOT EXISTS auth_rate_limits (
        ip_address    TEXT NOT NULL,
        window_start  TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ip_address, window_start)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_ip_window ON auth_rate_limits(ip_address, window_start DESC)`,
    ];

    await context.env.DB.batch(stmts.map(s => context.env.DB.prepare(s)));

    // Verify
    const tables = await context.env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name IN ('households','users','sessions','login_attempts','auth_rate_limits')
       ORDER BY name`
    ).all();

    return Response.json({
      ok: true,
      message: 'Auth tables ready — you can now POST /api/auth/register',
      tables_confirmed: tables.results.map(r => r.name),
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message || String(e) }, { status: 500 });
  }
}
