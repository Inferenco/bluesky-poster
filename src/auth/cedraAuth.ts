import crypto from 'node:crypto';
import {
  AccountAddress,
  AnyPublicKey,
  AuthenticationKey,
  Deserializer,
  Ed25519PublicKey,
  Ed25519Signature,
  Hex
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

export function buildLoginMessage(nonce: string): string {
  return `${LOGIN_MESSAGE}. Nonce: ${nonce}`;
}

/** Legacy challenge format kept so outstanding sessions and older clients still verify. */
export function buildLegacyLoginMessage(nonce: string): string {
  return `${LOGIN_MESSAGE}\nNonce: ${nonce}`;
}

export interface VerifyInput {
  message: string;
  /** Legacy echo of the server nonce; the signed `message` remains authoritative. */
  nonce?: string;
  fullMessage: string;
  signature: string;
  publicKey: string;
  address: string;
}

export type SignatureVerifier = (
  input: VerifyInput,
  expected: { message: string }
) => boolean;

/**
 * Verifies that the wallet that signed `fullMessage` controls `address` and
 * that the signed payload embeds the nonce/message this server issued.
 * Returns null on success, or a short reason code describing the failed
 * check. Only Ed25519 keys are supported (raw or wrapped in AnyPublicKey);
 * other key schemes are rejected.
 */
export function explainSignatureFailure(
  input: VerifyInput,
  expected: { message: string }
): string | null {
  try {
    const expectedNonce = extractLoginNonce(expected.message);
    const acceptedMessages = expectedNonce
      ? [buildLoginMessage(expectedNonce), buildLegacyLoginMessage(expectedNonce)]
      : [expected.message];
    if (!acceptedMessages.includes(input.message)) return 'message_mismatch';
    if (expectedNonce && !input.message.includes(expectedNonce)) return 'message_mismatch';
    // fullMessage is display metadata from the wallet. If present, it must
    // describe the same signed message/nonce, but signature verification is
    // performed over the exact returned message.
    if (input.fullMessage) {
      if (!input.fullMessage.includes(input.message)) return 'message_not_in_signed_payload';
      if (expectedNonce && !input.fullMessage.includes(expectedNonce)) return 'message_not_in_signed_payload';
    }
    const publicKey = parseEd25519PublicKey(input.publicKey);
    if (!publicKey) return 'unsupported_public_key';
    const signature = new Ed25519Signature(input.signature);
    const signedBytes = new TextEncoder().encode(input.message);
    if (!publicKey.verifySignature({ message: signedBytes, signature })) {
      return 'signature_invalid';
    }
    const claimed = AccountAddress.from(normalizeAddress(input.address) ?? input.address);
    // Legacy Ed25519 accounts and SingleKey accounts derive different
    // addresses from the same key; Nova Desk accounts may be either.
    const legacy = AuthenticationKey.fromPublicKey({ publicKey }).derivedAddress();
    if (legacy.equals(claimed)) return null;
    const singleKey = AuthenticationKey.fromPublicKey({
      publicKey: new AnyPublicKey(publicKey)
    }).derivedAddress();
    if (singleKey.equals(claimed)) return null;
    return 'address_mismatch';
  } catch (error) {
    return `verify_error: ${error instanceof Error ? error.message : 'unknown'}`;
  }
}

export const verifyWalletSignature: SignatureVerifier = (input, expected) =>
  explainSignatureFailure(input, expected) === null;

function extractLoginNonce(message: string): string | null {
  const currentPrefix = `${LOGIN_MESSAGE}. Nonce: `;
  if (message.startsWith(currentPrefix)) return message.slice(currentPrefix.length);
  const legacyPrefix = `${LOGIN_MESSAGE}\nNonce: `;
  if (message.startsWith(legacyPrefix)) return message.slice(legacyPrefix.length);
  return null;
}

/** Accepts a raw 32-byte Ed25519 key or a BCS-serialized AnyPublicKey wrapping one. */
function parseEd25519PublicKey(raw: string): Ed25519PublicKey | null {
  let bytes: Uint8Array;
  try {
    bytes = Hex.fromHexInput(raw.trim()).toUint8Array();
  } catch {
    return null;
  }
  if (bytes.length === Ed25519PublicKey.LENGTH) {
    return new Ed25519PublicKey(bytes);
  }
  try {
    const any = AnyPublicKey.deserialize(new Deserializer(bytes));
    if (any.publicKey instanceof Ed25519PublicKey) {
      return any.publicKey;
    }
  } catch {
    // fall through
  }
  return null;
}

export type AdminFetcher = () => Promise<string[]>;

export type ViewCaller = (functionId: string) => Promise<string>;

type AdminAddressViewFunction =
  | 'get_primary_admin'
  | 'get_secondary_admin'
  | 'get_tertiary_admin';

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
      const results = await Promise.all([
        view(adminAddressViewId(opts.contractAddress, 'get_primary_admin')),
        view(adminAddressViewId(opts.contractAddress, 'get_secondary_admin')),
        view(adminAddressViewId(opts.contractAddress, 'get_tertiary_admin'))
      ]);
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

function adminAddressViewId(contractAddress: string, fn: AdminAddressViewFunction): string {
  return `${contractAddress}::wallet_treasury::${fn}`;
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
