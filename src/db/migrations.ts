import type Database from 'better-sqlite3';
import { SCHEMA_VERSION, getSchemaVersion, applySchemaV1, applySchemaV2, applySchemaV3, applySchemaV4, applySchemaV5, applySchemaV6 } from './schema.js';

/**
 * Run any pending migrations, upgrading the database to the latest schema.
 * Each step is wrapped in its own transaction so a fresh open and a v1→v2
 * upgrade are both atomic. Returns the version after migration.
 */
export function runMigrations(db: Database.Database): number {
  const found = getSchemaVersion(db);

  // A store written by a NEWER build is refused rather than used. Upgrades are
  // one-way with no down-migration, so an older binary opening a newer store was
  // reading columns it does not know about and writing rows that do not satisfy
  // the newer shape — silently, at exit 0, with the version left untouched.
  // Downgrading (an old binary on a PATH, a pinned CI image) is exactly when
  // that happens, and it is the case that most needs to stop rather than
  // half-work.
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `This store's schema is v${found}, newer than this build supports (v${SCHEMA_VERSION}). ` +
        'Upgrade agent-replay to open it — schema upgrades are one-way, so an older build cannot safely read or write it.',
    );
  }

  // Fast path: already current — avoid taking a write lock on every open.
  if (found >= SCHEMA_VERSION) {
    return SCHEMA_VERSION;
  }

  // Serialize migration across processes. Take the write lock up front
  // (BEGIN IMMEDIATE) and re-read the version *inside* the transaction, so a
  // process that lost a concurrent-upgrade race sees the already-applied
  // version and skips the DDL instead of re-running it. Reading the version
  // outside any transaction (as before) was a TOCTOU: two processes could both
  // read v1 and both attempt the v2 `ALTER TABLE ADD COLUMN`, and the loser
  // crashed with `duplicate column name` (not SQLITE_BUSY, so busy_timeout
  // didn't help). The steps within are also idempotent as a backstop.
  db.transaction(() => {
    const current = getSchemaVersion(db);

    // v0 → v1: initial schema
    if (current < 1) applySchemaV1(db);

    // v1 → v2: decision-trace model (hierarchy, causality, sessions, decisions)
    if (current < 2) applySchemaV2(db);

    // v2 → v3: indexes for the OTel merge lookup and the dashboard's recent
    // evals — both were full table scans. Additive only.
    if (current < 3) applySchemaV3(db);

    // v3 → v4: an expression index for the parsed-instant ordering `list` and
    // the dashboard use, which the plain started_at index cannot serve.
    if (current < 4) applySchemaV4(db);

    // v4 → v5: the same expression index over the instant expression that also
    // parses ISO basic-format offsets, so the parsed-instant ordering is correct
    // for those rows AND still served by an index. Additive only.
    if (current < 5) applySchemaV5(db);

    // v5 → v6: the two indexes the cross-batch OTLP merge looks up on every
    // batch (span id, and unparented steps). Additive only.
    if (current < 6) applySchemaV6(db);
  }).immediate();

  return SCHEMA_VERSION;
}
