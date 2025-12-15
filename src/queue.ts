import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

export interface QueueItem {
  id: string;
  topic: string;
  link?: string;
  tags: string[];
  cta?: string;
  active: boolean;
  imageIds?: string[];
}

export async function loadQueue(root: string): Promise<QueueItem[]> {
  const queuePath = path.join(root, 'content', 'queue.csv');
  const raw = await fs.readFile(queuePath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as Record<string, string>[];

  return records.map((row) => ({
    id: row.id,
    topic: row.topic,
    link: row.link || undefined,
    tags: (row.tags || '')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean),
    cta: row.cta || undefined,
    active: String(row.active).toLowerCase() === 'true',
    imageIds: (row.image_ids || '')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
  }));
}

export function selectNext(queue: QueueItem[], postedIds: Set<string>): QueueItem | null {
  return queue.find((item) => item.active && !postedIds.has(item.id)) || null;
}
