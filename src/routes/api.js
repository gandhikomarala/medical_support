const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const requestService = require('../services/requestService');
const groq = require('../services/groq');
const db = require('../db');
const realtime = require('../services/realtime');
const Joi = require('joi');
const { authorize, logAudit } = require('../middleware/auth');

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
    const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
    cb(null, `report-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (JPG, PNG, WebP) are permitted.'));
    }
  }
});

// ==========================================
// 1. SERVICES CATALOG & PATIENT REQUESTS
// ==========================================

const SERVICES_CATALOG = [
  {
    id: 'gp_home',
    type: 'doctor',
    title: 'General Physician Consultation',
    category: 'Doctor Consult',
    price: 0,
    duration: '20-30 mins',
    badge: '₹0 Free Consult',
    description: 'Zero-fee consultation with certified MBBS doctor for fever, cough, viral infection, and routine health complaints.',
    features: ['100% Free Consultation (₹0)', 'Physical & Symptom Diagnosis', 'Instant Digital Prescription & Rx Pad', 'Follow-up Care Guidance']
  },
  {
    id: 'specialist_video',
    type: 'doctor',
    title: 'Specialist Telehealth Video Consult',
    category: 'Tele-Consult',
    price: 0,
    duration: '20-30 mins',
    badge: '₹0 Free Video Call',
    description: 'Instant private video consultation with senior medical specialists (Cardiology, Pediatrics, Dermatology, Internal Medicine).',
    features: ['100% Free Video Consult (₹0)', 'Secure Encrypted Private Meeting Room', 'Doctor Clinical Diagnosis & Advice', 'Zero Patient Contact Leak']
  },
  {
    id: 'nurse_care',
    type: 'nurse',
    title: 'Home Nursing & Clinical Vitals Care',
    category: 'Nursing Services',
    price: 0,
    duration: '30 mins',
    badge: '₹0 Free Care Assist',
    description: 'Doorstep nurse support for vitals monitoring, blood pressure screening, pulse tracking, and clinical guidance.',
    features: ['100% Free Health Guidance (₹0)', 'Vitals & Blood Pressure Check', 'Injection / IV Assistance', 'Post-Op Recovery Support']
  },
  {
    id: 'full_body_lab',
    type: 'lab_test',
    title: 'Comprehensive Full-Body Health Checkup',
    category: 'Diagnostics & Lab',
    price: 999,
    duration: 'Home sample pickup',
    badge: '65+ Parameters',
    description: 'Complete health check: Complete Hemogram (CBC), Lipid Profile, Liver Function (LFT), Kidney Function (KFT), Thyroid (TSH), and Blood Sugar.',
    features: ['Doorstep blood & urine collection', '65+ vital health parameters tested', 'NABL Accredited Laboratory Processing', 'Free Follow-up Doctor Review (₹0)']
  },
  {
    id: 'diabetes_care_profile',
    type: 'lab_test',
    title: 'Diabetes & Metabolic Screening Profile',
    category: 'Diagnostics & Lab',
    price: 499,
    duration: 'Home sample pickup',
    badge: 'Diabetes Profile',
    description: 'Essential diabetes monitoring: HbA1c 3-Month Average Glucose, Fasting Blood Sugar (FBS), and Urine Microalbumin.',
    features: ['Doorstep painless sample collection', 'Gold standard HbA1c Glycated Hemoglobin', 'Fasting Blood Glucose Analysis', 'Dietary & Lifestyle Health Plan']
  },
  {
    id: 'cardiac_heart_profile',
    type: 'lab_test',
    title: 'Cardiac Risk & Heart Health Profile',
    category: 'Diagnostics & Lab',
    price: 799,
    duration: 'Home sample pickup',
    badge: 'Heart Health Profile',
    description: 'Comprehensive lipid and cardiovascular risk analysis: Total Cholesterol, HDL, LDL, Triglycerides, and hs-CRP inflammation marker.',
    features: ['Comprehensive Lipid Panel', 'Atherogenic risk index calculation', 'Certified Phlebotomist Home Visit', 'Digital PDF Report in Portal']
  },
  {
    id: 'thyroid_screening',
    type: 'lab_test',
    title: 'Thyroid Care & Hormone Profile',
    category: 'Diagnostics & Lab',
    price: 399,
    duration: 'Home sample pickup',
    badge: 'Thyroid Profile',
    description: 'Complete thyroid hormone panel: Total T3, Total T4, and ultrasensitive TSH for metabolic and weight evaluation.',
    features: ['T3, T4 and TSH hormones tested', 'Early hypothyroidism detection', 'Same-day NABL certified report', 'Digital report delivery to phone']
  },
  {
    id: 'express_pharmacy',
    type: 'pharmacy',
    title: 'Prescription Medicine Doorstep Delivery',
    category: 'Pharmacy',
    price: 0,
    duration: 'Within 2 hours',
    badge: 'Free Delivery',
    description: 'Submit your doctor prescription; our licensed partner pharmacies dispense 100% genuine medicines with free delivery.',
    features: ['100% genuine verified medicines', 'Express doorstep delivery', 'Direct bill payment at doorstep', 'Medication guidance & reminders']
  }
];

// Get services catalog
router.get('/services', (req, res) => {
  res.json({ services: SERVICES_CATALOG });
});

// Create request from website form or patient catalog
router.post('/requests', async (req, res) => {
  const { patient_name, patient_phone, patient_address, service_type, notes, amount, preferred_time } = req.body;

  if (!patient_name || !patient_phone || !patient_address || !service_type) {
    return res.status(400).json({ error: 'patient_name, patient_phone, patient_address and service_type are required.' });
  }
  const validTypes = ['doctor', 'nurse', 'lab_test', 'pharmacy'];
  if (!validTypes.includes(service_type)) {
    return res.status(400).json({ error: `service_type must be one of: ${validTypes.join(', ')}` });
  }

  try {
    const request = await requestService.createRequest({
      patient_name,
      patient_phone,
      patient_address,
      service_type,
      notes,
      amount: parseInt(amount, 10) || 0,
      preferred_time: preferred_time || ''
    });
    res.status(201).json({ 
      success: true,
      id: request.id, 
      status: request.status,
      amount: request.amount,
      message: 'Your healthcare request has been submitted. A verified doctor will be notified immediately!'
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

// List all requests — paginated + search + filter (professional)
router.get('/requests', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page,10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit,10) || 20));
    const offset = (page-1)*limit;
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const service = (req.query.service_type || '').trim();
    const from = req.query.from;
    const to = req.query.to;
    const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    let where = [];
    let params = [];
    let idx=1;
    if (q) { where.push(`(LOWER(r.patient_name) LIKE LOWER($${idx}) OR LOWER(r.patient_phone) LIKE LOWER($${idx}) OR LOWER(r.patient_address) LIKE LOWER($${idx}) OR LOWER(r.notes) LIKE LOWER($${idx}))`); params.push(`%${q}%`); idx++; }
    if (status) { where.push(`r.status = $${idx}`); params.push(status); idx++; }
    if (service) { where.push(`r.service_type = $${idx}`); params.push(service); idx++; }
    if (from) { where.push(`r.created_at >= $${idx}`); params.push(from); idx++; }
    if (to) { where.push(`r.created_at <= $${idx}`); params.push(to); idx++; }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // SQLite compatibility: replace ILIKE with LIKE for sqlite fallback (handled in db.js via LIKE)
    let countSql = `SELECT COUNT(*) as total FROM requests r ${whereClause}`;
    let dataSql = `SELECT r.*, d.name as doctor_name, t.name as technician_name FROM requests r LEFT JOIN doctors d ON r.assigned_doctor_id = d.id LEFT JOIN technicians t ON r.assigned_technician_id = t.id ${whereClause} ORDER BY r.id ${sort} LIMIT $${idx} OFFSET $${idx+1}`;
    // For Postgres, ILIKE works; for SQLite fallback, LIKE is ok (db.js converts). Use ILIKE but fallback will handle.
    const countRes = await db.query(countSql, params);
    const total = parseInt(countRes.rows[0]?.total || countRes.rows[0]?.count || 0, 10);
    const { rows } = await db.query(dataSql, [...params, limit, offset]);
    res.json({ requests: rows, total, page, limit, totalPages: Math.ceil(total/limit) });
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
    const pendingOnboardingRes = await db.query("SELECT COUNT(*) as count FROM staff_onboarding WHERE status = 'pending'");

    res.json({
      total_requests: parseInt(totalRes.rows[0]?.count || 0, 10),
      unassigned_requests: parseInt(newRes.rows[0]?.count || 0, 10),
      active_doctor_visits: parseInt(activeDocRes.rows[0]?.count || 0, 10),
      pending_lab_pickups: parseInt(activeLabRes.rows[0]?.count || 0, 10),
      completed_requests: parseInt(completedRes.rows[0]?.count || 0, 10),
      registered_doctors: parseInt(docCountRes.rows[0]?.count || 0, 10),
      registered_technicians: parseInt(techCountRes.rows[0]?.count || 0, 10),
      pending_onboarding: parseInt(pendingOnboardingRes.rows[0]?.count || 0, 10),
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

// Admin generate and dispatch private consultation video meet link
router.post('/admin/generate-meet', async (req, res) => {
  const { request_id, custom_meet_link } = req.body;
  if (!request_id) {
    return res.status(400).json({ error: 'request_id is required.' });
  }

  try {
    const crypto = require('crypto');
    const roomId = 'nhealth-telehealth-' + request_id + '-' + crypto.randomBytes(3).toString('hex');
    const meetUrl = custom_meet_link && custom_meet_link.trim().startsWith('http')
      ? custom_meet_link.trim()
      : `https://meet.jit.si/${roomId}#config.prejoinPageEnabled=false`;

    const { rows } = await db.query(
      `UPDATE requests 
       SET meet_link = $1, updated_at = now() 
       WHERE id = $2 
       RETURNING *`,
      [meetUrl, request_id]
    );

    const reqData = rows[0];
    if (!reqData) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    // Fetch doctor info for notifications
    let doctorName = 'Assigned Doctor';
    let doctorPhone = null;
    if (reqData.assigned_doctor_id) {
      const docRes = await db.query('SELECT name, phone FROM doctors WHERE id = $1', [reqData.assigned_doctor_id]);
      if (docRes.rows[0]) {
        doctorName = docRes.rows[0].name;
        doctorPhone = docRes.rows[0].phone;
      }
    }

    // Mediated Dispatch: Send WhatsApp notification with the private meet link to both parties
    const wa = require('../services/whatsapp');
    if (doctorPhone) {
      await wa.sendText(
        doctorPhone,
        `Nhealth Telehealth Consultation Ready!\nPatient: ${reqData.patient_name}\nAddress: ${reqData.patient_address}\nJoin Secure Room: ${meetUrl}`
      );
    }
    if (reqData.patient_phone) {
      await wa.sendText(
        reqData.patient_phone,
        `Nhealth: Your private consultation room with Dr. ${doctorName} is ready!\nJoin Video Call: ${meetUrl}\nPlease do not share this private link.`
      );
    }

    try {
      realtime.broadcast('role:admin', 'teleconsult:link_ready', { request: reqData, meet_link: meetUrl });
      if (reqData.patient_phone) {
        realtime.broadcast(`user:${String(reqData.patient_phone).replace(/[^0-9]/g, '')}`, 'teleconsult:link_ready', { request: reqData, meet_link: meetUrl });
      }
      if (doctorPhone) {
        realtime.broadcast(`user:${String(doctorPhone).replace(/[^0-9]/g, '')}`, 'teleconsult:link_ready', { request: reqData, meet_link: meetUrl });
      }
      realtime.broadcast('role:doctor', 'teleconsult:link_ready', { request: reqData, meet_link: meetUrl });
    } catch (e) {}

    res.json({
      success: true,
      message: 'Private consultation meet link generated and dispatched to patient & doctor!',
      meet_link: meetUrl,
      request: reqData
    });
  } catch (err) {
    console.error('Generate meet link error:', err);
    res.status(500).json({ error: 'Failed to generate meet link' });
  }
});

