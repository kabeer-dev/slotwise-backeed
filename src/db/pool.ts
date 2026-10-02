import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// Return `bigint` columns (chat_messages.id) as strings, which is what pg does
// by default — made explicit here so nobody "fixes" it into lossy numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
// Keep DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'Unexpected idle client error'));

/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
