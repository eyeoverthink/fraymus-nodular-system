import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value);

export class WorkflowStore {
  constructor({ databasePath = process.env.SQLITE_PATH || 'data/workflows.db' } = {}) {
    const supabaseSettings = [
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ];
    const hasSupabaseSettings = supabaseSettings.some(Boolean);
    if (hasSupabaseSettings && !supabaseSettings.every(Boolean)) {
      throw new Error('Configure SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY together');
    }
    this.remote = hasSupabaseSettings;

    if (this.remote) {
      this.url = process.env.SUPABASE_URL.replace(/\/$/, '');
      this.key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      return;
    }

    const path = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        stripe_customer_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        deployed INTEGER NOT NULL DEFAULT 0,
        api_key_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflows_user_id_idx ON workflows(user_id);
      CREATE INDEX IF NOT EXISTS runs_workflow_id_idx ON runs(workflow_id);
    `);
    try {
      this.db.exec('ALTER TABLE users ADD COLUMN stripe_customer_id TEXT');
    } catch (error) {
      if (!String(error.message).includes('duplicate column')) throw error;
    }
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: 'Bearer ' + this.key,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: json(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase request failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async ensureUser(user) {
    if (this.remote) {
      await this.request('profiles?on_conflict=id', {
        method: 'POST',
        body: { id: user.id, email: user.email || null },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } else {
      this.db.prepare(`
        INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email
      `).run(user.id, user.email || null, now());
    }
  }

  async getStripeCustomerId(userId) {
    if (this.remote) {
      const rows = await this.request(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id&limit=1`
      );
      return rows[0]?.stripe_customer_id || null;
    }
    return this.db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(userId)?.stripe_customer_id || null;
  }

  async setStripeCustomerId(userId, customerId) {
    if (this.remote) {
      await this.request(
        `profiles?id=eq.${encodeURIComponent(userId)}`,
        { method: 'PATCH', body: { stripe_customer_id: customerId }, prefer: 'return=minimal' }
      );
      return;
    }
    this.db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, userId);
  }

  async createWorkflow({ userId, name, nodes, edges }) {
    const timestamp = now();
    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      name: name || 'Untitled workflow',
      nodes,
      edges,
      deployed: false,
      api_key_hash: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    if (this.remote) {
      const [created] = await this.request('workflows', {
        method: 'POST',
        body: row,
        prefer: 'return=representation',
      });
      return this.normalizeWorkflow(created);
    }
    this.db.prepare(`
      INSERT INTO workflows (id, user_id, name, nodes, edges, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, userId, row.name, json(nodes), json(edges), timestamp, timestamp);
    return row;
  }

  async listWorkflows(userId) {
    if (this.remote) {
      const rows = await this.request(
        `workflows?user_id=eq.${encodeURIComponent(userId)}&select=*&order=updated_at.desc&limit=100`
      );
      return rows.map((row) => this.normalizeWorkflow(row));
    }
    return this.db.prepare(`
      SELECT * FROM workflows WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
    `).all(userId).map((row) => this.normalizeWorkflow(row));
  }

  async getWorkflow(id, userId) {
    if (this.remote) {
      const rows = await this.request(
        `workflows?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`
      );
      return rows[0] ? this.normalizeWorkflow(rows[0]) : null;
    }
    const row = this.db.prepare(
      'SELECT * FROM workflows WHERE id = ? AND user_id = ?'
    ).get(id, userId);
    return row ? this.normalizeWorkflow(row) : null;
  }

  async getDeployedWorkflow(id, keyHash) {
    if (this.remote) {
      const rows = await this.request(
        `workflows?id=eq.${encodeURIComponent(id)}&api_key_hash=eq.${encodeURIComponent(keyHash)}&deployed=eq.true&select=*&limit=1`
      );
      return rows[0] ? this.normalizeWorkflow(rows[0]) : null;
    }
    const row = this.db.prepare(
      'SELECT * FROM workflows WHERE id = ? AND api_key_hash = ? AND deployed = 1'
    ).get(id, keyHash);
    return row ? this.normalizeWorkflow(row) : null;
  }

  async updateWorkflow(id, userId, values) {
    const row = { ...values, updated_at: now() };
    if (this.remote) {
      const rows = await this.request(
        `workflows?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=*`,
        { method: 'PATCH', body: row, prefer: 'return=representation' }
      );
      return rows[0] ? this.normalizeWorkflow(rows[0]) : null;
    }
    const sets = Object.keys(row);
    const sql = `UPDATE workflows SET ${sets.map((key) => `${key} = ?`).join(', ')} WHERE id = ? AND user_id = ?`;
    const valuesToWrite = sets.map((key) => (
      ['nodes', 'edges'].includes(key)
        ? json(row[key])
        : typeof row[key] === 'boolean' ? Number(row[key]) : row[key]
    ));
    const result = this.db.prepare(sql).run(...valuesToWrite, id, userId);
    if (!result.changes) return null;
    return this.getWorkflow(id, userId);
  }

  async deleteWorkflow(id, userId) {
    if (this.remote) {
      const rows = await this.request(
        `workflows?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
        { method: 'DELETE', prefer: 'return=representation' }
      );
      return rows.length > 0;
    }
    const result = this.db.prepare(
      'DELETE FROM workflows WHERE id = ? AND user_id = ?'
    ).run(id, userId);
    return result.changes > 0;
  }

  async createRun({ id, workflowId, userId, status, output = null, error = null, durationMs = null }) {
    const row = {
      id,
      workflow_id: workflowId,
      user_id: userId,
      status,
      output,
      error,
      duration_ms: durationMs,
      created_at: now(),
    };
    if (this.remote) {
      await this.request('runs', {
        method: 'POST',
        body: row,
        prefer: 'return=minimal',
      });
      return row;
    }
    this.db.prepare(`
      INSERT INTO runs (id, workflow_id, user_id, status, output, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workflowId, userId, status, output ? json(output) : null, error, durationMs, row.created_at);
    return row;
  }

  async updateRun(id, userId, { status, output = null, error = null, durationMs = null }) {
    const values = { status, output, error, duration_ms: durationMs };
    if (this.remote) {
      await this.request(
        `runs?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
        { method: 'PATCH', body: values, prefer: 'return=minimal' }
      );
      return;
    }
    this.db.prepare(`
      UPDATE runs SET status = ?, output = ?, error = ?, duration_ms = ?
      WHERE id = ? AND user_id = ?
    `).run(status, output ? json(output) : null, error, durationMs, id, userId);
  }

  normalizeWorkflow(row) {
    return {
      ...row,
      nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes) : row.nodes,
      edges: typeof row.edges === 'string' ? JSON.parse(row.edges) : row.edges,
      deployed: row.deployed === true || row.deployed === 1,
    };
  }

  close() {
    this.db?.close();
  }
}
