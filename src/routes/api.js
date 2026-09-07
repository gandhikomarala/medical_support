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
// 1. SERVICES CATALOG & PATIENT REQUESTS
// ==========================================

const SERVICES_CATALOG = [
  {
    id: 'gp_home',
    type: 'doctor',
    title: 'General Physician Home Consult',
    category: 'Doctor at Home',
    price: 699,
    duration: '30-45 mins',
    badge: 'Most Popular',
    description: 'MBBS Doctor visits your home for physical examination, symptom diagnosis, and digital Rx.',
    features: ['In-person clinical checkup', 'Vitals & BP monitoring', 'Instant digital Rx & lab orders', 'Zero travel stress']
  },
  {
    id: 'specialist_video',
    type: 'doctor',
    title: 'Specialist Telehealth Consultation',
    category: 'Video Tele-Consult',
    price: 899,
    duration: '20-30 mins',
    badge: 'Instant Connect',
    description: 'Private 1-on-1 video call with senior specialist doctors (Cardiology, Pediatrics, General Medicine).',
    features: ['Direct video consultation', 'Encrypted private meeting room', 'Digital prescription delivery', 'Follow-up chat support']
  },
  {
    id: 'nurse_care',
    type: 'nurse',
    title: 'Home Nursing & Injection / IV Saline',
    category: 'Nursing Services',
    price: 499,
    duration: '30 mins',
    badge: 'Clinical Care',
    description: 'Certified nurse for IV drip cannula, intramuscular injections, wound dressing, and post-hospital care.',
    features: ['Certified clinical nurse', 'Sterile disposable equipment', 'Post-surgical dressing', 'IV/IM medication administration']
  },
  {
    id: 'full_body_lab',
    type: 'lab_test',
    title: 'Comprehensive Full-Body Health Checkup',
    category: 'Diagnostics & Lab',
    price: 1299,
    duration: 'Home sample pickup',
    badge: 'Best Value',
    description: '72+ vital parameters: Complete Hemogram (CBC), Lipid profile, Liver (LFT), Kidney (KFT), Thyroid (TSH), Blood Sugar.',
    features: ['Doorstep blood/urine sample collection', 'Certified phlebotomist visit', 'NABL accredited lab processing', 'Digital PDF report in portal']
  },
  {
    id: 'elderly_care',
    type: 'nurse',
    title: 'Senior Citizen Health & Vitals Monitoring',
    category: 'Elderly Support',
    price: 799,
    duration: '60 mins',
    badge: 'Senior Support',
    description: 'Comprehensive routine vitals, mobility check, blood sugar, ECG/pulse tracking, and medicine organization.',
    features: ['Blood pressure & SPO2 check', 'Random blood sugar test', 'Medication schedule review', 'Compassionate elder care']
  },
  {
    id: 'express_pharmacy',
    type: 'pharmacy',
    title: 'Doorstep Medicine & Pharmacy Delivery',
    category: 'Pharmacy',
    price: 199,
    duration: 'Within 2 hours',
    badge: 'Fast Delivery',
    description: 'Upload your doctor prescription; our licensed pharmacy dispenses and delivers original medicines right to your home.',
    features: ['Genuine 100% verified medicines', 'Express 2-hour delivery', 'Temperature-controlled pack', 'Direct billing assistance']
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

// Admin generate and dispatch private consultation video meet link
router.post('/admin/generate-meet', async (req, res) => {
  const { request_id, custom_meet_link } = req.body;
  if (!request_id) {
    return res.status(400).json({ error: 'request_id is required.' });
  }

  try {
    const crypto = require('crypto');
    const roomId = 'ayans-telehealth-' + request_id + '-' + crypto.randomBytes(3).toString('hex');
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
        `Ayans Medicare Telehealth Consultation Ready!\nPatient: ${reqData.patient_name}\nAddress: ${reqData.patient_address}\nJoin Secure Room: ${meetUrl}`
      );
    }
    if (reqData.patient_phone) {
      await wa.sendText(
        reqData.patient_phone,
        `Ayans Medicare: Your private consultation room with Dr. ${doctorName} is ready!\nJoin Video Call: ${meetUrl}\nPlease do not share this private link.`
      );
    }

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
       WHERE status = 'new' AND (service_type = 'doctor' OR service_type = 'nurse')
       ORDER BY id DESC LIMIT 50`
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error('Available requests error:', err);
    res.status(500).json({ error: 'Failed to fetch available requests' });
  }
});

// Atomic acceptance: First doctor to accept claims the patient
router.post('/doctor/accept-request', async (req, res) => {
  const { doctor_phone, request_id } = req.body;
  if (!doctor_phone || !request_id) {
    return res.status(400).json({ error: 'doctor_phone and request_id are required.' });
  }

  try {
    const cleanPhone = doctor_phone.replace(/[^0-9]/g, '');
    const { rows: docRows } = await db.query(
      'SELECT id, name FROM doctors WHERE phone LIKE $1',
      [`%${cleanPhone}%`]
    );
    const doctor = docRows[0];
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
