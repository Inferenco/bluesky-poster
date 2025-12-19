import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const originalsDir = path.join(ROOT, 'assets', 'images', 'originals');

const MAX_BYTES = 950_000; // Under 1MB with some margin
const QUALITIES = [85, 75, 65, 55];

async function main() {
  const files = await fs.readdir(originalsDir).catch(() => []);
  if (files.length === 0) {
    console.log('No images found in assets/images/originals/');
    return;
  }

  for (const file of files) {
    const inputPath = path.join(originalsDir, file);
    if (!file.match(/\.(png|jpg|jpeg|webp)$/i)) {
      console.log(`Skipping: ${file}`);
      continue;
    }

    const stat = await fs.stat(inputPath);
    if (stat.size <= MAX_BYTES) {
      console.log(`Already OK: ${file} (${Math.round(stat.size / 1024)}KB)`);
      continue;
    }

    // Compress to JPEG
    const id = path.parse(file).name;
    const outputPath = path.join(originalsDir, `${id}.jpg`);
    const result = await compressImage(inputPath, outputPath);

    // Remove original if we created a new .jpg
    if (inputPath !== outputPath) {
      await fs.unlink(inputPath);
    }

    console.log(`Compressed: ${file} -> ${result.size}KB`);
  }

  console.log('Done!');
}

async function compressImage(input: string, output: string): Promise<{ size: number }> {
  for (const quality of QUALITIES) {
    const buffer = await sharp(input)
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    if (buffer.length <= MAX_BYTES) {
      await fs.writeFile(output, buffer);
      return { size: Math.round(buffer.length / 1024) };
    }
  }

  // Last resort: resize down
  const buffer = await sharp(input)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60, mozjpeg: true })
    .toBuffer();

  await fs.writeFile(output, buffer);
  return { size: Math.round(buffer.length / 1024) };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
