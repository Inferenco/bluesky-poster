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

export interface SelectionResult {
  item: QueueItem;
  isRecycled: boolean;
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

/**
 * Select the next queue item to post.
 * 
 * Priority:
 * 1. First active item NOT in postedIds (fresh content)
 * 2. If all active items are posted, recycle: pick the OLDEST posted item
 *    (the one that appears first in postedIds array for this queue)
 * 
 * This allows the queue to loop infinitely with fresh AI-generated content
 * for the same topics.
 */
export function selectNext(queue: QueueItem[], postedIds: string[]): SelectionResult | null {
  const postedSet = new Set(postedIds);
  const activeItems = queue.filter((item) => item.active);

  if (activeItems.length === 0) {
    return null;
  }

  // Try to find an unposted item first
  const fresh = activeItems.find((item) => !postedSet.has(item.id));
  if (fresh) {
    return { item: fresh, isRecycled: false };
  }

  // All active items have been posted — recycle the oldest one
  // Find which active item was posted earliest (appears first in postedIds)
  const activeIds = new Set(activeItems.map((i) => i.id));
  for (const postedId of postedIds) {
    if (activeIds.has(postedId)) {
      const recycled = activeItems.find((i) => i.id === postedId)!;
      return { item: recycled, isRecycled: true };
    }
  }

  // Fallback: just pick the first active item
  return { item: activeItems[0], isRecycled: true };
}

