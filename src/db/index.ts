import type Database from 'better-sqlite3';
import { getConnection, resetConnection, DatabaseConnection } from './connection.js';
import { runMigrations } from './migrations.js';

export { DatabaseConnection, getConnection, resetConnection } from './connection.js';
export { SCHEMA_VERSION, getSchemaVersion } from './schema.js';
export { runMigrations } from './migrations.js';

/**
 * Open the database at the given path (or default), run any pending
 * migrations, and return the raw better-sqlite3 instance ready for use.
 */
export function ensureDatabase(dbPath?: string): Database.Database {
  const conn = getConnection(dbPath);
  const db = conn.open();
  runMigrations(db);
  return db;
}
