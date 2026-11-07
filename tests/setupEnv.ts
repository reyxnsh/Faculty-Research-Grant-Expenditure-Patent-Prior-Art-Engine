import dotenv from 'dotenv';

dotenv.config();

const baseDb = process.env.POSTGRES_DB || 'grant_priorart_db';
// Ensure test environment uses isolated test database
if (!baseDb.endsWith('_test')) {
  process.env.POSTGRES_DB = `${baseDb}_test`;
}

const user = process.env.POSTGRES_USER || 'grant_admin';
const password = process.env.POSTGRES_PASSWORD || '';
const host = process.env.POSTGRES_HOST || 'localhost';
const port = process.env.POSTGRES_PORT || '5433';
const activeDb = process.env.POSTGRES_DB || `${baseDb}_test`;
process.env.DATABASE_URL = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(activeDb)}`;

if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
  process.env.AUTH_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}
