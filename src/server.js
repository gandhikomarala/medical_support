const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const apiRoutes = require('./routes/api');
const webhookRoutes = require('./routes/webhook');
const requestService = require('./services/requestService');
const db = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend files from /public
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));

// API and Webhook routes
app.use('/api', apiRoutes);
app.use('/webhook', webhookRoutes);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Ayans Medicare Backend',
    database: db.isSqlite ? 'SQLite (local)' : 'PostgreSQL',
    timestamp: new Date().toISOString()
  });
});

// Fallback to index.html for root or SPA navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('======================================================');
  console.log(` Ayans Medicare server is running on http://localhost:${PORT}`);
  console.log(` Website Frontend: http://localhost:${PORT}/`);
  console.log(` API Health check: http://localhost:${PORT}/health`);
  console.log(` Database Engine: ${db.isSqlite ? 'SQLite (local file)' : 'PostgreSQL'}`);
  console.log('======================================================');
});

// Periodic stale escalation check
setInterval(() => {
  requestService.escalateStaleRequests().catch((err) => console.error('Escalation check failed:', err.message));
}, 2 * 60 * 1000);
