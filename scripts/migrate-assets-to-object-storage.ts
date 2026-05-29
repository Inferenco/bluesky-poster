import { randomUUID } from 'node:crypto';
import pg from 'pg';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

interface AssetRow {
  id: string;
  storage_kind: string;
  mime_type: string;
  content: Buffer | null;
  bytes: number;
}

function getPublicBucketInfo(): { bucketName: string; prefix: string } {
  const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? '';
  const first = pathsStr.split(',')[0]?.trim() ?? '';
  if (!first) {
    throw new Error('PUBLIC_OBJECT_SEARCH_PATHS env var is not set — object storage bucket not provisioned');
  }
  const parts = first.replace(/^\//, '').split('/');
  const bucketName = parts[0];
  const prefix = parts.slice(1).join('/');
  return { bucketName, prefix };
}

function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'image/tiff': '.tiff',
  };
  return map[mimeType] ?? '';
}

async function uploadBufferToObjectStorage(
  content: Buffer,
  mimeType: string
): Promise<{ objectKey: string; publicUrl: string }> {
  const { bucketName, prefix } = getPublicBucketInfo();
  const ext = mimeTypeToExtension(mimeType);
  const uniqueName = `${randomUUID()}${ext}`;
  const objectKey = prefix ? `${prefix}/uploads/${uniqueName}` : `uploads/${uniqueName}`;

  const signedRes = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectKey,
      method: 'PUT',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
  });

  if (!signedRes.ok) {
    const body = await signedRes.text();
    throw new Error(`Failed to generate presigned upload URL: ${signedRes.status} ${body}`);
  }

  const { signed_url: uploadURL } = await signedRes.json() as { signed_url: string };

  const putRes = await fetch(uploadURL, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: content,
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Failed to upload object to storage: ${putRes.status} ${body}`);
  }

  const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectKey}`;
  return { objectKey, publicUrl };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const { rows: assets } = await pool.query<AssetRow>(
      `SELECT id, storage_kind, mime_type, content, bytes
       FROM assets
       WHERE storage_kind = 'database'`
    );

    if (assets.length === 0) {
      console.log('No database-stored assets found. Nothing to migrate.');
      return;
    }

    console.log(`Found ${assets.length} database-stored asset(s) to migrate.`);

    let succeeded = 0;
    let failed = 0;

    for (const asset of assets) {
      if (!asset.content) {
        console.warn(`[SKIP] Asset ${asset.id}: storage_kind=database but content is null — skipping.`);
        continue;
      }

      try {
        const { objectKey, publicUrl } = await uploadBufferToObjectStorage(asset.content, asset.mime_type);

        await pool.query(
          `UPDATE assets
           SET storage_kind = 'object_storage',
               path_or_object_key = $1,
               public_url = $2,
               content = NULL
           WHERE id = $3`,
          [objectKey, publicUrl, asset.id]
        );

        console.log(`[OK] Asset ${asset.id} → ${publicUrl}`);
        succeeded++;
      } catch (err) {
        console.error(`[FAIL] Asset ${asset.id}:`, err instanceof Error ? err.message : err);
        failed++;
      }
    }

    console.log(`\nMigration complete: ${succeeded} succeeded, ${failed} failed.`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
