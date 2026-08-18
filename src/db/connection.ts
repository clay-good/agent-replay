import Database from 'better-sqlite3';
import { mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
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
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // NARROW ONLY. This was an unconditional `chmod 0700`, described as a
      // floor but acting as a set — so opening a store an operator had
      // deliberately locked down (`chmod 500`) quietly restored owner write on
      // it. Only tighten permissions that are broader than 0700; never loosen
      // what someone chose.
      try {
        const mode = statSync(dir).mode & 0o777;
        if ((mode & 0o077) !== 0) chmodSync(dir, mode & 0o700);
      } catch {
        // Non-POSIX filesystem — leave as-is rather than fail.
      }
    } catch (err) {
      // Raised BEFORE the try below, so a working directory the user cannot
      // write produced a raw `EACCES: permission denied, mkdir '.agent-replay'`
      // — bypassing the actionable message every other open failure gets, and
      // emitting non-JSON text for a `--json` caller. Route it through the same
      // builder.
      throw new Error(
        `Could not open the database at ${this.dbPath}. ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.db = new Database(this.dbPath);
      // Set the lock patience FIRST. Converting a rollback-journal database to
      // WAL needs a brief exclusive lock, and with no busy_timeout in effect a
      // concurrent holder makes that conversion fail immediately with
      // SQLITE_BUSY. (Ordering only matters for the one-time conversion; a
      // database already in WAL returns "wal" without taking the lock.)
      //
      // 10s, not the 3s this used to set: better-sqlite3 already defaults to
      // 5000ms, so the old value was a 40% *reduction* in lock patience,
      // written and commented as though it were an increase. Short-lived hook
      // processes contending with a slow `otel serve` merge transaction were
      // being aborted earlier than the library default would have — and a
      // SQLITE_BUSY on the hook path is swallowed as a per-event warning, i.e.
      // silently lost trace data. Never set this below the library default.
      this.db.pragma('busy_timeout = 10000');
      // Enable WAL mode for better concurrent read performance — one writer plus
      // concurrent readers, which covers live capture (record/hook writers) and
      // watch/dashboard readers against the same file. (This pragma is also the
      // first real read of the file, so a corrupt DB surfaces here.)
      this.db.pragma('journal_mode = WAL');
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
      // Don't tell every failure it's corruption. This catch covers a locked
      // store, a read-only file or mount, and a permissions problem as well as
      // a genuinely bad file — and "may be corrupted" invites the user to
      // delete a trace store that was merely busy. Name the cause we actually
      // have, and only say corrupt when SQLite says so.
      const code = (err as { code?: string }).code ?? '';
      const detail = (err as Error).message;
      const cause =
        code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')
          ? 'It is corrupted or not a valid SQLite file.'
          : code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
            ? 'It is locked by another process — retry once that process exits.'
            : code.startsWith('SQLITE_READONLY') || code.startsWith('SQLITE_PERM') || code === 'SQLITE_CANTOPEN'
              ? 'It could not be opened for writing — check file and directory permissions.'
              : 'It may be corrupted, locked, or unreadable.';
      throw new Error(`Could not open the database at ${this.dbPath}. ${cause} (${detail})`);
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
