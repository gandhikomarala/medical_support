const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const requestService = require('./services/requestService');
const realtime = require('./services/realtime');
const db = require('./db');
const { authMiddleware } = require('./middleware/auth');

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https:", "wss:", "ws:"],
        frameSrc: ["'self'", "https://meet.jit.si"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
// Global JWT attach (non-blocking)
app.use(authMiddleware);
// Rate limiter for APIs
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// Serve static frontend files from /public if directory exists
const publicPath = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// Serve uploaded patient reports from /uploads
const uploadsPath = path.join(__dirname, '..', 'uploads');
if (fs.existsSync(uploadsPath)) {
  app.use('/uploads', express.static(uploadsPath));
}

// API and Auth routes (support with and without /api prefix)
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use(apiRoutes);
app.use('/webhook', webhookRoutes);

app.get('/health', (req, res) => {
  const rtStats = realtime.getStats();
  res.json({
    ok: true,
    service: 'Nhealth Backend',
    database: db.isSqlite ? 'SQLite (local)' : 'PostgreSQL',
    realtime: rtStats,
    timestamp: new Date().toISOString()
  });
});

// Fallback for SPA or direct navigation without crashing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.path.startsWith('/ws')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  const file = req.path.startsWith('/portal') ? 'portal.html' : 'index.html';
  const filePath = path.join(publicPath, file);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.redirect('/');
});

// Only bind port, attach WebSocket server, and start recurring timers when run directly in Node (not serverless)
if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(app);

  // Attach WebSocket Hub to HTTP server
  try {
    realtime.initRealtime(server);
  } catch (err) {
    console.warn('Realtime init error:', err.message);
  }

  server.listen(PORT, () => {
    console.log('======================================================');
    console.log(` Nhealth server is running on http://localhost:${PORT}`);
    console.log(` Website Frontend: http://localhost:${PORT}/`);
    console.log(` Management Portal: http://localhost:${PORT}/portal.html`);
    console.log(` Real-time WebSocket: ws://localhost:${PORT}/ws`);
    console.log(` API Health check: http://localhost:${PORT}/health`);
    console.log(` Database Engine: ${db.isSqlite ? 'SQLite (local file)' : 'PostgreSQL'}`);
    console.log('======================================================');
  });

  // Periodic stale escalation check
  setInterval(() => {
    requestService.escalateStaleRequests().catch((err) => console.error('Escalation check failed:', err.message));
  }, 2 * 60 * 1000);
}

module.exports = app;
