import Database from 'better-sqlite3';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
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

    // Ensure the parent directory exists and is owner-only: the trace store can
    // contain sensitive agent data (prompts, tool inputs/outputs) and the config
    // holds API keys, so on a shared machine other users must not read them.
    // Restricting the directory covers the DB, its WAL/SHM sidecars, and config
    // in one place. Best-effort; a no-op on Windows.
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Non-POSIX filesystem — leave as-is rather than fail.
    }

    try {
      this.db = new Database(this.dbPath);
      // Enable WAL mode for better concurrent read performance — one writer plus
      // concurrent readers, which covers live capture (record/hook writers) and
      // watch/dashboard readers against the same file. (This pragma is also the
      // first real read of the file, so a corrupt DB surfaces here.)
      this.db.pragma('journal_mode = WAL');
      // Wait up to 3s for a competing writer's lock instead of failing fast with
      // SQLITE_BUSY, so short-lived hook processes and readers can coexist.
      this.db.pragma('busy_timeout = 3000');
      // Enable foreign key enforcement
      this.db.pragma('foreign_keys = ON');
    } catch (err) {
      // A corrupt or non-SQLite file at the path throws a raw SqliteError; turn
      // it into a clear, actionable message instead of a stack trace.
      try {
        this.db?.close();
      } catch {
        // ignore — we're already failing
      }
      this.db = null;
      throw new Error(
        `Could not open the database at ${this.dbPath}. It may be corrupted or not a valid SQLite file. ` +
          `(${(err as Error).message})`,
      );
    }

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
  if (instance) {
    // If a specific dbPath was requested, verify it matches the existing instance
    if (dbPath != null) {
      const resolvedPath = resolve(dbPath);
      const existingPath = resolve(instance.getPath());
      if (resolvedPath !== existingPath) {
        // Path mismatch — close old connection and create a new one
        instance.close();
        instance = new DatabaseConnection(dbPath);
      }
    }
    return instance;
  }
  instance = new DatabaseConnection(dbPath);
  return instance;
}

/** Reset the singleton (useful for tests). */
export function resetConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
