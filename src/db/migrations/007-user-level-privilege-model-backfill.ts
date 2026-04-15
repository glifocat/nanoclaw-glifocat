import type { Migration } from './index.js';

/**
 * Backfill the user-level privilege model for installs that ran migration 001
 * before those tables/columns were added to its definition.
 *
 * The user-level privilege model (users, user_roles, agent_group_members,
 * user_dms) and the `messaging_groups.unknown_sender_policy` column were
 * added in the 0d3326a commit by retroactively editing migration 001 rather
 * than introducing a new migration. Likewise, `pending_questions.title` and
 * `pending_questions.options_json` were retroactively added to migration 001
 * in the d92d75e commit. Fresh installs pick these up from the updated 001;
 * installs that had already advanced past version 1 were left with the old
 * shape and will crash when code in src/db/users.ts, src/db/user-roles.ts,
 * src/db/agent-group-members.ts, src/db/user-dms.ts, or
 * src/db/messaging-groups.ts runs against them (no such table / no such
 * column).
 *
 * Every step here is idempotent (`PRAGMA table_info` + conditional ALTER,
 * `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) so the
 * migration is a no-op on fresh installs that already got everything from
 * 001 and only backfills where something is genuinely missing.
 *
 * Note on `messaging_groups.unknown_sender_policy` default: migration 001
 * declares the column `NOT NULL DEFAULT 'strict'`. Backfilling existing rows
 * with `'strict'` would silently lock users out of their own chats, because
 * a freshly-backfilled schema has no rows in `users`/`user_roles` yet, so
 * `canAccessAgentGroup` rejects every inbound as unknown-sender. We use
 * `'public'` here to preserve the permissive behavior pre-`0d3326a` installs
 * were running under; operators can tighten the policy per-row manually once
 * they have set themselves up as owners via the user-level privilege model.
 *
 * The retroactive removals (`agent_groups.is_admin`,
 * `messaging_groups.admin_user_id`) are not reversed — there are no readers
 * of those columns in current code, and SQLite does not support `DROP COLUMN`
 * without a table rewrite, so they are left as harmless dead columns.
 */
export const migration007: Migration = {
  version: 7,
  name: 'user-level-privilege-model-backfill',
  up(db) {
    // 1. pending_questions: retroactively added `title` + `options_json` in d92d75e.
    const pqCols = db.prepare(`PRAGMA table_info(pending_questions)`).all() as { name: string }[];
    const pqHave = new Set(pqCols.map((c) => c.name));
    if (!pqHave.has('title')) {
      db.exec(`ALTER TABLE pending_questions ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
    }
    if (!pqHave.has('options_json')) {
      db.exec(`ALTER TABLE pending_questions ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
    }

    // 2. messaging_groups: retroactively added `unknown_sender_policy` in 0d3326a.
    //    See header comment on why the backfill default is 'public', not 'strict'.
    const mgCols = db.prepare(`PRAGMA table_info(messaging_groups)`).all() as { name: string }[];
    const mgHave = new Set(mgCols.map((c) => c.name));
    if (!mgHave.has('unknown_sender_policy')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN unknown_sender_policy TEXT NOT NULL DEFAULT 'public'`);
    }

    // 3. New user-level privilege tables (all retroactively added in 0d3326a).
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        display_name TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        user_id        TEXT NOT NULL REFERENCES users(id),
        role           TEXT NOT NULL,
        agent_group_id TEXT REFERENCES agent_groups(id),
        granted_by     TEXT REFERENCES users(id),
        granted_at     TEXT NOT NULL,
        PRIMARY KEY (user_id, role, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);

      CREATE TABLE IF NOT EXISTS agent_group_members (
        user_id        TEXT NOT NULL REFERENCES users(id),
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        added_by       TEXT REFERENCES users(id),
        added_at       TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_group_id)
      );

      CREATE TABLE IF NOT EXISTS user_dms (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type)
      );
    `);
  },
};
