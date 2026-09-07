-- Ayans Medicare: core schema
-- Run this once against your Postgres database before starting the server.

CREATE TABLE IF NOT EXISTS doctors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,      -- WhatsApp number in international format, e.g. 919XXXXXXXXX
  specialty TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS technicians (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every patient request moves through this state machine:
-- new -> doctor_assigned -> prescribed -> lab_requested -> technician_assigned
--     -> sample_collected -> report_shared -> completed
-- (lab_requested/technician_assigned/sample_collected/report_shared are skipped
--  if the doctor doesn't order any lab test)
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  patient_address TEXT NOT NULL,
  service_type TEXT NOT NULL,       -- doctor | nurse | lab_test | pharmacy
  notes TEXT,                       -- symptoms / what the patient typed on the site
  status TEXT NOT NULL DEFAULT 'new',

  assigned_doctor_id INTEGER REFERENCES doctors(id),
  assigned_technician_id INTEGER REFERENCES technicians(id),

  prescription_text TEXT,
  lab_tests_needed TEXT,
  technician_visit_time TEXT,       -- free text as parsed from the technician's WhatsApp reply
  report_file_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full audit trail of every WhatsApp message sent/received, tied to a request where known.
CREATE TABLE IF NOT EXISTS message_log (
  id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES requests(id),
  direction TEXT NOT NULL,          -- 'in' | 'out'
  phone TEXT NOT NULL,
  body TEXT,
  media_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_message_log_request ON message_log(request_id);
