import crypto from 'node:crypto';
import {
  AccountAddress,
  AuthenticationKey,
  Ed25519PublicKey,
  Ed25519Signature
} from '@cedra-labs/ts-sdk';

export interface SessionUser {
  address: string;
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    authNonce?: string;
    authNonceIssuedAt?: number;
    user?: SessionUser;
  }
}

export const LOGIN_MESSAGE = 'Sign in to the Inferenco poster dashboard';
export const NONCE_MAX_AGE_MS = 5 * 60_000;

export function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface VerifyInput {
  message: string;
  nonce: string;
  fullMessage: string;
  signature: string;
  publicKey: string;
  address: string;
}

export type SignatureVerifier = (
  input: VerifyInput,
  expected: { nonce: string; message: string }
) => boolean;

/**
 * Verifies that the wallet that signed `fullMessage` controls `address` and
 * that the signed payload embeds the nonce/message this server issued.
 * Only pure Ed25519 accounts are supported; other key schemes are rejected.
 */
export const verifyWalletSignature: SignatureVerifier = (input, expected) => {
  try {
    if (input.nonce !== expected.nonce || input.message !== expected.message) {
      return false;
    }
    // The wallet builds fullMessage itself; the embedded nonce is what binds
    // the signature to this login attempt.
    if (!input.fullMessage.includes(expected.nonce) || !input.fullMessage.includes(expected.message)) {
      return false;
    }
    const publicKey = new Ed25519PublicKey(input.publicKey);
    const signature = new Ed25519Signature(input.signature);
    const signedBytes = new TextEncoder().encode(input.fullMessage);
    if (!publicKey.verifySignature({ message: signedBytes, signature })) {
      return false;
    }
    const derived = AuthenticationKey.fromPublicKey({ publicKey }).derivedAddress();
    return derived.equals(AccountAddress.from(input.address));
  } catch {
    return false;
  }
};

export type AdminFetcher = () => Promise<string[]>;

export type ViewCaller = (functionId: string) => Promise<string>;

const ADMIN_VIEW_FUNCTIONS = [
  'get_primary_admin',
  'get_secondary_admin',
  'get_tertiary_admin'
] as const;

export function makeAdminFetcher(opts: {
  fullnodeUrl: string;
  contractAddress: string;
  ttlMs: number;
  viewTimeoutMs?: number;
  view?: ViewCaller;
}): AdminFetcher {
  const view = opts.view ?? makeRestViewCaller(opts.fullnodeUrl, opts.viewTimeoutMs ?? 5_000);
  let cache: { admins: string[]; fetchedAt: number } | null = null;

  return async function fetchAdmins(): Promise<string[]> {
    if (cache && Date.now() - cache.fetchedAt < opts.ttlMs) {
      return cache.admins;
    }
    try {
      const results = await Promise.all(
        ADMIN_VIEW_FUNCTIONS.map(fn =>
          view(`${opts.contractAddress}::wallet_treasury::${fn}`)
        )
      );
      const zero = normalizeAddress('0x0');
      const admins = results
        .map(raw => normalizeAddress(raw))
        .filter((addr): addr is string => addr !== null && addr !== zero);
      cache = { admins, fetchedAt: Date.now() };
      return admins;
    } catch (error) {
      // A transient fullnode outage should not lock out a logged-in admin.
      if (cache) return cache.admins;
      throw error;
    }
  };
}

function makeRestViewCaller(fullnodeUrl: string, timeoutMs: number): ViewCaller {
  const base = fullnodeUrl.replace(/\/+$/, '');
  return async function callView(functionId: string): Promise<string> {
    const response = await fetch(`${base}/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ function: functionId, type_arguments: [], arguments: [] })
    });
    if (!response.ok) {
      throw new Error(`View call ${functionId} failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown[];
    const value = body[0];
    if (typeof value !== 'string') {
      throw new Error(`View call ${functionId} returned unexpected payload`);
    }
    return value;
  };
}

/** Lowercases and zero-pads a hex address to its canonical 64-char form. */
export function normalizeAddress(raw: string): string | null {
  const hex = raw.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return null;
  return `0x${hex.padStart(64, '0')}`;
}

export function isAdmin(address: string, admins: string[]): boolean {
  const candidate = normalizeAddress(address);
  if (!candidate) return false;
  return admins.some(admin => normalizeAddress(admin) === candidate);
}
