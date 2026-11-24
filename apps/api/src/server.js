import express from 'express';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, waitForDb } from './db.js';
import { migrate } from './migrate.js';
import { seedAdmin, seedDemoFarm } from './seed.js';
import { authenticate } from './auth.js';
import { api } from './routes.js';
import { startListener } from './stream.js';
import { startControl } from './control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WEB_DIR = path.resolve(here, '../../web');
const SHARED_DIR = path.dirname(require.resolve('@sff/shared'));
const UPLOT_DIR = path.dirname(require.resolve('uplot'));

await waitForDb();
await migrate(pool);
await seedAdmin(pool);
if (config.seed.enabled) await seedDemoFarm(pool);
await startListener();
startControl();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // behind Caddy

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  );
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(authenticate);
app.use('/api', api);

// Static PWA. Service worker must not be cached long, or updates never roll out.
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');
app.use('/shared', express.static(SHARED_DIR, { setHeaders: noCache }));
app.use('/vendor/uplot', express.static(UPLOT_DIR, { setHeaders: noCache }));
app.use(express.static(WEB_DIR, { setHeaders: noCache }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  console.error('[api] error', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
