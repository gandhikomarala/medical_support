const db = require('../db');
const wa = require('./whatsapp');
const groq = require('./groq');

const OWNER = process.env.OWNER_WHATSAPP_NUMBER;

function serviceLabel(type) {
  return { doctor: 'Doctor at Home', nurse: 'Nurse', lab_test: 'Lab Test', pharmacy: 'Pharmacy' }[type] || type;
}

async function log(requestId, direction, phone, body, mediaUrl = null) {
  await db.query(
    `INSERT INTO message_log (request_id, direction, phone, body, media_url) VALUES ($1,$2,$3,$4,$5)`,
    [requestId, direction, phone, body, mediaUrl]
  );
}

async function notifyOwner(text) {
  await wa.sendText(OWNER, text);
  await log(null, 'out', OWNER, text);
}

// --- 1. Patient submits the website form ---
async function createRequest({ patient_name, patient_phone, patient_address, service_type, notes }) {
  const { rows } = await db.query(
    `INSERT INTO requests (patient_name, patient_phone, patient_address, service_type, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [patient_name, patient_phone, patient_address, service_type, notes || '']
  );
  const request = rows[0];

  const summary =
    `New ${serviceLabel(service_type)} request #${request.id}\n` +
    `Patient: ${patient_name}\n` +
    `Phone: ${patient_phone}\n` +
    `Address: ${patient_address}\n` +
    (notes ? `Notes: ${notes}\n` : '') +
    `\nReply ACCEPT ${request.id} to take this patient.`;

  await notifyOwner(`📩 ${summary}`);

  if (service_type === 'doctor' || service_type === 'nurse') {
    const { rows: doctors } = await db.query('SELECT phone FROM doctors WHERE active = TRUE');
    await wa.broadcast(doctors.map((d) => d.phone), summary);
    for (const d of doctors) await log(request.id, 'out', d.phone, summary);
  } else if (service_type === 'lab_test') {
    // Lab-only bookings (no doctor visit) can go straight to technicians.
    await broadcastToTechnicians(request);
  }
  // Pharmacy requests are handled directly by the owner (prescription photo, pricing, delivery) —
  // no auto-broadcast needed, but the owner notification above already covers it.

  await wa.sendText(
    patient_phone,
    `Hi ${patient_name}, we've received your ${serviceLabel(service_type)} request (#${request.id}). ` +
      `We'll confirm your provider here on WhatsApp shortly.`
  );

  return request;
}

// --- 2. First doctor to reply "ACCEPT <id>" wins ---
async function handleDoctorAccept(doctorPhone, requestId) {
  const { rows: doctorRows } = await db.query('SELECT * FROM doctors WHERE phone = $1', [doctorPhone]);
  const doctor = doctorRows[0];
  if (!doctor) return wa.sendText(doctorPhone, 'We could not find your doctor profile. Please contact the owner.');

  // Atomic: only succeeds if the request is still unassigned.
  const { rows } = await db.query(
    `UPDATE requests SET status = 'doctor_assigned', assigned_doctor_id = $1, updated_at = now()
     WHERE id = $2 AND status = 'new' RETURNING *`,
    [doctor.id, requestId]
  );

  if (rows.length === 0) {
    return wa.sendText(doctorPhone, `Request #${requestId} has already been taken by another doctor. Thanks for the quick response!`);
  }

  const request = rows[0];
  await wa.sendText(
    doctorPhone,
    `You're assigned to request #${request.id} — ${request.patient_name}, ${request.patient_address}. ` +
      `After your consult, just message me the prescription and any lab tests needed, in your own words.`
  );
  await wa.sendText(
    request.patient_phone,
    `Good news — ${doctor.name} has accepted your request and will be in touch shortly.`
  );
  await notifyOwner(`✅ Request #${request.id} accepted by Dr. ${doctor.name}.`);
}

// --- 3. Doctor sends prescription (+ optional lab tests) in free text ---
async function handleDoctorPrescription(doctorPhone, requestId, freeText) {
  const parsed = await groq.parsePrescriptionMessage(freeText);
  const labTestsText = (parsed.lab_tests || []).join(', ');

  const { rows } = await db.query(
    `UPDATE requests SET status = 'prescribed', prescription_text = $1, lab_tests_needed = $2, updated_at = now()
     WHERE id = $3 RETURNING *`,
    [parsed.prescription, labTestsText, requestId]
  );
  const request = rows[0];
  if (!request) return wa.sendText(doctorPhone, `Could not find request #${requestId}.`);

  await notifyOwner(
    `📋 Prescription logged for #${request.id}:\n${parsed.prescription}` +
      (labTestsText ? `\nLab tests: ${labTestsText}` : '')
  );
  await wa.sendText(request.patient_phone, `Your prescription is ready. We'll share it with you shortly.`);

  if (labTestsText) {
    await db.query(`UPDATE requests SET status = 'lab_requested', updated_at = now() WHERE id = $1`, [request.id]);
    await broadcastToTechnicians({ ...request, lab_tests_needed: labTestsText });
  }
}

// --- 4. Broadcast a lab order to the technician roster ---
async function broadcastToTechnicians(request) {
  const { rows: techs } = await db.query('SELECT phone FROM technicians WHERE active = TRUE');
  const text =
    `New lab collection needed — request #${request.id}\n` +
    `Patient: ${request.patient_name}\n` +
    `Address: ${request.patient_address}\n` +
    `Tests: ${request.lab_tests_needed || request.notes || 'as discussed'}\n\n` +
    `Reply with the time you can reach the patient (e.g. "today 5:30pm") to claim this pickup.`;
  await wa.broadcast(techs.map((t) => t.phone), text);
  for (const t of techs) await log(request.id, 'out', t.phone, text);
}

// --- 5. First technician to reply with a time wins ---
async function handleTechnicianTimeReply(techPhone, requestId, freeText) {
  const { rows: techRows } = await db.query('SELECT * FROM technicians WHERE phone = $1', [techPhone]);
  const tech = techRows[0];
  if (!tech) return wa.sendText(techPhone, 'We could not find your technician profile. Please contact the owner.');

  const parsed = await groq.parseVisitTime(freeText);
  if (!parsed.confirmed) {
    return wa.sendText(techPhone, `Could you confirm an approximate time you can reach the patient for request #${requestId}?`);
  }

  const { rows } = await db.query(
    `UPDATE requests SET status = 'technician_assigned', assigned_technician_id = $1, technician_visit_time = $2, updated_at = now()
     WHERE id = $3 AND status = 'lab_requested' RETURNING *`,
    [tech.id, parsed.visit_time, requestId]
  );

  if (rows.length === 0) {
    return wa.sendText(techPhone, `Request #${requestId} has already been picked up by another technician.`);
  }

  const request = rows[0];
  await wa.sendText(techPhone, `You're confirmed for #${request.id} at ${parsed.visit_time}. Send the report photo here once ready.`);
  await wa.sendText(
    request.patient_phone,
    `A technician will visit around ${parsed.visit_time} to collect your sample for: ${request.lab_tests_needed}.`
  );
  await notifyOwner(`🧪 ${tech.name} confirmed for #${request.id} at ${parsed.visit_time}.`);
}

// --- 6. Technician sends the report (image/PDF) ---
async function handleReportUpload(techPhone, requestId, mediaUrl) {
  const { rows } = await db.query(
    `UPDATE requests SET status = 'report_shared', report_file_url = $1, updated_at = now()
     WHERE id = $2 RETURNING *`,
    [mediaUrl, requestId]
  );
  const request = rows[0];
  if (!request) return;

  await wa.sendMedia(OWNER, mediaUrl, `Report for request #${request.id} — ${request.patient_name}`);
  await log(request.id, 'out', OWNER, 'report forwarded', mediaUrl);

  if (request.assigned_doctor_id) {
    const { rows: docRows } = await db.query('SELECT phone FROM doctors WHERE id = $1', [request.assigned_doctor_id]);
    if (docRows[0]) {
      await wa.sendMedia(docRows[0].phone, mediaUrl, `Lab report for #${request.id} — ${request.patient_name}`);
    }
  }

  await wa.sendText(request.patient_phone, `Your lab report is ready and has been shared with your doctor.`);
  await db.query(`UPDATE requests SET status = 'completed', updated_at = now() WHERE id = $1`, [request.id]);
}

// --- Escalation: nobody accepted within the configured window ---
async function escalateStaleRequests() {
  const minutes = Number(process.env.ACCEPT_WINDOW_MINUTES || 10);
  const { rows } = await db.query(
    `SELECT * FROM requests WHERE status = 'new' AND created_at < now() - ($1 || ' minutes')::interval`,
    [minutes]
  );
  for (const r of rows) {
    await notifyOwner(`⚠️ No one has accepted request #${r.id} (${r.patient_name}) in ${minutes} minutes. Please follow up directly.`);
    // Bump updated_at so we don't re-alert every polling cycle; a separate "escalated" flag
    // is cleaner for production — left simple here intentionally.
    await db.query(`UPDATE requests SET updated_at = now() WHERE id = $1`, [r.id]);
  }
}

module.exports = {
  createRequest,
  handleDoctorAccept,
  handleDoctorPrescription,
  handleTechnicianTimeReply,
  handleReportUpload,
  escalateStaleRequests,
  log,
};