// ==========================================
// 3. DOCTOR PORTAL ENDPOINTS
// ==========================================

// Stream of available unassigned requests for doctors (First-Accept-Wins pool)
router.get('/doctor/available-requests', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, patient_name, patient_address, service_type, notes, amount, preferred_time, status, created_at
       FROM requests
       WHERE status = 'new' AND service_type != 'lab_test'
       ORDER BY id DESC LIMIT 50`
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error('Available requests error:', err);
    res.status(500).json({ error: 'Failed to fetch available requests' });
  }
});

// Atomic acceptance: First doctor to accept claims the patient
router.post(['/doctor/accept-request', '/doctor/accept'], async (req, res) => {
  const { doctor_phone, request_id } = req.body;
  if (!doctor_phone || !request_id) {
    return res.status(400).json({ error: 'doctor_phone and request_id are required.' });
  }

  try {
    const cleanPhone = doctor_phone.replace(/[^0-9]/g, '');
    let { rows: docRows } = await db.query(
      'SELECT id, name FROM doctors WHERE phone LIKE $1',
      [`%${cleanPhone}%`]
    );
    let doctor = docRows[0];
    if (!doctor) {
      // Check if user is registered as doctor in users table
      const { rows: uRows } = await db.query(
        "SELECT id, name, phone, specialty FROM users WHERE role = 'doctor' AND (phone LIKE $1 OR username LIKE $1)",
        [`%${cleanPhone}%`]
      );
      if (uRows[0]) {
        // Auto-upsert into doctors table so assignments and foreign keys work cleanly
        const ins = await db.query(
          `INSERT INTO doctors (name, phone, specialty, active)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT DO NOTHING
           RETURNING id, name`,
          [uRows[0].name || 'Doctor', cleanPhone, uRows[0].specialty || 'General Medicine']
        );
        doctor = ins.rows[0] || (await db.query('SELECT id, name FROM doctors WHERE phone LIKE $1', [`%${cleanPhone}%`])).rows[0];
      }
    }
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor profile not found.' });
    }

    // Atomic first-come-first-served update
    const { rows } = await db.query(
      `UPDATE requests 
       SET status = 'doctor_assigned', assigned_doctor_id = $1, updated_at = now()
       WHERE id = $2 AND status = 'new'
       RETURNING *`,
      [doctor.id, request_id]
    );

    if (rows.length === 0) {
      return res.status(409).json({ 
        error: `Request #${request_id} has already been accepted by another doctor. Thank you for your prompt response!` 
      });
    }

    const request = rows[0];

    // Notify Patient and Doctor via WhatsApp
    const wa = require('../services/whatsapp');
    await wa.sendText(
      request.patient_phone,
      `Good news! Dr. ${doctor.name} has accepted your consult request (#${request.id}). Our coordinator will share your private meeting link shortly.`
    );
    await wa.sendText(
      doctor_phone,
      `You're assigned to request #${request.id} for ${request.patient_name}. A secure private meet link will be generated by the coordinator.`
    );

    try {
      realtime.broadcast('role:admin', 'request:claimed', { request, doctor });
      realtime.broadcast('role:doctor', 'request:claimed', { request, doctor });
      realtime.broadcast(`user:${String(request.patient_phone).replace(/[^0-9]/g, '')}`, 'doctor:assigned', { request, doctor });
    } catch (e) {}

    res.json({
      success: true,
      message: `Request #${request.id} accepted successfully! It is now assigned to you.`,
      request
    });
  } catch (err) {
    console.error('Doctor accept error:', err);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

router.get('/doctor/my-requests/:phone', async (req, res) => {
  try {
    const cleanPhone = req.params.phone.replace(/[^0-9]/g, '');
    let { rows: docRows } = await db.query('SELECT id, name FROM doctors WHERE phone LIKE $1', [`%${cleanPhone}%`]);
    if (!docRows[0]) {
      const { rows: uRows } = await db.query("SELECT id, name FROM users WHERE role = 'doctor' AND phone LIKE $1", [`%${cleanPhone}%`]);
      if (uRows[0]) {
        docRows = (await db.query('SELECT id, name FROM doctors WHERE phone LIKE $1', [`%${cleanPhone}%`])).rows;
      }
    }
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
  const { request_id, doctor_phone, prescription_text, lab_tests, dispatch_to_lab } = req.body;
  if (!request_id || !prescription_text) {
    return res.status(400).json({ error: 'request_id and prescription_text are required.' });
  }

  try {
    // Format lab tests if array or string
    let tests = '';
    if (Array.isArray(lab_tests)) {
      tests = lab_tests.filter(t => t && String(t).trim().length > 0).map(t => String(t).trim()).join(', ');
    } else if (typeof lab_tests === 'string') {
      tests = lab_tests.trim();
    }

    let finalPrescription = prescription_text;
    if (!tests) {
      try {
        const parsed = await groq.parsePrescriptionMessage(prescription_text);
        tests = (parsed.lab_tests || []).join(', ');
        finalPrescription = parsed.prescription || prescription_text;
      } catch (e) {
        console.warn('Groq parse error in submit-prescription:', e.message);
      }
    }

    const hasTests = tests && tests.trim().length > 0;
    const shouldDispatch = hasTests && (dispatch_to_lab !== false && dispatch_to_lab !== 'false');
    const newStatus = shouldDispatch ? 'lab_requested' : 'completed';

    const { rows } = await db.query(
      `UPDATE requests 
       SET prescription_text = $1, lab_tests_needed = $2, status = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [finalPrescription, tests || '', newStatus, request_id]
    );

    const updatedRequest = rows[0];

    // If lab tests ordered and dispatch active, broadcast to technicians
    if (shouldDispatch && updatedRequest) {
      try {
        if (typeof requestService.broadcastToTechnicians === 'function') {
          await requestService.broadcastToTechnicians(updatedRequest);
        }
      } catch (broadcastErr) {
        console.warn('Technician broadcast error:', broadcastErr.message);
      }
    }

    // Real-time WebSocket notifications
    try {
      realtime.broadcast('role:doctor', 'prescription:submitted', { request: updatedRequest });
      realtime.broadcast('role:admin', 'doctor:prescribed', { request: updatedRequest });
      if (updatedRequest && updatedRequest.patient_phone) {
        realtime.broadcast(`user:${String(updatedRequest.patient_phone).replace(/[^0-9]/g, '')}`, 'prescription:ready', { request: updatedRequest });
      }
    } catch (realtimeErr) {
      console.warn('Realtime broadcast error:', realtimeErr.message);
    }

    res.json({
      success: true,
      message: shouldDispatch
        ? 'Prescription submitted and lab collection dispatched to technicians!'
        : 'Prescription recorded successfully!',
      request: updatedRequest
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

    const timeReq = rows[0];
    try {
      realtime.broadcast('role:admin', 'technician:time_set', { request: timeReq });
      realtime.broadcast(`user:${String(timeReq.patient_phone).replace(/[^0-9]/g, '')}`, 'technician:time_set', { request: timeReq });
    } catch (e) {}
    res.json({ success: true, message: 'Visit time scheduled', request: timeReq });
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

    const repReq = rows[0];
    try {
      realtime.broadcast('role:admin', 'lab:report_uploaded', { request: repReq, reportUrl: fileUrl });
      realtime.broadcast(`user:${String(repReq.patient_phone).replace(/[^0-9]/g, '')}`, 'lab:report_uploaded', { request: repReq, reportUrl: fileUrl });
      if (repReq.assigned_doctor_id) {
        realtime.broadcast('role:doctor', 'lab:report_uploaded', { request: repReq, reportUrl: fileUrl });
      }
    } catch (e) {}

    res.json({
      success: true,
      message: 'Test report uploaded and patient request marked as completed!',
      report_url: fileUrl,
      request: repReq
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload report' });
  }
});

// ==========================================
// 5. EMPLOYEE ONBOARDING & ADMIN APPROVAL
// ==========================================

// Employee submits onboarding application for Doctor, Nurse, or Technician
router.post('/onboarding/submit', async (req, res) => {
  const {
    candidate_name,
    candidate_phone,
    candidate_email,
    role,
    specialty,
    license_number,
    experience_years,
    verification_notes,
    submitted_by_name,
    submitted_by_phone
  } = req.body;

  if (!candidate_name || !candidate_phone || !role || !submitted_by_name) {
    return res.status(400).json({ error: 'Candidate name, phone, role, and recruiter name are required.' });
  }

  let cleanPhone = candidate_phone.replace(/[^0-9]/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid candidate phone number with country code (e.g. 919959461095).' });
  }

  try {
    // Check if phone already exists in active users
    const existingUser = await db.query('SELECT id, role FROM users WHERE phone = $1', [cleanPhone]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: `An active account with phone ${cleanPhone} already exists as '${existingUser.rows[0].role}'.` });
    }

    // Insert or update in staff_onboarding
    const { rows } = await db.query(
      `INSERT INTO staff_onboarding 
       (candidate_name, candidate_phone, candidate_email, role, specialty, license_number, experience_years, verification_notes, submitted_by_name, submitted_by_phone, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now())
       ON CONFLICT (candidate_phone) DO UPDATE 
       SET candidate_name = $1, candidate_email = $3, role = $4, specialty = $5, license_number = $6, experience_years = $7, verification_notes = $8, submitted_by_name = $9, submitted_by_phone = $10, status = 'pending', reviewed_at = null
       RETURNING *`,
      [
        candidate_name.trim(),
        cleanPhone,
        candidate_email ? candidate_email.trim() : null,
        role.toLowerCase(),
        specialty ? specialty.trim() : 'General',
        license_number ? license_number.trim() : null,
        parseInt(experience_years, 10) || 0,
        verification_notes ? verification_notes.trim() : 'Documents verified by HR employee',
        submitted_by_name.trim(),
        submitted_by_phone ? submitted_by_phone.trim() : ''
      ]
    );

    // Notify owner / admin via WhatsApp (safe-guarded)
    try {
      const wa = require('../services/whatsapp');
      const ownerPhone = process.env.OWNER_WHATSAPP_NUMBER;
      if (ownerPhone) {
        await wa.sendText(
          ownerPhone,
          `📋 New Staff Onboarding Submitted!\nCandidate: ${candidate_name} (${role.toUpperCase()} - ${specialty || 'General'})\nRegistration/License: ${license_number || 'N/A'}\nHired & Verified by: ${submitted_by_name} (${submitted_by_phone})\nPlease review and approve in Admin Portal.`
        );
      }
    } catch (waErr) {
      console.warn('WhatsApp admin notify warning:', waErr.message);
    }

    const newOnb = rows[0];
    try {
      realtime.broadcast('role:admin', 'onboarding:submitted', { onboarding: newOnb });
      if (submitted_by_phone) {
        realtime.broadcast(`user:${String(submitted_by_phone).replace(/[^0-9]/g, '')}`, 'onboarding:submitted', { onboarding: newOnb });
      }
    } catch (e) {}

    res.status(201).json({
      success: true,
      message: `Onboarding application for ${candidate_name} submitted successfully! Awaiting Admin verification and approval.`,
      onboarding_id: newOnb.id,
      onboarding: newOnb
    });
  } catch (err) {
    console.error('Onboarding submit error:', err);
    res.status(500).json({ error: 'Failed to submit onboarding application.' });
  }
});

// List onboarding requests (for employee tracker or admin review)
router.get('/onboarding/list', async (req, res) => {
  const { submitted_by_phone, status } = req.query;
  try {
    let sql = 'SELECT * FROM staff_onboarding';
    const params = [];

    if (submitted_by_phone) {
      params.push(`%${submitted_by_phone.trim()}%`);
      sql += ` WHERE submitted_by_phone LIKE $${params.length}`;
    } else if (status && status !== 'all') {
      params.push(status.trim());
      sql += ` WHERE status = $${params.length}`;
    }

    sql += ' ORDER BY id DESC LIMIT 100';
    const { rows } = await db.query(sql, params);
    res.json({ requests: rows, candidates: rows });
  } catch (err) {
    console.error('Onboarding list error:', err);
    res.status(500).json({ error: 'Failed to fetch onboarding requests.' });
  }
});

// Admin Review: Approve or Reject
router.post('/onboarding/review', async (req, res) => {
  const { onboarding_id, action, admin_notes } = req.body;
  if (!onboarding_id || !action) {
    return res.status(400).json({ error: 'onboarding_id and action (approve/reject) are required.' });
  }

  try {
    const { rows: reqRows } = await db.query('SELECT * FROM staff_onboarding WHERE id = $1', [onboarding_id]);
    const record = reqRows[0];
    if (!record) {
      return res.status(404).json({ error: 'Onboarding request not found.' });
    }

    if (action === 'approve') {
      // 1. Update onboarding request
      await db.query(
        `UPDATE staff_onboarding SET status = 'approved', admin_notes = $1, reviewed_at = now() WHERE id = $2`,
        [admin_notes || 'Approved by Admin', onboarding_id]
      );

      // 2. Create / activate account in users table
      const defaultPass = record.role === 'doctor' || record.role === 'nurse' ? 'doctor123' : 'tech123';
      await db.query(
        `INSERT INTO users (name, phone, email, password, role, specialty, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (phone) DO UPDATE SET active = TRUE, role = $5, specialty = $6`,
        [record.candidate_name, record.candidate_phone, record.candidate_email, defaultPass, record.role, record.specialty]
      );

      // 3. Synchronize to doctors or technicians table for WhatsApp dispatching
      if (record.role === 'doctor' || record.role === 'nurse') {
        await db.query(
          `INSERT INTO doctors (name, phone, specialty, active) VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (phone) DO UPDATE SET active = TRUE, specialty = $3`,
          [record.candidate_name, record.candidate_phone, record.specialty]
        );
      } else if (record.role === 'technician') {
        await db.query(
          `INSERT INTO technicians (name, phone, active) VALUES ($1, $2, TRUE)
           ON CONFLICT (phone) DO UPDATE SET active = TRUE`,
          [record.candidate_name, record.candidate_phone]
        );
      }

      // 4. WhatsApp notifications (safeguarded)
      try {
        const wa = require('../services/whatsapp');
        await wa.sendText(
          record.candidate_phone,
          `🎉 Congratulations ${record.candidate_name}! Your Nhealth staff onboarding (submitted by ${record.submitted_by_name}) has been verified and APPROVED by the Admin.\n\nYou can now log into your portal at https://medicalsupport-sable.vercel.app/portal.html using your phone (${record.candidate_phone}) and default password '${defaultPass}'. Welcome to our healthcare network!`
        );
        if (record.submitted_by_phone) {
          await wa.sendText(
            record.submitted_by_phone,
            `✅ Great news ${record.submitted_by_name}! Your candidate ${record.candidate_name} (${record.role} - ${record.specialty}) has been verified and APPROVED by the Admin.`
          );
        }
      } catch (waErr) {
        console.warn('WhatsApp review notify error:', waErr.message);
      }

      res.json({
        success: true,
        message: `${record.candidate_name} has been approved and activated into the portal as ${record.role}!`,
        candidate: record
      });
    } else {
      // Action === 'reject'
      await db.query(
        `UPDATE staff_onboarding SET status = 'rejected', admin_notes = $1, reviewed_at = now() WHERE id = $2`,
        [admin_notes || 'Verification requirements not satisfied', onboarding_id]
      );

      try {
        const wa = require('../services/whatsapp');
        if (record.submitted_by_phone) {
          await wa.sendText(
            record.submitted_by_phone,
            `⚠️ Onboarding Update: Candidate ${record.candidate_name} (${record.role}) was rejected by the Admin. Reason: ${admin_notes || 'Documentation requirements not met'}.`
          );
        }
      } catch (waErr) {
        console.warn('WhatsApp reject notify error:', waErr.message);
      }

      res.json({
        success: true,
        message: `Onboarding request for ${record.candidate_name} has been marked as rejected.`,
        candidate: record
      });
    }
  } catch (err) {
    console.error('Onboarding review error:', err);
    res.status(500).json({ error: 'Failed to process onboarding review.' });
  }
});

// ==========================================
// 8. PATIENT HEALTH VITALS (MFine Inspired)
// ==========================================

// Record patient vitals (BP, Blood Sugar, Pulse, BMI)
router.post('/vitals', async (req, res) => {
  const {
    patient_phone,
    systolic,
    diastolic,
    blood_sugar_fasting,
    blood_sugar_pp,
    pulse,
    height_cm,
    weight_kg,
    notes
  } = req.body;

  if (!patient_phone) {
    return res.status(400).json({ error: 'patient_phone is required.' });
  }

  let bmi = null;
  if (height_cm && weight_kg && parseFloat(height_cm) > 0) {
    const hM = parseFloat(height_cm) / 100;
    bmi = (parseFloat(weight_kg) / (hM * hM)).toFixed(1);
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO patient_vitals 
       (patient_phone, systolic, diastolic, blood_sugar_fasting, blood_sugar_pp, pulse, height_cm, weight_kg, bmi, notes, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING *`,
      [
        patient_phone.trim(),
        parseInt(systolic, 10) || null,
        parseInt(diastolic, 10) || null,
        blood_sugar_fasting ? parseFloat(blood_sugar_fasting) : null,
        blood_sugar_pp ? parseFloat(blood_sugar_pp) : null,
        parseInt(pulse, 10) || null,
        height_cm ? parseFloat(height_cm) : null,
        weight_kg ? parseFloat(weight_kg) : null,
        bmi ? parseFloat(bmi) : null,
        notes ? notes.trim() : null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Health vitals recorded successfully.',
      vitals: rows[0]
    });
  } catch (err) {
    console.error('Vitals recording error:', err);
    res.status(500).json({ error: 'Failed to record health vitals.' });
  }
});

// Get patient vitals history
router.get('/vitals/:phone', async (req, res) => {
  const phone = req.params.phone.trim();
  try {
    const { rows } = await db.query(
      'SELECT * FROM patient_vitals WHERE patient_phone = $1 ORDER BY recorded_at DESC LIMIT 25',
      [phone]
    );
    res.json({ success: true, vitals: rows });
  } catch (err) {
    console.error('Vitals fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch patient vitals.' });
  }
});

// ==========================================
// 9. PRESCRIPTION MEDICINE DELIVERY (Pharmacy)
// ==========================================

// Submit medicine delivery order
router.post('/pharmacy/order', async (req, res) => {
  const { request_id, patient_name, patient_phone, delivery_address, medicine_details } = req.body;

  if (!patient_name || !patient_phone || !delivery_address || !medicine_details) {
    return res.status(400).json({ error: 'patient_name, patient_phone, delivery_address, and medicine_details are required.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO pharmacy_orders (request_id, patient_name, patient_phone, delivery_address, medicine_details, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now())
       RETURNING *`,
      [
        request_id ? parseInt(request_id, 10) : null,
        patient_name.trim(),
        patient_phone.trim(),
        delivery_address.trim(),
        medicine_details.trim()
      ]
    );

    const wa = require('../services/whatsapp');
    await wa.sendText(
      patient_phone.trim(),
      `📦 Medicine Order Confirmed! Hello ${patient_name}, your request for doorstep delivery of prescribed medicines has been received. Our partner pharmacy is preparing your dispatch to ${delivery_address}. Free Delivery!`
    );

    const ownerPhone = process.env.OWNER_WHATSAPP_NUMBER;
    if (ownerPhone) {
      await wa.sendText(
        ownerPhone,
        `💊 New Prescription Medicine Delivery Request!\nPatient: ${patient_name} (${patient_phone})\nAddress: ${delivery_address}\nMedicines: ${medicine_details}\nOrder ID: #${rows[0].id}`
      );
    }

    res.status(201).json({
      success: true,
      message: 'Prescription medicine delivery order placed successfully!',
      order: rows[0],
      order_id: rows[0].id
    });
  } catch (err) {
    console.error('Pharmacy order error:', err);
    res.status(500).json({ error: 'Failed to place medicine delivery order.' });
  }
});

// List pharmacy orders
router.get('/pharmacy/orders', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM pharmacy_orders ORDER BY id DESC LIMIT 50');
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error('Pharmacy list error:', err);
    res.status(500).json({ error: 'Failed to fetch pharmacy orders.' });
  }
});


