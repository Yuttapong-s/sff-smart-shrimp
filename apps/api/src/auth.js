import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { pool } from './db.js';

export const COOKIE = 'sff_token';

export const ROLES = ['worker', 'technician', 'manager', 'owner'];

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setTokenCookie(res, token, maxAgeSec) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Attaches req.user if a valid token cookie is present. */
export function authenticate(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    try {
      const p = jwt.verify(token, config.jwtSecret);
      req.user = { id: Number(p.sub), role: p.role, name: p.name };
    } catch {
      // expired or tampered: treat as anonymous
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** Allow roles at or above `minRole` in the ROLES ladder. */
export function requireRole(minRole) {
  const min = ROLES.indexOf(minRole);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (ROLES.indexOf(req.user.role) < min) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Simple in-memory login throttle: 10 failures per username+ip per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;

function throttled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return f.count >= 10;
}

function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

export async function login(req, res) {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const key = `${username.toLowerCase()}|${req.ip}`;
  if (throttled(key)) return res.status(429).json({ error: 'too many attempts, try again later' });

  const {
    rows: [user],
  } = await pool.query(
    'SELECT id, password_hash, display_name, role FROM users WHERE lower(username) = lower($1) AND active',
    [username],
  );
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    recordFailure(key);
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  failures.delete(key);

  const token = jwt.sign({ sub: String(user.id), role: user.role, name: user.display_name }, config.jwtSecret, {
    expiresIn: config.jwtTtlSec,
  });
  setTokenCookie(res, token, config.jwtTtlSec);
  await pool.query(`INSERT INTO audit_log (user_id, action) VALUES ($1, 'login')`, [user.id]);
  res.json({ id: user.id, name: user.display_name, role: user.role });
}

export function logout(_req, res) {
  setTokenCookie(res, '', 0);
  res.status(204).end();
}
