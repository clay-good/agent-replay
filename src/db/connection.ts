import Database from 'better-sqlite3';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * One live connection PER STORE PATH, not one per process.
 *
 * This used to be a single slot: opening a second path closed the first, which
 * is fine for the CLI (it opens exactly one store per invocation) but wrong for
 * the library, where `ensureDatabase` is a documented export. A caller that
 * opened two stores had its FIRST handle silently killed — every later query on
 * it threw "The database connection is not open", pointing at code that had
 * done nothing wrong. Keying by resolved path costs nothing in the CLI, where
 * the map only ever holds one entry.
 */
const instances = new Map<string, DatabaseConnection>();

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
      // Only a directory WE create is ours to set permissions on.
      //
      // The store holds config.json with API keys in plaintext, so a directory
      // this tool makes is made private. But the narrowing used to run on every
      // open, against whatever path `--dir`/AGENT_REPLAY_DIR named — so pointing
      // at an existing shared directory silently stripped group and other
      // access from it, and `--dir .` did that to the user's WORKING DIRECTORY.
      // Even read-only commands did it: `agent-replay list` changed permissions
      // on a directory it was only reading. A pre-existing directory belongs to
      // whoever made it; its mode is their decision, not ours.
      //
      // (`mkdirSync` mode is masked by the process umask, so the chmod below
      // sets it exactly rather than trusting the mode argument.)
      const created = !existsSync(dir);
      if (created) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dir, 0o700);
        } catch {
          // Non-POSIX filesystem — leave as-is rather than fail.
        }
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

    // Whether WE are the ones creating the store file. Checked before opening,
    // since `new Database()` creates it.
    const creatingStore = !existsSync(this.dbPath);

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

      // Make the store file itself owner-only, at creation.
      //
      // A trace holds prompts, tool inputs and tool outputs. Until now the only
      // thing protecting them was the 0700 on the directory — the database file
      // was created 0644 by the process umask — so the protection vanished
      // whenever the directory was not ours to tighten: `mkdir -p
      // /var/lib/agent-replay && agent-replay init --dir …`, a mounted volume,
      // any pre-created path. Setting the mode on the FILE protects the content
      // regardless of who made the directory, which is the property actually
      // wanted, and it lets the directory keep belonging to whoever made it.
      //
      // Only at creation: an operator who later opens the file up did so
      // deliberately, and a read command must never rewrite a mode.
      if (creatingStore) {
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            if (existsSync(this.dbPath + suffix)) chmodSync(this.dbPath + suffix, 0o600);
          } catch {
            // Non-POSIX filesystem — leave as-is rather than fail.
          }
        }
      }
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
              // Name the surprising part. The store runs in WAL mode, and WAL
              // keeps its index in a `-shm` sidecar that SQLite creates next to
              // the database — so the DIRECTORY must be writable even to READ.
              // An operator who deliberately locked a store down with `chmod
              // 500` got "check permissions" for `list`, which reads, and had
              // no way to guess that the directory was the problem rather than
              // the file. There is no read-only mode to offer instead: opening
              // read-only fails the same way, for the same reason.
              ? 'The store directory must be writable, even for read-only commands: ' +
                'the database runs in WAL mode, whose index sidecar is created next to it. ' +
                'Check the permissions on the directory, not just the file.'
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

/** Get or create the shared DatabaseConnection for a store path. */
export function getConnection(dbPath?: string): DatabaseConnection {
  // Key on the same default the constructor applies, so `getConnection()` and
  // `getConnection(<that path>)` are the same connection rather than two.
  const key = resolve(dbPath ?? resolve(process.cwd(), '.agent-replay', 'traces.db'));
  const existing = instances.get(key);
  if (existing) return existing;
  const conn = new DatabaseConnection(key);
  instances.set(key, conn);
  return conn;
}

/** Close every connection and forget them (useful for tests). */
export function resetConnection(): void {
  for (const conn of instances.values()) conn.close();
  instances.clear();
}