// ==========================================
// 10. PROFESSIONAL UPGRADE — ANALYTICS
// ==========================================
router.get('/admin/analytics', async (req, res) => {
  try {
    const range = req.query.range || '7d';
    let days = 7;
    if (range === '30d') days = 30;
    if (range === '90d') days = 90;
    const totalRes = await db.query('SELECT COUNT(*) as count FROM requests');
    const newRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status = 'new'");
    const completedRes = await db.query("SELECT COUNT(*) as count FROM requests WHERE status = 'completed'");
    // Revenue from invoices or fallback amount
    let revenue = 0;
    try {
      const revRes = await db.query("SELECT COALESCE(SUM(total),0) as sum FROM invoices WHERE status = 'paid'");
      revenue = parseFloat(revRes.rows[0]?.sum || 0);
    } catch(e) {
      const amtRes = await db.query("SELECT COALESCE(SUM(amount),0) as sum FROM requests WHERE status = 'completed'");
      revenue = parseFloat(amtRes.rows[0]?.sum || 0);
    }
    // Trend last `days` days
    const trendRes = await db.query(
      `SELECT DATE(created_at) as day, COUNT(*) as count FROM requests WHERE created_at >= now() - ($1 || ' days')::interval GROUP BY day ORDER BY day ASC`,
      [String(days)]
    ).catch(async () => {
      // SQLite fallback
      const r = await db.query(`SELECT DATE(created_at) as day, COUNT(*) as count FROM requests WHERE DATE(created_at) >= DATE('now', '-' || $1 || ' days') GROUP BY day ORDER BY day ASC`, [String(days)]);
      return r;
    });
    const funnel = {
      total: parseInt(totalRes.rows[0]?.count || 0, 10),
      unassigned: parseInt(newRes.rows[0]?.count || 0, 10),
      completed: parseInt(completedRes.rows[0]?.count || 0, 10),
      conversion: totalRes.rows[0]?.count ? ((parseInt(completedRes.rows[0]?.count||0)/parseInt(totalRes.rows[0]?.count||1))*100).toFixed(1) : 0
    };
    res.json({ revenue, funnel, trend: trendRes.rows, range });
  } catch (err) {
    console.error('Analytics error', err);
    res.status(500).json({ error: 'Analytics failed' });
  }
});

