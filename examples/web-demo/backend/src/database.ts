import Database from 'better-sqlite3';
import * as path from 'path';

const dbPath = path.join(__dirname, '../../workspace/artipod.db');
const db = new Database(dbPath);

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS pods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id TEXT NOT NULL,
    mount_name TEXT NOT NULL,
    mount_path TEXT NOT NULL,
    FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE,
    UNIQUE(pod_id, mount_name)
  );

  CREATE TABLE IF NOT EXISTS containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id TEXT NOT NULL UNIQUE,
    container_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (pod_id) REFERENCES pods(id) ON DELETE CASCADE
  );
`);

// Add activity tracking columns if they don't exist
try {
  db.exec(`ALTER TABLE containers ADD COLUMN last_command_at INTEGER`);
} catch (e) {
  // Column already exists
}
try {
  db.exec(`ALTER TABLE containers ADD COLUMN command_count INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}
// Add readonly column to mounts if it doesn't exist
try {
  db.exec(`ALTER TABLE mounts ADD COLUMN readonly INTEGER DEFAULT 0`);
} catch (e) {
  // Column already exists
}

export interface Pod {
  id: string;
  name: string;
  created_at: number;
}

export interface Mount {
  id: number;
  pod_id: string;
  mount_name: string;
  mount_path: string;
  readonly: number; // SQLite stores booleans as 0/1
}

export interface Container {
  id: number;
  pod_id: string;
  container_id: string;
  status: string;
  created_at: number;
  last_command_at?: number;
  command_count?: number;
}

// Pod operations
export const createPod = db.prepare(`
  INSERT INTO pods (id, name, created_at) VALUES (?, ?, ?)
`);

export const getPod = db.prepare(`
  SELECT * FROM pods WHERE id = ?
`);

export const getAllPods = db.prepare(`
  SELECT * FROM pods ORDER BY created_at DESC
`);

export const deletePod = db.prepare(`
  DELETE FROM pods WHERE id = ?
`);

// Mount operations
export const createMount = db.prepare(`
  INSERT INTO mounts (pod_id, mount_name, mount_path, readonly) VALUES (?, ?, ?, ?)
`);

export const getMountsForPod = db.prepare(`
  SELECT * FROM mounts WHERE pod_id = ? ORDER BY mount_name
`);

// Container operations
export const createContainer = db.prepare(`
  INSERT INTO containers (pod_id, container_id, status, created_at) 
  VALUES (?, ?, ?, ?)
`);

export const getContainerForPod = db.prepare(`
  SELECT * FROM containers WHERE pod_id = ?
`);

export const updateContainerStatus = db.prepare(`
  UPDATE containers SET status = ? WHERE pod_id = ?
`);

export const updateContainerActivity = db.prepare(`
  UPDATE containers 
  SET last_command_at = ?, command_count = COALESCE(command_count, 0) + 1
  WHERE pod_id = ?
`);

export const deleteContainer = db.prepare(`
  DELETE FROM containers WHERE pod_id = ?
`);

export default db;
