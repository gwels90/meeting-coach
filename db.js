// ---------------------------------------------------------------------------
// SQLite database — user profiles for multi-tenant meeting coach
// ---------------------------------------------------------------------------
const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'meeting-coach.db');
const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('sales_rep', 'sales_manager', 'executive', 'marketing')),
    webhook_id TEXT UNIQUE NOT NULL,
    custom_context TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    meetings_processed INTEGER DEFAULT 0
  )
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const stmts = {
  insert: db.prepare(`
    INSERT INTO users (name, email, role, webhook_id, custom_context)
    VALUES (@name, @email, @role, @webhook_id, @custom_context)
  `),
  getByWebhookId: db.prepare(
    'SELECT * FROM users WHERE webhook_id = ? AND active = 1'
  ),
  getById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getAll: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
  incrementMeetings: db.prepare(
    'UPDATE users SET meetings_processed = meetings_processed + 1 WHERE id = ?'
  ),
  toggleActive: db.prepare(
    'UPDATE users SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?'
  ),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function createUser({ name, email, role, custom_context = '' }) {
  const webhook_id = uuidv4();
  const result = stmts.insert.run({ name, email, role, webhook_id, custom_context });
  return { id: result.lastInsertRowid, webhook_id };
}

function findByWebhookId(webhookId) {
  return stmts.getByWebhookId.get(webhookId);
}

function listUsers() {
  return stmts.getAll.all();
}

function incrementMeetingCount(userId) {
  stmts.incrementMeetings.run(userId);
}

function toggleActive(userId) {
  stmts.toggleActive.run(userId);
  return stmts.getById.get(userId);
}

module.exports = {
  createUser,
  findByWebhookId,
  listUsers,
  incrementMeetingCount,
  toggleActive,
};
