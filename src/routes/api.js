const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const requestService = require('../services/requestService');
const groq = require('../services/groq');
const db = require('../db');

// Setup multer file uploads for lab reports
const uploadDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', '..', 'uploads');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  console.warn('Could not create upload directory:', err.message);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `report-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage });

// ==========================================
// 1. GENERAL / PATIENT REQUESTS
// ==========================================

// Create request from website form
router.post('/requests', async (req, res) => {
  const { patient_name, patient_phone, patient_address, service_type, notes } = req.body;

  if (!patient_name || !patient_phone || !patient_address || !service_type) {
    return res.status(400).json({ error: 'patient_name, patient_phone, patient_address and service_type are required.' });
  }
  const validTypes = ['doctor', 'nurse', 'lab_test', 'pharmacy'];
  if (!validTypes.includes(service_type)) {
    return res.status(400).json({ error: `service_type must be one of: ${validTypes.join(', ')}` });
  }

  try {
    const request = await requestService.createRequest({ patient_name, patient_phone, patient_address, service_type, notes });
    res.status(201).json({ 
      success: true,
      id: request.id, 
      status: request.status,
      message: 'Your healthcare request has been submitted. A coordinator and verified healthcare provider will contact you shortly!'
    });
  } catch (err) {
    console.error('Error creating request:', err);
    res.status(500).json({ error: 'Something went wrong creating your request.' });
  }
});

// Get request status by ID
router.get('/requests/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, d.name as doctor_name, d.specialty as doctor_specialty, t.name as technician_name 
       FROM requests r
       LEFT JOIN doctors d ON r.assigned_doctor_id = d.id
       LEFT JOIN technicians t ON r.assigned_technician_id = t.id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// List all requests
router.get('/requests', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, d.name as doctor_name, t.name as technician_name 
       FROM requests r
       LEFT JOIN doctors d ON r.assigned_doctor_id = d.id
       LEFT JOIN technicians t ON r.assigned_technician_id = t.id
       ORDER BY r.id DESC LIMIT 100`
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Patient view by phone
router.get('/patient/bookings/:phone', async (req, res) => {
  try {
    const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
    const { rows } = await db.query(
      `SELECT r.*, d.name as doctor_name, t.name as technician_name 
       FROM requests r
       LEFT JOIN doctors d ON r.assigned_doctor_id = d.id
       LEFT JOIN technicians t ON r.assigned_technician_id = t.id
       WHERE r.patient_phone LIKE $1 ORDER BY r.id DESC`,
      [`%${cleanPhone}%`]
    );
    res.json({ bookings: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch patient bookings' });
  }
});

// ==========================================
// 2. ADMIN PORTAL ENDPOINTS
// ==========================================

router.get('/admin/stats', async (req, res) => {
  try {
    const totalRes = await db.query('SELECT COUNT(*) as count FROM requests');
    const newRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status = 'new'");
    const activeDocRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status IN ('doctor_assigned', 'prescribed')");
    const activeLabRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status IN ('lab_requested', 'technician_assigned')");
    const completedRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status = 'completed'");
    const docCountRes = await db.query('SELECT COUNT(*) as count FROM doctors WHERE active = TRUE');
    const techCountRes = await db.query('SELECT COUNT(*) as count FROM technicians WHERE active = TRUE');

    res.json({
      total_requests: parseInt(totalRes.rows[0]?.count || 0, 10),
      unassigned_requests: parseInt(newRes.rows[0]?.count || 0, 10),
      active_doctor_visits: parseInt(activeDocRes.rows[0]?.count || 0, 10),
      pending_lab_pickups: parseInt(activeLabRes.rows[0]?.count || 0, 10),
      completed_requests: parseInt(completedRes.rows[0]?.count || 0, 10),
      registered_doctors: parseInt(docCountRes.rows[0]?.count || 0, 10),
      registered_technicians: parseInt(techCountRes.rows[0]?.count || 0, 10),
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

router.get('/admin/staff', async (req, res) => {
  try {
    const doctors = await db.query('SELECT * FROM doctors ORDER BY id ASC');
    const technicians = await db.query('SELECT * FROM technicians ORDER BY id ASC');
    res.json({ doctors: doctors.rows, technicians: technicians.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch staff roster' });
  }
});

// Admin manual assignment
router.post('/admin/assign', async (req, res) => {
  const { request_id, doctor_id, technician_id } = req.body;
  try {
    if (doctor_id) {
      await db.query(
        "UPDATE requests SET assigned_doctor_id = $1, status = 'doctor_assigned', updated_at = now() WHERE id = $2",
        [doctor_id, request_id]
      );
    }
    if (technician_id) {
      await db.query(
        "UPDATE requests SET assigned_technician_id = $1, status = 'technician_assigned', updated_at = now() WHERE id = $2",
        [technician_id, request_id]
      );
    }
    res.json({ success: true, message: 'Request assignment updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Assignment failed' });
  }
});

// ==========================================
// 3. DOCTOR PORTAL ENDPOINTS
// ==========================================

router.get('/doctor/my-requests/:phone', async (req, res) => {
  try {
    const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
    const { rows: docRows } = await db.query('SELECT id, name FROM doctors WHERE phone LIKE $1', [`%${cleanPhone}%`]);
    if (!docRows[0]) return res.json({ requests: [] });

    const docId = docRows[0].id;
    const { rows } = await db.query(
      `SELECT * FROM requests WHERE assigned_doctor_id = $1 ORDER BY id DESC`,
      [docId]
    );
    res.json({ doctor: docRows[0], requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch doctor requests' });
  }
});

router.post('/doctor/submit-prescription', async (req, res) => {
  const { request_id, doctor_phone, prescription_text, lab_tests } = req.body;
  if (!request_id || !prescription_text) {
    return res.status(400).json({ error: 'request_id and prescription_text are required.' });
  }

  try {
    // Parse using Groq AI if lab_tests not explicitly given
    let tests = lab_tests;
    let finalPrescription = prescription_text;
    if (!tests) {
      const parsed = await groq.parsePrescriptionMessage(prescription_text);
      tests = (parsed.lab_tests || []).join(', ');
      finalPrescription = parsed.prescription || prescription_text;
    }

    const newStatus = tests && tests.trim().length > 0 ? 'lab_requested' : 'completed';

    const { rows } = await db.query(
      `UPDATE requests 
       SET prescription_text = $1, lab_tests_needed = $2, status = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [finalPrescription, tests || '', newStatus, request_id]
    );

    res.json({
      success: true,
      message: 'Prescription recorded successfully!',
      request: rows[0]
    });
  } catch (err) {
    console.error('Prescription error:', err);
    res.status(500).json({ error: 'Failed to submit prescription' });
  }
});

