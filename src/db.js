const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');

let pgPool = null;
let sqliteDb = null;
let useSqlite = false;

// Read database URL from environment variable. If none provided, db.js automatically falls back to local SQLite.
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || '';

// Attempt Postgres if dbUrl is set
if (dbUrl && dbUrl.startsWith('postgres')) {
  try {
    const { Pool } = require('pg');
    const isCloud = dbUrl.includes('neon.tech') || dbUrl.includes('sslmode=require');
    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: isCloud ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 30000,
    });
    console.log('PostgreSQL connection pool initialized.');
  } catch (err) {
    console.warn('PostgreSQL initialization error, will use SQLite fallback:', err.message);
  }
}

function initSqlite() {
  if (sqliteDb) return sqliteDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const isVercel = Boolean(process.env.VERCEL);
    const dataDir = isVercel ? '/tmp' : path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'ayans_medicare.db');
    sqliteDb = new DatabaseSync(dbPath);
  
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      specialty TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS technicians (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_name TEXT NOT NULL,
      patient_phone TEXT NOT NULL,
      patient_address TEXT NOT NULL,
      service_type TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      assigned_doctor_id INTEGER REFERENCES doctors(id),
      assigned_technician_id INTEGER REFERENCES technicians(id),
      prescription_text TEXT,
      lab_tests_needed TEXT,
      technician_visit_time TEXT,
      report_file_url TEXT,
      amount INTEGER DEFAULT 0,
      meet_link TEXT,
      preferred_time TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

        CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      specialty TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_onboarding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_name TEXT NOT NULL,
      candidate_phone TEXT UNIQUE NOT NULL,
      candidate_email TEXT,
      role TEXT NOT NULL,
      specialty TEXT,
      license_number TEXT,
      experience_years INTEGER,
      documents_verified INTEGER DEFAULT 1,
      verification_notes TEXT,
      submitted_by_name TEXT NOT NULL,
      submitted_by_phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS patient_vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_phone TEXT NOT NULL,
      systolic INTEGER,
      diastolic INTEGER,
      blood_sugar_fasting REAL,
      blood_sugar_pp REAL,
      pulse INTEGER,
      height_cm REAL,
      weight_kg REAL,
      bmi REAL,
      notes TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pharmacy_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      patient_name TEXT NOT NULL,
      patient_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      medicine_details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER REFERENCES requests(id),
      direction TEXT NOT NULL,
      phone TEXT NOT NULL,
      body TEXT,
      media_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_message_log_request ON message_log(request_id);
  `);

  // Seed doctors and technicians if empty
  const docCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM doctors').get().count;
  if (docCount === 0) {
    sqliteDb.prepare('INSERT INTO doctors (name, phone, specialty) VALUES (?, ?, ?)').run('Dr. Rao', '919959461095', 'General Physician');
    sqliteDb.prepare('INSERT INTO doctors (name, phone, specialty) VALUES (?, ?, ?)').run('Dr. Ananya Sharma', '919876543210', 'Consultant Physician');
    sqliteDb.prepare('INSERT INTO technicians (name, phone) VALUES (?, ?)').run('Priya', '919876543211');
    sqliteDb.prepare('INSERT INTO technicians (name, phone) VALUES (?, ?)').run('Kiran Kumar', '919876543212');
  }

  // Seed default users if empty
  const userCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Admin Coordinator', 'admin', 'admin123', 'admin', 'Operations Lead');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Dr. Rao', '919959461095', 'doctor123', 'doctor', 'General Physician');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Dr. Ananya Sharma', '919876543210', 'doctor123', 'doctor', 'Consultant Physician');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Priya', '919876543211', 'tech123', 'technician', 'Senior Phlebotomist');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Kiran Kumar', '919876543212', 'tech123', 'technician', 'Diagnostics Tech');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Sneha HR (Onboarding Specialist)', '919876543200', 'staff123', 'employee', 'Talent Acquisition & Compliance');
    sqliteDb.prepare('INSERT INTO users (name, phone, password, role, specialty) VALUES (?, ?, ?, ?, ?)').run('Ramesh Patient', '919876500000', 'patient123', 'patient', 'General');
  }

  return sqliteDb;
  } catch (err) {
    console.warn('SQLite initialization skipped/failed:', err.message);
    return null;
  }
}

async function query(text, params = []) {
  if (pgPool && !useSqlite) {
    try {
      return await pgPool.query(text, params);
    } catch (err) {
      console.warn('Postgres query failed, falling back to local SQLite:', err.message);
      useSqlite = true;
    }
  }

  // SQLite execution
  const db = initSqlite();
  if (!db) {
    console.warn('No active database connection available.');
    return { rows: [], rowCount: 0 };
  }
  
  let sqliteQuery = text.replace(/now\(\)\s*-\s*\(\$([0-9]+)\s*\|\|\s*' minutes'\)::interval/gi, "datetime('now', '-' || ?$1 || ' minutes')");
  sqliteQuery = sqliteQuery.replace(/\$([0-9]+)/g, '?');
  sqliteQuery = sqliteQuery.replace(/now\(\)/gi, "datetime('now')");
  
  const cleanParams = (params || []).map(p => {
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });

  const isSelectOrReturning = /^(select|with)/i.test(sqliteQuery.trim()) || /returning/i.test(sqliteQuery);

  try {
    const stmt = db.prepare(sqliteQuery);
    if (isSelectOrReturning) {
      const rows = stmt.all(...cleanParams);
      return { rows, rowCount: rows.length };
    } else {
      const info = stmt.run(...cleanParams);
      return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
    }
  } catch (err) {
    console.error('SQLite execution error on query:', sqliteQuery, err);
    throw err;
  }
}

module.exports = {
  query,
  get isSqlite() { return useSqlite || !pgPool; },
  pool: pgPool,
};
