import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.baseUrl || process.env.NOVA_BASE_URL || 'https://gateway.inferenco.com';
  const apiKey = process.env.NOVA_API_KEY || '';
  const docsDir = path.isAbsolute(args.dir) ? args.dir : path.join(ROOT, args.dir);

  const entries = await fs.readdir(docsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  if (files.length === 0) {
    console.log(JSON.stringify({ message: 'No files found', dir: docsDir }, null, 2));
    return;
  }

  const payload = {
    file_contents: [] as { filename: string; content: string }[]
  };

  const manifest = {
    uploaded_at: new Date().toISOString(),
    dry_run: args.dryRun,
    dir: docsDir,
    endpoint: `${baseUrl}/vector-store/files`,
    files: [] as { filename: string; bytes: number; sha256: string }[]
  };

  for (const filename of files) {
    const fullPath = path.join(docsDir, filename);
    const data = await fs.readFile(fullPath);
    payload.file_contents.push({
      filename,
      content: data.toString('base64')
    });
    manifest.files.push({
      filename,
      bytes: data.length,
      sha256: hashBuffer(data)
    });
  }

  if (args.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (!apiKey) {
    throw new Error('Missing NOVA_API_KEY');
  }

  const response = await fetch(`${baseUrl}/vector-store/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const result = await response.json().catch(() => ({}));
  console.log(
    JSON.stringify(
      {
        ...manifest,
        result
      },
      null,
      2
    )
  );
}

function parseArgs(args: string[]): { dir: string; dryRun: boolean; baseUrl?: string } {
  let dir = 'docs';
  let dryRun = false;
  let baseUrl: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--dry') {
      dryRun = true;
      continue;
    }
    if (arg === '--dir' && args[i + 1]) {
      dir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
      continue;
    }
    if (arg === '--base-url' && args[i + 1]) {
      baseUrl = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
  }

  return { dir, dryRun, baseUrl };
}

function hashBuffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