// Audit log — paginated
router.get('/admin/audit-log', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page,10)||1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit,10)||20));
    const offset = (page-1)*limit;
    const action = (req.query.action||'').trim();
    let where = '';
    let params = [];
    if (action) { where = 'WHERE action = $1'; params = [action]; }
    const countRes = await db.query(`SELECT COUNT(*) as total FROM audit_log ${where}`, params);
    const total = parseInt(countRes.rows[0]?.total || countRes.rows[0]?.count || 0, 10);
    const dataRes = await db.query(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ logs: dataRes.rows, total, page, limit, totalPages: Math.ceil(total/limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Audit log failed' }); }
});

// Invoices — list with pagination
router.get('/invoices', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page,10)||1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit,10)||20));
    const offset = (page-1)*limit;
    const phone = (req.query.phone||'').trim();
    let where = '';
    let params = [];
    if (phone) { where = 'WHERE patient_phone LIKE $1'; params = [`%${phone.replace(/[^0-9]/g,'')}%`]; }
    const countRes = await db.query(`SELECT COUNT(*) as total FROM invoices ${where}`, params);
    const total = parseInt(countRes.rows[0]?.total || countRes.rows[0]?.count || 0, 10);
    const { rows } = await db.query(`SELECT * FROM invoices ${where} ORDER BY id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    res.json({ invoices: rows, total, page, limit });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Invoices failed' }); }
});

router.post('/invoices', async (req, res) => {
  const schema = Joi.object({
    request_id: Joi.number().integer().allow(null),
    patient_phone: Joi.string().required(),
    amount: Joi.number().min(0).required(),
    discount: Joi.number().min(0).default(0),
    tax: Joi.number().min(0).default(0),
    gateway: Joi.string().valid('razorpay','cod','manual','free').default('manual')
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  const total = (parseFloat(value.amount) - parseFloat(value.discount) + parseFloat(value.tax)).toFixed(2);
  try {
    const { rows } = await db.query(
      `INSERT INTO invoices (request_id, patient_phone, amount, discount, tax, total, status, gateway) VALUES ($1,$2,$3,$4,$5,$6,'paid',$7) RETURNING *`,
      [value.request_id, value.patient_phone, value.amount, value.discount, value.tax, total, value.gateway]
    );
    await logAudit({ actor: req.user, action: 'invoice:create', entity_type: 'invoice', entity_id: rows[0]?.id, meta: value, ip: req.ip });
    res.status(201).json({ success: true, invoice: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Invoice failed' }); }
});

// Ratings
router.post('/ratings', async (req, res) => {
  const schema = Joi.object({
    request_id: Joi.number().integer().required(),
    patient_phone: Joi.string().required(),
    doctor_id: Joi.number().integer().allow(null),
    stars: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().max(500).allow('', null)
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const { rows } = await db.query(
      `INSERT INTO ratings (request_id, patient_phone, doctor_id, stars, comment) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [value.request_id, value.patient_phone.replace(/[^0-9]/g,''), value.doctor_id, value.stars, value.comment]
    );
    await logAudit({ actor: req.user, action: 'rating:create', entity_type: 'rating', entity_id: rows[0].id, ip: req.ip });
    res.status(201).json({ success: true, rating: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Rating failed' }); }
});
router.get('/ratings', async (req, res) => {
  try {
    const doctor_id = req.query.doctor_id;
    const phone = req.query.phone;
    let where = '';
    let params = [];
    if (doctor_id) { where = 'WHERE doctor_id = $1'; params = [doctor_id]; }
    else if (phone) { where = 'WHERE patient_phone = $1'; params = [phone]; }
    const { rows } = await db.query(`SELECT * FROM ratings ${where} ORDER BY id DESC LIMIT 50`, params);
    const avgRes = doctor_id ? await db.query('SELECT AVG(stars) as avg, COUNT(*) as count FROM ratings WHERE doctor_id = $1', [doctor_id]) : { rows: [] };
    res.json({ ratings: rows, avg: avgRes.rows[0]?.avg || null, count: avgRes.rows[0]?.count || 0 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ratings fetch failed' }); }
});

// Notifications
router.get('/notifications/:phone', async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[^0-9]/g,'');
    const { rows } = await db.query('SELECT * FROM notifications WHERE user_phone = $1 ORDER BY id DESC LIMIT 30', [phone]);
    const unreadRes = await db.query('SELECT COUNT(*) as count FROM notifications WHERE user_phone = $1 AND read = FALSE', [phone]);
    // sqlite uses 0/1 for boolean
    const unread = parseInt(unreadRes.rows[0]?.count || 0,10);
    res.json({ notifications: rows, unread });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Notifications failed' }); }
});
router.post('/notifications/mark-read', async (req, res) => {
  const { phone, ids } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const clean = phone.replace(/[^0-9]/g,'');
  try {
    if (Array.isArray(ids) && ids.length) {
      await db.query(`UPDATE notifications SET read = TRUE WHERE user_phone = $1 AND id = ANY($2)`, [clean, ids]).catch(async()=>{
        // sqlite fallback
        for(const id of ids) await db.query('UPDATE notifications SET read = 1 WHERE user_phone = $1 AND id = $2', [clean, id]);
      });
    } else {
      await db.query('UPDATE notifications SET read = TRUE WHERE user_phone = $1', [clean]).catch(async()=>{
        await db.query('UPDATE notifications SET read = 1 WHERE user_phone = $1', [clean]);
      });
    }
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Mark read failed' }); }
});
// Helper to create notification (internal)
router.post('/notifications', async (req, res) => {
  const schema = Joi.object({
    user_phone: Joi.string().required(),
    channel: Joi.string().valid('wa','sms','email','in_app').default('in_app'),
    title: Joi.string().required(),
    body: Joi.string().allow('', null)
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const { rows } = await db.query('INSERT INTO notifications (user_phone, channel, title, body, read) VALUES ($1,$2,$3,$4,FALSE) RETURNING *', [value.user_phone.replace(/[^0-9]/g,''), value.channel, value.title, value.body]);
    try { const rt = require('../services/realtime'); rt.broadcast(`user:${value.user_phone.replace(/[^0-9]/g,'')}`, 'notification:new', { notification: rows[0] }); } catch(e){}
    res.status(201).json({ success: true, notification: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Notify failed' }); }
});

// Zones
router.get('/zones', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM zones WHERE active = TRUE ORDER BY city, pincode');
    res.json({ zones: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Zones failed' }); }
});

// Doctor slots
router.get('/doctor/slots', async (req, res) => {
  try {
    const doctor_id = req.query.doctor_id;
    const date = req.query.date;
    if (!doctor_id || !date) return res.status(400).json({ error: 'doctor_id and date required' });
    const { rows } = await db.query('SELECT * FROM doctor_slots WHERE doctor_id = $1 AND slot_date = $2 ORDER BY start_time', [doctor_id, date]);
    res.json({ slots: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Slots failed' }); }
});
router.post('/doctor/slots', async (req, res) => {
  const schema = Joi.object({
    doctor_id: Joi.number().integer().required(),
    slot_date: Joi.string().required(),
    start_time: Joi.string().required(),
    end_time: Joi.string().required()
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const { rows } = await db.query('INSERT INTO doctor_slots (doctor_id, slot_date, start_time, end_time) VALUES ($1,$2,$3,$4) RETURNING *', [value.doctor_id, value.slot_date, value.start_time, value.end_time]);
    res.status(201).json({ success: true, slot: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Slot create failed' }); }
});

// Prescriptions — structured
router.post('/prescriptions', async (req, res) => {
  const schema = Joi.object({
    request_id: Joi.number().integer().required(),
    doctor_id: Joi.number().integer().required(),
    medicines: Joi.array().items(Joi.object({ drug: Joi.string().required(), dose: Joi.string().allow('',null), frequency: Joi.string().allow('',null), duration: Joi.string().allow('',null), instructions: Joi.string().allow('',null) })).min(1).required(),
    instructions: Joi.string().allow('', null),
    follow_up_days: Joi.number().integer().allow(null)
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });
  try {
    const { rows } = await db.query('INSERT INTO prescriptions (request_id, doctor_id, medicines, instructions, follow_up_days) VALUES ($1,$2,$3,$4,$5) RETURNING *', [value.request_id, value.doctor_id, JSON.stringify(value.medicines), value.instructions, value.follow_up_days]);
    // also update request
    await db.query("UPDATE requests SET prescription_text = $1, status = 'prescribed', updated_at = now() WHERE id = $2", [JSON.stringify(value.medicines), value.request_id]);
    await logAudit({ actor: req.user, action: 'prescription:create', entity_type: 'request', entity_id: value.request_id, meta: value, ip: req.ip });
    res.status(201).json({ success: true, prescription: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Prescription failed' }); }
});
router.get('/prescriptions/:request_id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM prescriptions WHERE request_id = $1 ORDER BY id DESC LIMIT 5', [req.params.request_id]);
    res.json({ prescriptions: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Fetch failed' }); }
});

// Onboarding list paginated (upgrade existing)
router.get('/onboarding/list-paginated', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page,10)||1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit,10)||10));
    const offset = (page-1)*limit;
    const status = req.query.status;
    const q = (req.query.q||'').trim();
    let where = [];
    let params = [];
    let idx=1;
    if (status && status!=='all') { where.push(`status = $${idx}`); params.push(status); idx++; }
    if (q) { where.push(`(LOWER(candidate_name) LIKE LOWER($${idx}) OR candidate_phone LIKE $${idx})`); params.push(`%${q}%`); idx++; }
    const whereClause = where.length ? 'WHERE '+where.join(' AND ') : '';
    const countRes = await db.query(`SELECT COUNT(*) as total FROM staff_onboarding ${whereClause}`, params);
    const total = parseInt(countRes.rows[0]?.total || countRes.rows[0]?.count || 0, 10);
    const { rows } = await db.query(`SELECT * FROM staff_onboarding ${whereClause} ORDER BY id DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params, limit, offset]);
    res.json({ requests: rows, candidates: rows, total, page, limit, totalPages: Math.ceil(total/limit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'List failed' }); }
});

module.exports = router;

