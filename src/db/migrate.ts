/**
 * Minimal migration runner.
 *
 *   tsx src/db/migrate.ts            apply database/schema.sql (idempotent)
 *   tsx src/db/migrate.ts --seed     ...and database/seed.sql
 *   tsx src/db/migrate.ts --reset    drop everything first (refuses in production)
 *
 * The schema file is written to be re-runnable, so "migrate" is simply
 * "apply the canonical DDL". A real product would switch to versioned
 * migrations (node-pg-migrate, Flyway, ...) once the schema starts changing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, isProd } from '../config/env.js';
import { pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/db (compiled): two levels up is the project root.
const databaseDir = process.env.DATABASE_DIR ?? path.resolve(here, '../../database');

async function run(file: string) {
  const sql = await readFile(path.join(databaseDir, file), 'utf8');
  await pool.query(sql);
  console.log(`✓ applied ${file}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--reset')) {
    if (isProd) throw new Error('Refusing to --reset in production');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('✓ dropped schema public');
  }

  await pool.query("SET client_min_messages TO WARNING");
  await run('schema.sql');
  if (args.has('--seed')) await run('seed.sql');
}

main()
  .catch((err) => {
    console.error(`Migration failed (${env.NODE_ENV}):`, err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
