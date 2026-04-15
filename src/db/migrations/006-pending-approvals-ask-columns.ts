import type { Migration } from './index.js';

/**
 * Backfill `title` and `options_json` on `pending_approvals` for installs that
 * ran migration 003 before those columns were added to its definition.
 * Fresh installs already have them via the updated 003; this ALTER is a no-op
 * there only because such installs never reach version 6 with the old shape.
 */
export const migration006: Migration = {
  version: 6,
  name: 'pending-approvals-ask-columns',
  up(db) {
    const cols = db.prepare(`PRAGMA table_info(pending_approvals)`).all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('title')) {
      db.exec(`ALTER TABLE pending_approvals ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
    }
    if (!have.has('options_json')) {
      db.exec(`ALTER TABLE pending_approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
    }
  },
};
