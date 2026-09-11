const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const { signToken, logAudit } = require('../middleware/auth');

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

  // Seed default users if empty (hashed)
  const countRes = await db.query('SELECT COUNT(*) as count FROM users');
  const count = parseInt(countRes.rows[0].count, 10);
  if (count === 0) {
    const hash = (p) => bcrypt.hashSync(p, 10);
    // Admin
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Admin Coordinator', 'admin', hash('admin123'), 'admin', 'Operations Lead']
    );
    // Doctors
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Dr. Rao', '919959461095', hash('doctor123'), 'doctor', 'General Physician']
    );
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Dr. Ananya Sharma', '919876543210', hash('doctor123'), 'doctor', 'Consultant Physician']
    );
    // Technicians
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Priya', '919876543211', hash('tech123'), 'technician', 'Senior Phlebotomist']
    );
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Kiran Kumar', '919876543212', hash('tech123'), 'technician', 'Lab & Diagnostics Tech']
    );
    // Employee
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Sneha HR (Onboarding Specialist)', '919876543200', hash('staff123'), 'employee', 'Talent Acquisition & Compliance']
    );
    // Patient
    await db.query(
      'INSERT INTO users (name, phone, password, role, specialty) VALUES ($1, $2, $3, $4, $5)',
      ['Ramesh Patient', '919876500000', hash('patient123'), 'patient', 'General']
    );
    console.log('Default users seeded successfully (hashed).');
  }
}

// Call on load
ensureUsersTable().catch((err) => console.error('Error creating users table:', err.message));

// Login Endpoint — bcrypt + JWT, Joi validation, audit
const loginSchema = Joi.object({
  identifier: Joi.string().trim().min(2).max(50).required(),
  password: Joi.string().min(3).max(100).required(),
  role: Joi.string().valid('admin','doctor','technician','employee','patient').optional()
});
router.post('/login', async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  const { identifier, password } = value;

  try {
    const trimmedId = identifier.trim();
    const digitsOnly = trimmedId.replace(/[^0-9]/g, '');

    let userCheck;
    if (digitsOnly.length >= 10) {
      userCheck = await db.query(
        'SELECT id, name, phone, email, role, specialty, active, password FROM users WHERE phone LIKE $1 OR phone = $2 OR email = $2',
        [`%${digitsOnly.slice(-10)}`, trimmedId]
      );
    } else {
      userCheck = await db.query(
        'SELECT id, name, phone, email, role, specialty, active, password FROM users WHERE LOWER(phone) = LOWER($1) OR LOWER(email) = LOWER($1)',
        [trimmedId]
      );
    }

    const user = userCheck.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'No account found with this phone/username. Please register or check your number.' });
    }

    // bcrypt compare with fallback to plain + auto-migrate
    let passwordOk = false;
    try {
      if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
        passwordOk = await bcrypt.compare(password, user.password);
      } else {
        passwordOk = (user.password === password.trim());
        if (passwordOk) {
          // migrate to hashed
          const newHash = await bcrypt.hash(password.trim(), 10);
          await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]).catch(()=>{});
        }
      }
    } catch (e) { passwordOk = false; }

    if (!passwordOk) {
      await logAudit({ actor: user, action: 'auth:login_failed', entity_type: 'user', entity_id: user.id, meta: { identifier }, ip: req.ip });
      return res.status(401).json({ error: `Incorrect password for ${user.name} (${user.role}).` });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Your account is deactivated. Please contact the administrator.' });
    }

    const token = signToken(user);
    await logAudit({ actor: user, action: 'auth:login', entity_type: 'user', entity_id: user.id, ip: req.ip });

    // Successfully authenticated - use their registered role
    res.json({
      success: true,
      token,
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

// Registration Endpoint — Joi + hash + audit
const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  phone: Joi.string().trim().min(8).max(20).required(),
  email: Joi.string().email().allow('', null),
  password: Joi.string().min(4).max(100).required(),
  role: Joi.string().valid('doctor','technician','patient','nurse','employee').required(),
  specialty: Joi.string().allow('', null).max(80)
});
router.post('/register', async (req, res) => {
  const { error, value } = registerSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  const { name, phone, email, password, role, specialty } = value;

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

    const hashed = await bcrypt.hash(password.trim(), 10);
    // Insert into users
    const { rows } = await db.query(
      'INSERT INTO users (name, phone, email, password, role, specialty) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, phone, role, specialty',
      [name.trim(), cleanPhone, email ? email.trim() : null, hashed, role, specialty ? specialty.trim() : null]
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

    await logAudit({ actor: rows[0], action: 'auth:register', entity_type: 'user', entity_id: rows[0].id, meta: { role }, ip: req.ip });
    const token = signToken(rows[0]);
    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: rows[0]
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Could not complete registration. Phone number might already be registered.' });
  }
});

// Google Sign-In endpoint for Patients
router.post('/google', async (req, res) => {
  try {
    const { email, name, google_id, photo_url } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid Google email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = (name || cleanEmail.split('@')[0] || 'Patient').trim();

    // Check if user already exists by email
    let userCheck = await db.query(
      'SELECT id, name, phone, email, role, specialty, active FROM users WHERE LOWER(email) = $1',
      [cleanEmail]
    );

    let user = userCheck.rows[0];

    if (!user) {
      // Create new patient account for this Google user
      const suffix = Math.floor(10000000 + Math.random() * 90000000);
      const generatedPhone = '919' + suffix;
      const dummyPassword = await bcrypt.hash('google_' + cleanEmail + '_' + Date.now(), 10);

      const insertRes = await db.query(
        'INSERT INTO users (name, phone, email, password, role, specialty) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, phone, email, role, specialty, active',
        [cleanName, generatedPhone, cleanEmail, dummyPassword, 'patient', 'General Patient']
      );
      user = insertRes.rows[0];
      await logAudit({ actor: user, action: 'auth:google_register', entity_type: 'user', entity_id: user.id, ip: req.ip });
    } else {
      await logAudit({ actor: user, action: 'auth:google_login', entity_type: 'user', entity_id: user.id, ip: req.ip });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Your account is deactivated. Please contact support.' });
    }

    const token = signToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        specialty: user.specialty,
        photo_url: photo_url || null
      }
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Google authentication service error.' });
  }
});

module.exports = router;
