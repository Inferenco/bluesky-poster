import fs from 'node:fs/promises';
import path from 'node:path';

export interface ImageAsset {
  id: string;
  path: string;
  tags: string[];
  defaultAlt: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

export interface Manifest {
  images: ImageAsset[];
}

export async function loadManifest(root: string): Promise<Manifest> {
  const manifestPath = path.join(root, 'assets', 'images', 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const json = JSON.parse(raw) as Manifest;
  json.images = json.images || [];
  return json;
}

export interface ImageSelectionParams {
  requestedIds?: string[];
  tags: string[];
  defaultImagesPerPost: number;
  maxImagesPerPost: number;
  recentImageIds: string[];
}

export function selectImages(manifest: Manifest, params: ImageSelectionParams): ImageAsset[] {
  const maxBytes = 1_000_000;
  const eligible = manifest.images.filter((img) => img.bytes <= maxBytes);
  const recentSet = new Set(params.recentImageIds);

  if (params.requestedIds && params.requestedIds.length > 0) {
    return params.requestedIds
      .map((id) => eligible.find((img) => img.id === id))
      .filter((img): img is ImageAsset => Boolean(img))
      .slice(0, 4);
  }

  const scored = eligible.map((img) => ({
    img,
    score: overlap(img.tags, params.tags) - (recentSet.has(img.id) ? 0.5 : 0) + Math.random() * 0.01
  }));

  scored.sort((a, b) => b.score - a.score);

  const count = Math.max(1, Math.min(params.defaultImagesPerPost, params.maxImagesPerPost));
  return scored.slice(0, count).map((s) => s.img);
}

function overlap(a: string[], b: string[]): number {
  const set = new Set(a.map((t) => t.toLowerCase()));
  return b.reduce((acc, tag) => acc + (set.has(tag.toLowerCase()) ? 1 : 0), 0);
}
