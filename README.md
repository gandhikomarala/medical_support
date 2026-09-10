# Nhealth — Healthcare at Home | Full-Stack Healthcare Platform & WhatsApp Automation

Nhealth provides home healthcare services (Doctor at Home, Nursing, Lab Tests, and Pharmacy Delivery) across Vijayawada, Bapatla, and Guntur districts.

This repository contains the complete full-stack platform:
1. **Modern Frontend Website**: Clean, accessible landing page with an interactive booking modal and direct WhatsApp links.
2. **Node.js/Express Backend**: End-to-end orchestration engine managing patient requests, first-accept-wins doctor dispatch, and technician scheduling.
3. **Dual Database Architecture**: Seamless support for Neon Cloud PostgreSQL with automatic zero-config local SQLite fallback.
4. **Groq AI Engine**: Natural language parsing for casual doctor WhatsApp prescriptions, technician arrival times, and conversational patient assistance.
5. **Gupshup WhatsApp Integration**: Inbound webhook processing and outbound automated notifications with built-in development sandbox mode.

---

## Architecture & Workflow

1. **Patient Booking**:
   - Patient visits the website (`http://localhost:3000`) and fills out the on-page booking form or taps "Chat on WhatsApp".
   - The form submits a `POST /api/requests` payload to the backend.
2. **Instant Coordination**:
   - The backend records the request in PostgreSQL (`requests` table).
   - An alert is dispatched to the healthcare owner and broadcast to available doctors.
3. **First-Doctor-Wins Dispatch**:
   - The first doctor replying `ACCEPT <id>` on WhatsApp is locked in; subsequent responses receive polite notices that the visit has been claimed.
   - The patient receives an automated confirmation with their assigned doctor's details.
4. **AI-Powered Prescription & Lab Tests**:
   - The visiting doctor messages their consultation notes in natural language.
   - Groq AI extracts the formal prescription text and identifies any ordered lab tests (e.g. CBC, Thyroid, Blood Sugar).
5. **Automated Technician Dispatch**:
   - Ordered lab tests are broadcast to the technician roster.
   - The first technician to reply with an arrival time is confirmed, with Groq normalizing casual time strings (e.g., "Today, 5:30 PM").
6. **Report Delivery & Audit Trail**:
   - Technician submits the completed report photo/document via WhatsApp.
   - The report is forwarded to the owner, doctor, and patient, closing the request lifecycle.
   - Every incoming and outgoing message is logged in `message_log` for a full audit trail.

---

## Project Structure

```
nhealth/
├── public/
│   └── index.html             # Website frontend with interactive booking modal
├── src/
│   ├── server.js              # Express app serving static frontend & API
│   ├── db.js                  # Database adapter (Neon PostgreSQL + SQLite fallback)
│   ├── routes/
│   │   ├── api.js             # Booking creation & status lookup endpoints
│   │   └── webhook.js         # Gupshup WhatsApp inbound webhook handlers
│   ├── services/
│   │   ├── groq.js            # Groq AI parsing & assistant integration
│   │   ├── requestService.js  # Core request lifecycle & escalation state machine
│   │   └── whatsapp.js        # WhatsApp messaging client with sandbox fallback
│   └── scripts/
│       └── initDb.js          # Database schema migration & seed script
├── schema.sql                 # PostgreSQL database schema
├── .env.example               # Template environment configuration
├── package.json
└── README.md
```

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Set your credentials in `.env`:
- `DATABASE_URL`: Your PostgreSQL connection string (e.g. Neon PostgreSQL). If left blank, the app will automatically use a local SQLite database in `data/`.
- `GROQ_API_KEY`: Your Groq API key (uses `qwen/qwen3.8-27b` or `groq/compound-mini`).
- `GUPSHUP_API_KEY`: Your Gupshup WhatsApp Business API key.

### 3. Initialize Database
```bash
npm run db:init
```

### 4. Run Server
```bash
npm start
# or development watch mode:
npm run dev
```

Visit **`http://localhost:3000`** in your browser to view the live website and test the booking flow.

---

## API Reference

### Create Booking
- **POST** `/api/requests`
```json
{
  "patient_name": "Lakshmi Devi",
  "patient_phone": "919959461095",
  "patient_address": "Governorpet, Vijayawada",
  "service_type": "doctor",
  "notes": "Elderly consultation and fasting blood sugar"
}
```
*Valid `service_type` values:* `doctor`, `nurse`, `lab_test`, `pharmacy`.

### Get Request Status
- **GET** `/api/requests/:id`

### List Recent Requests
- **GET** `/api/requests`

### Health Check
- **GET** `/health`
Returns server status, active database engine, and timestamp.
