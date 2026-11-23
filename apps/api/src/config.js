const env = process.env;

const DEV_SECRET = 'dev-only-insecure-secret-change-me';

export const config = {
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://sff:sff@localhost:5432/sff',
  jwtSecret: env.JWT_SECRET ?? DEV_SECRET,
  jwtTtlSec: Number(env.JWT_TTL_SEC ?? 12 * 3600),
  cookieSecure: env.COOKIE_SECURE === 'true',
  adminUser: env.ADMIN_USER ?? 'admin',
  adminPassword: env.ADMIN_PASSWORD ?? 'admin1234',
  seed: {
    enabled: env.SEED_DEMO !== 'false',
    farmCode: env.SEED_FARM_CODE ?? 'F1',
    farmName: env.SEED_FARM_NAME ?? 'ฟาร์ม SFF',
    units: Number(env.SEED_UNITS ?? 12),
    pondsMin: Number(env.SEED_PONDS_MIN ?? 4),
    pondsMax: Number(env.SEED_PONDS_MAX ?? 6),
  },
};

if (env.NODE_ENV === 'production') {
  if (config.jwtSecret === DEV_SECRET || config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  }
  if (config.adminPassword === 'admin1234') {
    throw new Error('ADMIN_PASSWORD must be changed in production');
  }
}
