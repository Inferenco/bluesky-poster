import { nanoid } from 'nanoid';
import { countGraphemes, hashText, MAX_GRAPHEMES } from '../validate.js';

export interface Queryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export type MessageStatus = 'draft' | 'approved' | 'paused' | 'archived';

export interface MessageRecord {
  id: string;
  body: string;
  status: MessageStatus;
  weight: number;
  cooldown_hours: number;
  tags: string[];
  self_labels: string[];
  image_asset_id: string | null;
  image_path: string | null;
  image_alt: string | null;
  image_content?: Buffer | null;
  image_mime_type?: string | null;
  normalised_hash: string;
  last_posted_at: Date | string | null;
  post_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateMessageInput {
  body: string;
  status?: MessageStatus;
  weight?: number;
  cooldownHours?: number;
  tags?: string[];
  selfLabels?: string[];
  imageAssetId?: string | null;
  imagePath?: string | null;
  imageAlt?: string | null;
}

export interface UpdateMessageInput {
  body?: string;
  status?: MessageStatus;
  weight?: number;
  cooldownHours?: number;
  tags?: string[];
  selfLabels?: string[];
  imageAssetId?: string | null;
  imagePath?: string | null;
  imageAlt?: string | null;
}

export class MessagesRepository {
  constructor(
    private readonly db: Queryable,
    private readonly createId: () => string = nanoid
  ) {}

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    validateMessageBody(input.body);
    const id = this.createId();
    const values = [
      id,
      input.body,
      input.status ?? 'draft',
      input.weight ?? 100,
      input.cooldownHours ?? 168,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.selfLabels ?? []),
      input.imageAssetId ?? null,
      input.imagePath ?? null,
      input.imageAlt ?? null,
      hashText(input.body)
    ];

    const result = await this.db.query<MessageRecord>(
      `insert into messages (
        id, body, status, weight, cooldown_hours, tags, self_labels,
        image_asset_id, image_path, image_alt, normalised_hash
      ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
      returning *`,
      values
    );

    return result.rows[0];
  }

  async list(): Promise<MessageRecord[]> {
    const result = await this.db.query<MessageRecord>(
      `select
        m.*,
        coalesce(a.path_or_object_key, m.image_path) as image_path,
        coalesce(m.image_alt, a.alt_text_default) as image_alt,
        a.content as image_content,
        a.mime_type as image_mime_type
      from messages m
      left join assets a on a.id = m.image_asset_id
      where m.status <> $1
      order by m.updated_at desc`,
      ['archived']
    );
    return result.rows;
  }

  async get(id: string): Promise<MessageRecord | null> {
    const result = await this.db.query<MessageRecord>(
      `select
        m.*,
        coalesce(a.path_or_object_key, m.image_path) as image_path,
        coalesce(m.image_alt, a.alt_text_default) as image_alt,
        a.content as image_content,
        a.mime_type as image_mime_type
      from messages m
      left join assets a on a.id = m.image_asset_id
      where m.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async update(id: string, input: UpdateMessageInput): Promise<MessageRecord> {
    const current = await this.get(id);
    if (!current) throw new Error('message not found');
    const body = input.body ?? current.body;
    validateMessageBody(body);

    const result = await this.db.query<MessageRecord>(
      `update messages set
        body = $2,
        status = $3,
        weight = $4,
        cooldown_hours = $5,
        tags = $6::jsonb,
        self_labels = $7::jsonb,
        image_asset_id = $8,
        image_path = $9,
        image_alt = $10,
        normalised_hash = $11,
        updated_at = now()
      where id = $1
      returning *`,
      [
        id,
        body,
        input.status ?? current.status,
        input.weight ?? current.weight,
        input.cooldownHours ?? current.cooldown_hours,
        JSON.stringify(input.tags ?? current.tags),
        JSON.stringify(input.selfLabels ?? current.self_labels),
        input.imageAssetId ?? current.image_asset_id,
        input.imagePath ?? current.image_path,
        input.imageAlt ?? current.image_alt,
        hashText(body)
      ]
    );

    return result.rows[0];
  }

  async setStatus(id: string, status: MessageStatus): Promise<void> {
    await this.db.query('update messages set status = $2, updated_at = now() where id = $1', [id, status]);
  }

  async delete(id: string): Promise<void> {
    await this.db.query('delete from messages where id = $1', [id]);
  }

  async markPosted(id: string, when: Date): Promise<void> {
    await this.db.query(
      `update messages
      set last_posted_at = $2, post_count = post_count + 1, updated_at = now()
      where id = $1`,
      [id, when]
    );
  }
}

function validateMessageBody(body: string): void {
  if (!body.trim()) {
    throw new Error('Message body is required');
  }
  if (countGraphemes(body) > MAX_GRAPHEMES) {
    throw new Error('Message must be 300 graphemes or fewer');
  }
}
