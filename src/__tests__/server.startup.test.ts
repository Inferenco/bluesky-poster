import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('server startup', () => {
  test('runs database migrations before creating repositories', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'server.ts'), 'utf8');

    expect(source).toContain("import { migrate } from './db/migrate.js';");
    expect(source.indexOf('await migrate(config.databaseUrl);')).toBeLessThan(source.indexOf('const pool = createPool(config.databaseUrl);'));
  });
});
