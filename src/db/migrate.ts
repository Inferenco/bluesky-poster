import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createPool } from './client.js';
import { loadConfig } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

export async function migrate(databaseUrl = loadConfig().databaseUrl): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    const dbDir = path.join(root, 'db');
    const files = (await fs.readdir(dbDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(dbDir, file), 'utf8');
      await pool.query(sql);
    }
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
