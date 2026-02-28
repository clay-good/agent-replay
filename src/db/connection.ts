import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let instance: DatabaseConnection | null = null;

export class DatabaseConnection {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? resolve(process.cwd(), '.agent-replay', 'traces.db');
  }

  /** Open the database connection, creating the directory and file if needed. */
  open(): Database.Database {
    if (this.db) return this.db;

    // Ensure the parent directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    // Enable foreign key enforcement
    this.db.pragma('foreign_keys = ON');

    return this.db;
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Get the raw better-sqlite3 instance. Throws if not open. */
  getDb(): Database.Database {
    if (!this.db) {
      return this.open();
    }
    return this.db;
  }

  /** Check whether the schema has been initialized (agent_traces table exists). */
  isInitialized(): boolean {
    const db = this.getDb();
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_traces'"
      )
      .get() as { name: string } | undefined;
    return !!row;
  }

  /** Return the file path for this database. */
  getPath(): string {
    return this.dbPath;
  }
}

/** Get or create the shared DatabaseConnection singleton. */
export function getConnection(dbPath?: string): DatabaseConnection {
  if (!instance) {
    instance = new DatabaseConnection(dbPath);
  }
  return instance;
}

/** Reset the singleton (useful for tests). */
export function resetConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
