import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

/**
 * Either the root db handle or a transaction handle — anything that can run
 * queries. Lets a helper be called both standalone and inside a
 * `db.transaction(async (tx) => ...)` block so a lock/check and the write that
 * depends on it stay in one transaction.
 */
export type DbExecutor = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
