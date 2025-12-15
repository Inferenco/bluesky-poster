import fs from 'node:fs/promises';
import path from 'node:path';

export interface BotState {
  posted_ids: string[];
  recent_text_hashes: string[];
  recent_image_ids: string[];
  posted_today_utc: string | null;
  posted_today_count: number;
  last_posted_at: string | null;
}

export interface ScheduleConfig {
  posts_per_day: number;
  default_images_per_post: number;
  max_images_per_post: number;
  quiet_hours_utc: [string, string];
  random_jitter_minutes: number;
  max_recent_image_ids: number;
  max_recent_text_hashes: number;
}

export async function loadState(root: string): Promise<BotState> {
  const statePath = path.join(root, 'state', 'state.json');
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw) as BotState;
  } catch (err) {
    const empty: BotState = {
      posted_ids: [],
      recent_text_hashes: [],
      recent_image_ids: [],
      posted_today_utc: null,
      posted_today_count: 0,
      last_posted_at: null
    };
    await saveState(root, empty);
    return empty;
  }
}

export async function saveState(root: string, state: BotState): Promise<void> {
  const statePath = path.join(root, 'state', 'state.json');
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function ensureToday(state: BotState, now: Date): BotState {
  const today = now.toISOString().slice(0, 10);
  if (state.posted_today_utc !== today) {
    return { ...state, posted_today_utc: today, posted_today_count: 0 };
  }
  return state;
}

export function recordSuccess(state: BotState, schedule: ScheduleConfig, payload: { id: string; textHash: string; imageIds: string[]; when: Date }): BotState {
  const updated: BotState = {
    ...state,
    posted_ids: [...state.posted_ids, payload.id],
    recent_text_hashes: [...state.recent_text_hashes, payload.textHash],
    recent_image_ids: [...state.recent_image_ids, ...payload.imageIds],
    posted_today_count: (state.posted_today_count || 0) + 1,
    last_posted_at: payload.when.toISOString()
  };

  // Trim recents
  if (updated.recent_text_hashes.length > schedule.max_recent_text_hashes) {
    updated.recent_text_hashes = updated.recent_text_hashes.slice(-schedule.max_recent_text_hashes);
  }
  if (updated.recent_image_ids.length > schedule.max_recent_image_ids) {
    updated.recent_image_ids = updated.recent_image_ids.slice(-schedule.max_recent_image_ids);
  }
  return updated;
}
