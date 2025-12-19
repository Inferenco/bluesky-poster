import fs from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';

export interface ImageAsset {
  id: string;
  path: string;
  defaultAlt: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

const ORIGINALS_DIR = 'assets/images/originals';
const MAX_BYTES = 1_000_000;

/**
 * Get list of all images in the originals folder
 */
export async function getAvailableImages(root: string): Promise<ImageAsset[]> {
  const originalsPath = path.join(root, ORIGINALS_DIR);

  try {
    const files = await fs.readdir(originalsPath);
    const images: ImageAsset[] = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
        continue;
      }

      const filePath = path.join(originalsPath, file);
      const stat = await fs.stat(filePath);

      // Skip files over 1MB
      if (stat.size > MAX_BYTES) {
        continue;
      }

      // Get dimensions
      const buffer = await fs.readFile(filePath);
      const dimensions = imageSize(buffer);

      const mime = getMimeType(ext);
      const id = path.basename(file, ext);

      images.push({
        id,
        path: path.join(ORIGINALS_DIR, file),
        defaultAlt: 'Inferenco promotional image',
        width: dimensions.width || 800,
        height: dimensions.height || 600,
        bytes: stat.size,
        mime
      });
    }

    return images;
  } catch (err) {
    console.warn(`Could not read originals directory: ${err}`);
    return [];
  }
}

/**
 * Randomly select one image from available images
 */
export function selectRandomImage(images: ImageAsset[]): ImageAsset | null {
  if (images.length === 0) return null;
  const index = Math.floor(Math.random() * images.length);
  return images[index];
}

function getMimeType(ext: string): string {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}
