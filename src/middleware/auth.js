const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nhealth_jwt_secret_2026_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES || '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next(); // allow anonymous for public routes; protect via authorize()
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    // invalid token - keep anonymous but mark
    req.user = null;
    req.authError = err.message;
  }
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required. Please login.' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden: ${roles.join('/')} role required.` });
    }
    next();
  };
}

// Optional: log audit
async function logAudit({ actor, action, entity_type, entity_id, meta, ip }) {
  try {
    const db = require('../db');
    const actorId = actor?.id || null;
    const actorPhone = actor?.phone || null;
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_phone, action, entity_type, entity_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actorId, actorPhone, action, entity_type || null, entity_id || null, meta ? JSON.stringify(meta) : null, ip || null]
    );
  } catch (e) {
    console.warn('Audit log failed', e.message);
  }
}

module.exports = { signToken, authMiddleware, authorize, logAudit, JWT_SECRET };
