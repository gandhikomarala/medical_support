const path = require('path');
const zlib = require('zlib');
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
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://accounts.google.com", "https://apis.google.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https:", "https://*.googleusercontent.com"],
        connectSrc: ["'self'", "https:", "wss:", "ws:", "https://accounts.google.com"],
        frameSrc: ["'self'", "https://meet.jit.si", "https://accounts.google.com"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use(cors({ origin: true, credentials: true }));

// High-Speed GZIP Compression Middleware (HTML, JSON, JS, CSS)
app.use((req, res, next) => {
  const accept = req.headers['accept-encoding'] || '';
  if (!accept.includes('gzip')) return next();
  if (req.headers['upgrade'] || req.url.startsWith('/ws')) return next();

  const origSend = res.send;
  const origJson = res.json;

  res.send = function (body) {
    if ((typeof body === 'string' || Buffer.isBuffer(body)) && !res.getHeader('Content-Encoding')) {
      if (body.length > 512) {
        try {
          const zipped = zlib.gzipSync(body, { level: 6 });
          res.setHeader('Content-Encoding', 'gzip');
          res.removeHeader('Content-Length');
          return origSend.call(this, zipped);
        } catch (e) {}
      }
    }
    return origSend.call(this, body);
  };

  res.json = function (obj) {
    if (!res.getHeader('Content-Encoding')) {
      try {
        const jsonStr = JSON.stringify(obj);
        if (jsonStr.length > 512) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Encoding', 'gzip');
          res.removeHeader('Content-Length');
          const zipped = zlib.gzipSync(jsonStr, { level: 6 });
          return origSend.call(this, zipped);
        }
      } catch (e) {}
    }
    return origJson.call(this, obj);
  };

  next();
});

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
  app.use(express.static(publicPath, {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      }
    }
  }));
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
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=86400');
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