// ==========================================
// 4. TECHNICIAN PORTAL ENDPOINTS
// ==========================================

router.get('/technician/my-tasks/:phone', async (req, res) => {
  try {
    const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
    const { rows: techRows } = await db.query('SELECT id, name FROM technicians WHERE phone LIKE $1', [`%${cleanPhone}%`]);
    
    // Also include lab_requested (available to pick up)
    const techId = techRows[0] ? techRows[0].id : null;
    const { rows } = await db.query(
      `SELECT * FROM requests 
       WHERE (status = 'lab_requested') OR (assigned_technician_id = $1)
       ORDER BY id DESC`,
      [techId || -1]
    );

    res.json({ technician: techRows[0] || null, tasks: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch technician tasks' });
  }
});

router.post('/technician/set-time', async (req, res) => {
  const { request_id, technician_phone, visit_time } = req.body;
  if (!request_id || !visit_time) {
    return res.status(400).json({ error: 'request_id and visit_time are required' });
  }

  try {
    const cleanPhone = technician_phone.replace(/[^0-9]/g, '');
    const { rows: techRows } = await db.query('SELECT id FROM technicians WHERE phone LIKE $1', [`%${cleanPhone}%`]);
    const techId = techRows[0]?.id;

    const { rows } = await db.query(
      `UPDATE requests 
       SET technician_visit_time = $1, assigned_technician_id = COALESCE($2, assigned_technician_id), 
           status = 'technician_assigned', updated_at = now() 
       WHERE id = $3 RETURNING *`,
      [visit_time, techId, request_id]
    );

    res.json({ success: true, message: 'Visit time scheduled', request: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set visit time' });
  }
});

router.post('/technician/upload-report', upload.single('report_file'), async (req, res) => {
  const { request_id } = req.body;
  if (!req.file || !request_id) {
    return res.status(400).json({ error: 'File and request_id are required' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;

  try {
    const { rows } = await db.query(
      `UPDATE requests 
       SET report_file_url = $1, status = 'completed', updated_at = now() 
       WHERE id = $2 RETURNING *`,
      [fileUrl, request_id]
    );

    res.json({
      success: true,
      message: 'Test report uploaded and patient request marked as completed!',
      report_url: fileUrl,
      request: rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload report' });
  }
});

module.exports = router;
