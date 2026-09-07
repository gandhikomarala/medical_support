const express = require('express');
const router = express.Router();
const requestService = require('../services/requestService');
const db = require('../db');

// List recent requests (useful for admin/dashboard check)
router.get('/requests', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, patient_name, patient_phone, patient_address, service_type, status, technician_visit_time, created_at FROM requests ORDER BY id DESC LIMIT 50'
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Called by the website booking form
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

// Simple status check the website can poll
router.get('/requests/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, patient_name, service_type, status, technician_visit_time, created_at FROM requests WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
