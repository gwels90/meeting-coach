// ---------------------------------------------------------------------------
// JSON file database — user profiles for multi-tenant meeting coach
// No native dependencies — works on any platform (Railway, Heroku, etc.)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_FILE = path.join(__dirname, '.users.json');

function loadDb() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { users: [], nextId: 1 };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function createUser({ name, email, role, custom_context = '' }) {
  const db = loadDb();
  const webhook_id = uuidv4();
  const user = {
    id: db.nextId++,
    name,
    email,
    role,
    webhook_id,
    custom_context,
    active: 1,
    created_at: new Date().toISOString(),
    meetings_processed: 0,
  };
  db.users.push(user);
  saveDb(db);
  return { id: user.id, webhook_id };
}

function findByWebhookId(webhookId) {
  const db = loadDb();
  return db.users.find(u => u.webhook_id === webhookId && u.active === 1) || null;
}

function listUsers() {
  const db = loadDb();
  return [...db.users].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function incrementMeetingCount(userId) {
  const db = loadDb();
  const user = db.users.find(u => u.id === userId);
  if (user) {
    user.meetings_processed++;
    saveDb(db);
  }
}

function toggleActive(userId) {
  const db = loadDb();
  const user = db.users.find(u => u.id === userId);
  if (user) {
    user.active = user.active === 1 ? 0 : 1;
    saveDb(db);
    return user;
  }
  return null;
}

module.exports = {
  createUser,
  findByWebhookId,
  listUsers,
  incrementMeetingCount,
  toggleActive,
};
