const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { normalizeState } = require('./state')

class RuntimeDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS states (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        user_text TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        state_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_plans_user_created ON plans(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_key TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);
    `)
  }

  close() {
    this.db.close()
  }

  getUser(userId) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  }

  createUser(userId, secretHash, initialState) {
    const now = Date.now()
    const state = normalizeState(initialState)
    this.transaction(() => {
      this.db.prepare('INSERT INTO users (id, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(userId, secretHash, now, now)
      this.db.prepare('INSERT INTO states (user_id, revision, state_json, updated_at) VALUES (?, 1, ?, ?)')
        .run(userId, JSON.stringify(state), now)
    })
    return this.getState(userId)
  }

  touchUser(userId) {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), userId)
  }

  getState(userId) {
    const row = this.db.prepare('SELECT revision, state_json, updated_at FROM states WHERE user_id = ?').get(userId)
    if (!row) return null
    return { revision: row.revision, updatedAt: row.updated_at, state: normalizeState(JSON.parse(row.state_json)) }
  }

  saveState(userId, state, expectedRevision = null) {
    const normalized = normalizeState(state)
    const now = Date.now()
    const statement = expectedRevision == null
      ? this.db.prepare('UPDATE states SET revision = revision + 1, state_json = ?, updated_at = ? WHERE user_id = ?')
      : this.db.prepare('UPDATE states SET revision = revision + 1, state_json = ?, updated_at = ? WHERE user_id = ? AND revision = ?')
    const result = expectedRevision == null
      ? statement.run(JSON.stringify(normalized), now, userId)
      : statement.run(JSON.stringify(normalized), now, userId, expectedRevision)
    if (result.changes !== 1) {
      const error = new Error('状态已在其他请求中更新，请刷新后重试')
      error.statusCode = 409
      throw error
    }
    return this.getState(userId)
  }

  createPlan(plan) {
    this.db.prepare(`
      INSERT INTO plans (id, user_id, status, user_text, draft_json, state_revision, created_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
    `).run(plan.id, plan.userId, plan.userText, JSON.stringify(plan.draft), plan.stateRevision, Date.now())
  }

  getPlan(userId, planId) {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ? AND user_id = ?').get(planId, userId)
    return row ? { ...row, draft: JSON.parse(row.draft_json) } : null
  }

  confirmPlan(planId) {
    this.db.prepare("UPDATE plans SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), planId)
  }

  discardPlan(userId, planId) {
    this.db.prepare("UPDATE plans SET status = 'discarded' WHERE id = ? AND user_id = ? AND status = 'pending'")
      .run(planId, userId)
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listStates() {
    return this.db.prepare('SELECT user_id FROM states').all()
  }

  insertEvent(userId, eventKey, type, payload) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO events (user_id, event_key, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, eventKey, type, JSON.stringify(payload), Date.now()).changes === 1
  }

  listEvents(userId, afterId = 0) {
    return this.db.prepare(`
      SELECT id, type, payload_json, created_at FROM events
      WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT 50
    `).all(userId, afterId).map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at
    }))
  }
}

module.exports = { RuntimeDatabase }
