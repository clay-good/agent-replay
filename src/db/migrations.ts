import type Database from 'better-sqlite3';
import { SCHEMA_VERSION, getSchemaVersion, applySchemaV1, applySchemaV2 } from './schema.js';

/**
 * Run any pending migrations, upgrading the database to the latest schema.
 * Each step is wrapped in its own transaction so a fresh open and a v1→v2
 * upgrade are both atomic. Returns the version after migration.
 */
export function runMigrations(db: Database.Database): number {
  const current = getSchemaVersion(db);

  if (current >= SCHEMA_VERSION) {
    return current;
  }

  // v0 → v1: initial schema
  if (current < 1) {
    db.transaction(() => applySchemaV1(db))();
  }

  // v1 → v2: decision-trace model (hierarchy, causality, sessions, decisions)
  if (current < 2) {
    db.transaction(() => applySchemaV2(db))();
  }

  return SCHEMA_VERSION;
}
