import { nanoid } from 'nanoid';
import type { AssetRecord } from './assets.js';

export interface Queryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export type BlogStatus = 'draft' | 'published' | 'archived';

export interface BlogRecord {
  id: string;
  title: string;
  content: string;
  status: BlogStatus;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  assets?: AssetRecord[]; // Optional assets for UI display
}

export interface BlogWithAssets extends BlogRecord {
  assets: AssetRecord[];
}

export interface CreateBlogInput {
  title: string;
  content: string;
  status?: BlogStatus;
  publishedAt?: Date | string | null;
}

export interface UpdateBlogInput {
  title?: string;
  content?: string;
  status?: BlogStatus;
  publishedAt?: Date | string | null;
}

interface BlogAssetRecord {
  blog_id: string;
  asset_id: string;
  position: number;
  created_at: Date | string;
}

export class BlogsRepository {
  constructor(
    private readonly db: Queryable,
    private readonly createId: () => string = nanoid
  ) {}

  async create(input: CreateBlogInput): Promise<BlogRecord> {
    const id = this.createId();
    const values = [
      id,
      input.title,
      input.content,
      input.status ?? 'draft',
      input.publishedAt ?? null
    ];

    const result = await this.db.query<BlogRecord>(
      `insert into blogs (
        id, title, content, status, published_at
      ) values ($1, $2, $3, $4, $5)
      returning *`,
      values
    );

    return result.rows[0];
  }

  async get(id: string): Promise<BlogRecord | null> {
    const result = await this.db.query<BlogRecord>(
      `select * from blogs where id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async getWithAssets(id: string): Promise<BlogWithAssets | null> {
    const blogResult = await this.db.query<BlogRecord>(
      `select * from blogs where id = $1`,
      [id]
    );
    
    const blog = blogResult.rows[0];
    if (!blog) return null;

    const assets = await this.getBlogAssets(id);
    return { ...blog, assets };
  }

  async list(): Promise<BlogRecord[]> {
    const result = await this.db.query<BlogRecord>(
      `select * from blogs where status <> $1 order by updated_at desc`,
      ['archived']
    );
    return result.rows;
  }

  async listAll(): Promise<BlogRecord[]> {
    const result = await this.db.query<BlogRecord>(
      `select * from blogs order by updated_at desc`
    );
    return result.rows;
  }

  async listPublished(options: { limit?: number; offset?: number } = {}): Promise<{ blogs: BlogRecord[]; total: number }> {
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    const [countResult, blogsResult] = await Promise.all([
      this.db.query<{ count: string }>(
        `select count(*)::text as count from blogs where status = $1`,
        ['published']
      ),
      this.db.query<BlogRecord>(
        `select * from blogs where status = $1 order by published_at desc nulls last, created_at desc limit $2 offset $3`,
        ['published', limit, offset]
      )
    ]);

    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);
    return {
      blogs: blogsResult.rows,
      total
    };
  }

  async update(id: string, input: UpdateBlogInput): Promise<BlogRecord> {
    const current = await this.get(id);
    if (!current) throw new Error('blog not found');

    const result = await this.db.query<BlogRecord>(
      `update blogs set
        title = $2,
        content = $3,
        status = $4,
        published_at = $5,
        updated_at = now()
      where id = $1
      returning *`,
      [
        id,
        input.title ?? current.title,
        input.content ?? current.content,
        input.status ?? current.status,
        input.publishedAt !== undefined ? input.publishedAt : current.published_at
      ]
    );

    return result.rows[0];
  }

  async setStatus(id: string, status: BlogStatus): Promise<void> {
    // If setting to published, set published_at to now
    const publishedAt = status === 'published' ? new Date() : null;
    
    await this.db.query(
      `update blogs set status = $2, published_at = $3, updated_at = now() where id = $1`,
      [id, status, publishedAt]
    );
  }

  async setPublishedAt(id: string, publishedAt: Date | string | null): Promise<void> {
    await this.db.query(
      `update blogs set published_at = $2, updated_at = now() where id = $1`,
      [id, publishedAt]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query('delete from blogs where id = $1', [id]);
  }

  async addAsset(blogId: string, assetId: string, position: number = 0): Promise<void> {
    // Check if the asset is already associated with this blog
    const existing = await this.db.query<BlogAssetRecord>(
      `select * from blog_assets where blog_id = $1 and asset_id = $2`,
      [blogId, assetId]
    );

    if (existing.rows.length > 0) {
      // Update position if it already exists
      await this.db.query(
        `update blog_assets set position = $3, updated_at = now() where blog_id = $1 and asset_id = $2`,
        [blogId, assetId, position]
      );
    } else {
      // Insert new association
      await this.db.query(
        `insert into blog_assets (blog_id, asset_id, position) values ($1, $2, $3)`,
        [blogId, assetId, position]
      );
    }
  }

  async removeAsset(blogId: string, assetId: string): Promise<void> {
    await this.db.query(
      `delete from blog_assets where blog_id = $1 and asset_id = $2`,
      [blogId, assetId]
    );
  }

  async getBlogAssets(blogId: string): Promise<AssetRecord[]> {
    const result = await this.db.query<AssetRecord>(
      `select a.* from assets a
       join blog_assets ba on a.id = ba.asset_id
       where ba.blog_id = $1
       order by ba.position asc, ba.created_at asc`,
      [blogId]
    );
    return result.rows;
  }

  async reorderAssets(blogId: string, assetId: string, newPosition: number): Promise<void> {
    await this.db.query(
      `update blog_assets set position = $3 where blog_id = $1 and asset_id = $2`,
      [blogId, assetId, newPosition]
    );
  }

  async countReferencingAsset(assetId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      'select count(*)::text as count from blog_assets where asset_id = $1',
      [assetId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }
}