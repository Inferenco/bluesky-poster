import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './client.js';
import { loadConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

export async function migrate(databaseUrl = loadConfig().databaseUrl): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    const sql = await fs.readFile(path.join(root, 'db', '001_init.sql'), 'utf8');
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
