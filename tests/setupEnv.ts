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
process.env.DATABASE_URL = `postgres://${user}:${password}@${host}:${port}/${process.env.POSTGRES_DB}`;
