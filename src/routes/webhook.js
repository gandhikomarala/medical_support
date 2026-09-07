const express = require('express');
const router = express.Router();
const db = require('../db');
const wa = require('../services/whatsapp');
const groq = require('../services/groq');
const requestService = require('../services/requestService');

// Gupshup posts inbound messages here. Shape verified against Gupshup's
// "Inbound Message" webhook format — re-check against your dashboard's
// sample payload if this doesn't line up (Gupshup has multiple webhook modes).
router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200); // ack immediately, process after

  try {
    const payload = req.body.payload || {};
    const senderPhone = payload.sender?.phone || payload.source;
    const type = payload.type; // 'text' | 'image' | 'document' ...
    const text = payload.payload?.text;
    const mediaUrl = payload.payload?.url;

    if (!senderPhone) return;

    const doctor = await findByPhone('doctors', senderPhone);
    const technician = await findByPhone('technicians', senderPhone);

    if (doctor) {
      return handleDoctorMessage(doctor, type, text);
    }
    if (technician) {
      return handleTechnicianMessage(technician, type, text, mediaUrl);
    }
    // Otherwise treat as a patient (or unknown number) reaching out directly.
    return handlePatientMessage(senderPhone, text);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

async function findByPhone(table, phone) {
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE phone = $1`, [phone]);
  return rows[0] || null;
}

async function handleDoctorMessage(doctor, type, text) {
  if (type !== 'text' || !text) return;

  const acceptMatch = text.trim().match(/^ACCEPT\s+(\d+)$/i);
  if (acceptMatch) {
    return requestService.handleDoctorAccept(doctor.phone, Number(acceptMatch[1]));
  }

  // Otherwise, assume this is a prescription/lab-test message for whichever
  // request is currently assigned to this doctor and awaiting a prescription.
  const { rows } = await db.query(
    `SELECT id FROM requests WHERE assigned_doctor_id = $1 AND status = 'doctor_assigned' ORDER BY created_at DESC LIMIT 1`,
    [doctor.id]
  );
  if (rows[0]) {
    return requestService.handleDoctorPrescription(doctor.phone, rows[0].id, text);
  }
  await wa.sendText(doctor.phone, `I don't see an open patient waiting on your prescription right now.`);
}

async function handleTechnicianMessage(tech, type, text, mediaUrl) {
  if (type === 'image' || type === 'document') {
    const { rows } = await db.query(
      `SELECT id FROM requests WHERE assigned_technician_id = $1 AND status = 'technician_assigned' ORDER BY created_at DESC LIMIT 1`,
      [tech.id]
    );
    if (rows[0]) return requestService.handleReportUpload(tech.phone, rows[0].id, mediaUrl);
    await wa.sendText(tech.phone, `Got your file, but I couldn't match it to an open pickup. Please mention the request number.`);
    return;
  }

  if (type === 'text' && text) {
    const explicitMatch = text.trim().match(/#?(\d+)/);
    const { rows } = await db.query(
      `SELECT id FROM requests WHERE status = 'lab_requested' ${explicitMatch ? 'AND id = $1' : ''} ORDER BY created_at DESC LIMIT 1`,
      explicitMatch ? [Number(explicitMatch[1])] : []
    );
    if (rows[0]) return requestService.handleTechnicianTimeReply(tech.phone, rows[0].id, text);
    await wa.sendText(tech.phone, `I don't see an open lab pickup waiting on you right now.`);
  }
}

async function handlePatientMessage(phone, text) {
  if (!text) return;
  const { rows } = await db.query(
    `SELECT id, status, service_type FROM requests WHERE patient_phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const context = rows[0] ? `Request #${rows[0].id}, status: ${rows[0].status}` : null;
  const reply = await groq.assistantReply(text, context);
  await wa.sendText(phone, reply);
}

module.exports = router;
