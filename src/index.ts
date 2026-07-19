export * from './models/index.js';
export {
  ensureDatabase,
  getConnection,
  resetConnection,
  DatabaseConnection,
  // Schema setup — exported so SDK users can initialize the schema on a custom
  // better-sqlite3 handle (e.g. an in-memory DB) before using TraceRecorder.
  runMigrations,
  SCHEMA_VERSION,
  getSchemaVersion,
} from './db/index.js';
export * from './utils/index.js';
export * from './services/index.js';
