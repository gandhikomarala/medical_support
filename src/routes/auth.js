const express = require('express');
const router = express.Router();
const db = require('../db');

// Ensure users table exists
async function ensureUsersTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id ${db.isSqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'},
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      specialty TEXT,
      active ${db.isSqlite ? 'INTEGER NOT NULL DEFAULT 1' : 'BOOLEAN NOT NULL DEFAULT TRUE'},
      created_at ${db.isSqlite ? "TEXT NOT NULL DEFAULT (datetime('now'))" : "TIMESTAMPTZ NOT NULL DEFAULT now()"}
    );
  `);

  // Seed default users if empty
  const countRes = await db.query('SELECT COUNT(*) as count FROM users');
  const count = parseInt(countRes.rows[0].count, 10);
  if (count === 0) {
    // Admin
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Admin Coordinator', 'admin', 'admin123', 'admin', 'Operations Lead']
    );
    // Doctors
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Dr. Rao', '919959461095', 'doctor123', 'doctor', 'General Physician']
    );
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Dr. Ananya Sharma', '919876543210', 'doctor123', 'doctor', 'Consultant Physician']
    );
    // Technicians
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Priya', '919876543211', 'tech123', 'technician', 'Senior Phlebotomist']
    );
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Kiran Kumar', '919876543212', 'tech123', 'technician', 'Lab & Diagnostics Tech']
    );
    console.log('Default users seeded successfully.');
  }
}

// Call on load
ensureUsersTable().catch((err) => console.error('Error creating users table:', err.message));

// Login Endpoint
router.post('/login', async (req, res) => {
  const { identifier, password, role } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/Phone and Password are required.' });
  }

  try {
    const { rows } = await db.query(
      'SELECT id, name, phone, email, role, specialty, active FROM users WHERE (phone = $1 OR email = $1) AND password = $2',
      [identifier.trim(), password.trim()]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid phone/username or password.' });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Your account is deactivated. Please contact the administrator.' });
    }

    if (role && user.role !== role && user.role !== 'admin') {
      return res.status(401).json({ error: `Account found, but role is '${user.role}', not '${role}'.` });
    }

    // In production we'd sign a JWT; here we return user session data
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        specialty: user.specialty
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server authentication error.' });
  }
});

// Registration Endpoint
router.post('/register', async (req, res) => {
  const { name, phone, email, password, role, specialty } = req.body;

  if (!name || !phone || !password || !role) {
    return res.status(400).json({ error: 'Name, Phone, Password, and Role are required.' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code (e.g. 919959461095).' });
  }

  try {
    // Check if phone already exists
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this phone number already exists.' });
    }

    // Insert into users
    const { rows } = await db.query(
      'INSERT INTO users (name, phone, email, password, role, specialty) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, phone, role, specialty',
      [name.trim(), cleanPhone, email ? email.trim() : null, password.trim(), role, specialty ? specialty.trim() : null]
    );

    // If staff (doctor/technician), also synchronize to doctors/technicians tables for WhatsApp dispatching
    if (role === 'doctor') {
      await db.query(
        'INSERT INTO doctors (name, phone, specialty) VALUES ($1, $2, $3) ON CONFLICT (phone) DO NOTHING',
        [name.trim(), cleanPhone, specialty || 'General Physician']
      );
    } else if (role === 'technician') {
      await db.query(
        'INSERT INTO technicians (name, phone) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING',
        [name.trim(), cleanPhone]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      user: rows[0]
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Could not complete registration. Phone number might already be registered.' });
  }
});

module.exports = router;
