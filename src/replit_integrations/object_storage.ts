import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

export function getPublicBucketInfo(): { bucketName: string; prefix: string } {
  const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? '';
  const first = pathsStr.split(',')[0]?.trim() ?? '';
  if (!first) {
    throw new Error('PUBLIC_OBJECT_SEARCH_PATHS env var is not set — bucket not provisioned');
  }
  const parts = first.replace(/^\//, '').split('/');
  const bucketName = parts[0];
  const prefix = parts.slice(1).join('/');
  return { bucketName, prefix };
}

export function derivePublicUrl(objectKey: string): string {
  const { bucketName } = getPublicBucketInfo();
  return `https://storage.googleapis.com/${bucketName}/${objectKey}`;
}

export function validatePublicObjectKey(objectKey: string): void {
  const { prefix } = getPublicBucketInfo();
  const expectedPrefix = prefix ? `${prefix}/` : '';
  if (expectedPrefix && !objectKey.startsWith(expectedPrefix)) {
    throw new Error('Object key is not within the expected public storage prefix');
  }
  if (objectKey.includes('..') || objectKey.startsWith('/')) {
    throw new Error('Object key contains invalid characters');
  }
}

export function validatePublicUrl(url: string): void {
  const { bucketName, prefix } = getPublicBucketInfo();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid image URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Image URL must use HTTPS');
  }
  if (parsed.hostname !== 'storage.googleapis.com') {
    throw new Error('Image URL must point to Google Cloud Storage');
  }
  const expectedPathPrefix = `/${bucketName}/${prefix ? prefix + '/' : ''}`;
  if (!parsed.pathname.startsWith(expectedPathPrefix)) {
    throw new Error('Image URL is not within the configured storage bucket public prefix');
  }
}

export interface PresignedUploadResult {
  uploadURL: string;
  objectKey: string;
  publicUrl: string;
}

export async function deleteObject(objectKey: string): Promise<void> {
  const { bucketName } = getPublicBucketInfo();
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/object`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectKey,
    }),
  });

  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`Failed to delete object from storage: ${response.status} ${body}`);
  }
}

export async function createPresignedUpload(fileName: string): Promise<PresignedUploadResult> {
  const { bucketName, prefix } = getPublicBucketInfo();
  const ext = path.extname(fileName).toLowerCase() || '';
  const uniqueName = `${randomUUID()}${ext}`;
  const objectName = prefix ? `${prefix}/uploads/${uniqueName}` : `uploads/${uniqueName}`;

  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: 'PUT',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to generate presigned upload URL: ${response.status} ${body}`);
  }

  const json = await response.json() as { signed_url: string };
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectName}`;

  return {
    uploadURL: json.signed_url,
    objectKey: objectName,
    publicUrl,
  };
}
