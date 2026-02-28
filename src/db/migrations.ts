import type Database from 'better-sqlite3';
import { SCHEMA_VERSION, getSchemaVersion, applySchemaV1 } from './schema.js';

/**
 * Run any pending migrations. Currently only v0 → v1 exists.
 * Returns the version after migration.
 */
export function runMigrations(db: Database.Database): number {
  const current = getSchemaVersion(db);

  if (current >= SCHEMA_VERSION) {
    return current;
  }

  // v0 → v1: initial schema
  if (current < 1) {
    applySchemaV1(db);
  }

  return SCHEMA_VERSION;
}
