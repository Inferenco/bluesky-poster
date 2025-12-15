import fs from 'node:fs/promises';
import path from 'node:path';
import { BskyAgent, type BlobRef } from '@atproto/api';
import { ImageAsset } from './images.js';

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

  const record = {
    $type: 'app.bsky.feed.post',
    text: payload.text,
    createdAt: new Date().toISOString(),
    embed: {
      $type: 'app.bsky.embed.images',
      images: blobs
    }
  } as const;

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
