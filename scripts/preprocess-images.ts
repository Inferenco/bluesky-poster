import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const originalsDir = path.join(ROOT, 'assets', 'images', 'originals');
const processedDir = path.join(ROOT, 'assets', 'images', 'processed');
const manifestPath = path.join(ROOT, 'assets', 'images', 'manifest.json');

const MAX_BYTES = 1_000_000;
const QUALITIES = [82, 75, 68];

interface Manifest {
  images: Array<{
    id: string;
    path: string;
    tags: string[];
    defaultAlt: string;
    width: number;
    height: number;
    bytes: number;
    mime: string;
  }>;
}

async function main() {
  await fs.mkdir(processedDir, { recursive: true });

  const files = await fs.readdir(originalsDir).catch(() => []);
  if (files.length === 0) {
    console.log('No originals found. Add images to assets/images/originals first.');
    return;
  }

  const manifest = await loadManifest();
  for (const file of files) {
    const inputPath = path.join(originalsDir, file);
    if (!file.match(/\.(png|jpg|jpeg|webp)$/i)) {
      console.log(`Skipping unsupported file: ${file}`);
      continue;
    }
    const id = path.parse(file).name;
    const outputPath = path.join(processedDir, `${id}.jpg`);
    const { width, height, size } = await processImage(inputPath, outputPath);

    const entry = {
      id,
      path: path.relative(ROOT, outputPath).replace(/\\/g, '/'),
      tags: [],
      defaultAlt: `${id} image`,
      width,
      height,
      bytes: size,
      mime: 'image/jpeg'
    };

    const existingIdx = manifest.images.findIndex((img) => img.id === id);
    if (existingIdx >= 0) {
      manifest.images[existingIdx] = entry;
    } else {
      manifest.images.push(entry);
    }
    console.log(`Processed ${file} -> ${entry.path} (${size} bytes)`);
  }

  manifest.images.sort((a, b) => a.id.localeCompare(b.id));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Manifest updated');
}

async function processImage(input: string, output: string): Promise<{ width: number; height: number; size: number }> {
  let lastInfo: sharp.OutputInfo | null = null;
  for (const quality of QUALITIES) {
    const pipeline = sharp(input).rotate().jpeg({ quality, mozjpeg: true });
    const buffer = await pipeline.toBuffer({ resolveWithObject: true });
    lastInfo = buffer.info;
    if (buffer.data.length <= MAX_BYTES) {
      await fs.writeFile(output, buffer.data);
      return { width: buffer.info.width, height: buffer.info.height, size: buffer.data.length };
    }
  }

  if (!lastInfo) throw new Error(`Failed to process ${input}`);
  // Write the last attempt even if > MAX_BYTES; caller can decide.
  const finalBuffer = await sharp(input).rotate().jpeg({ quality: QUALITIES[QUALITIES.length - 1], mozjpeg: true }).toBuffer();
  await fs.writeFile(output, finalBuffer);
  return { width: lastInfo.width, height: lastInfo.height, size: finalBuffer.length };
}

async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch (err) {
    return { images: [] };
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
