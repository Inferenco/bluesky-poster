import fs from 'node:fs/promises';
import path from 'node:path';
import { BskyAgent, RichText, type BlobRef } from '@atproto/api';
import { ImageAsset } from './images.js';
import type { MessageRecord } from './repositories/messages.js';
import { getImageMimeType, type BlueskyPublisher } from './services/poster.js';

export interface BlueskyAuth {
  identifier: string;
  password: string;
}

export interface PostImageInput {
  asset: ImageAsset;
  alt: string;
}

export interface PostResult {
  uri: string | null;
  cid: string | null;
  alreadyExists: boolean;
}

export async function login(auth: BlueskyAuth): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: auth.identifier, password: auth.password });
  return agent;
}

export async function getAgent(auth: BlueskyAuth & { serviceUrl?: string }): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: auth.serviceUrl ?? 'https://bsky.social' });
  await agent.login({ identifier: auth.identifier, password: auth.password });
  return agent;
}

export class AtprotoBlueskyPublisher implements BlueskyPublisher {
  constructor(private readonly agent: BskyAgent) {}

  async publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null }> {
    const rt = new RichText({ text: message.body });
    await rt.detectFacets(this.agent);

    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      tags: message.tags.slice(0, 8)
    };

    if (message.image_path || message.image_content) {
      const data = message.image_content ?? await fs.readFile(path.resolve(process.cwd(), message.image_path ?? ''));
      const blobRes = await this.agent.com.atproto.repo.uploadBlob(data, {
        encoding: message.image_mime_type ?? getImageMimeType(message.image_path ?? '')
      });
      const image = {
        image: blobRes.data.blob,
        alt: message.image_alt ?? '',
        ...(message.image_width && message.image_height
          ? { aspectRatio: { width: message.image_width, height: message.image_height } }
          : {})
      };
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: [image]
      };
    }

    const res = await this.agent.com.atproto.repo.createRecord({
      repo: this.agent.session?.did || this.agent.did || '',
      collection: 'app.bsky.feed.post',
      record
    });

    return { uri: res.data.uri, cid: res.data.cid };
  }
}

export async function postWithImages(agent: BskyAgent, payload: { text: string; images: PostImageInput[]; rkey: string }): Promise<PostResult> {
  const blobs = [] as { image: BlobRef; alt: string; aspectRatio: { width: number; height: number } }[];

  for (const img of payload.images) {
    const filePath = path.join(process.cwd(), img.asset.path);
    const data = await fs.readFile(filePath);
    const blobRes = await agent.com.atproto.repo.uploadBlob(data, {
      encoding: img.asset.mime
    });

    const image = blobRes.data.blob;
    blobs.push({
      image,
      alt: img.alt,
      aspectRatio: { width: img.asset.width, height: img.asset.height }
    });
  }

  // Use RichText to detect and create link facets
  const rt = new RichText({ text: payload.text });
  await rt.detectFacets(agent);

  const record = {
    $type: 'app.bsky.feed.post',
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
    embed: {
      $type: 'app.bsky.embed.images',
      images: blobs
    }
  };

  try {
    const res = await agent.com.atproto.repo.createRecord({
      repo: agent.session?.did || agent.did || '',
      collection: 'app.bsky.feed.post',
      rkey: payload.rkey,
      record
    });

    return { uri: res.data.uri, cid: res.data.cid, alreadyExists: false };
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.toLowerCase().includes('already exists')) {
      return { uri: null, cid: null, alreadyExists: true };
    }
    throw err;
  }
}
