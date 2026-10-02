import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dbAvailable: boolean;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseDir = path.resolve(here, '../database');

/**
 * Rebuilds the test database from database/schema.sql + seed.sql once per run.
 * If Postgres isn't reachable, integration tests are skipped (unit tests still run).
 */
export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/slotwise_test';
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`\n⚠ Integration tests skipped — cannot connect to ${url}: ${(err as Error).message}\n`);
    project.provide('dbAvailable', false);
    return;
  }

  try {
    await client.query('SET client_min_messages TO WARNING; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.query(await readFile(path.join(databaseDir, 'schema.sql'), 'utf8'));
    await client.query(await readFile(path.join(databaseDir, 'seed.sql'), 'utf8'));
    project.provide('dbAvailable', true);
  } finally {
    await client.end();
  }
}
