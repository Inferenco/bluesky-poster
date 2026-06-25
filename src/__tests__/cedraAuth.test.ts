import { describe, expect, test, vi } from 'vitest';
import { Account, SigningSchemeInput } from '@cedra-labs/ts-sdk';
import {
  buildLegacyLoginMessage,
  buildLoginMessage,
  explainSignatureFailure,
  generateNonce,
  isAdmin,
  makeAdminFetcher,
  verifyWalletSignature,
  type VerifyInput
} from '../auth/cedraAuth.js';

const ZERO = '0x' + '0'.repeat(64);

function buildFullMessage(address: string, nonce: string, message: string): string {
  // Mirrors Nova Connect mobile fullMessage metadata.
  return ['CEDRA', '', address, nonce, '', message].join('\n');
}

function signedInput(overrides: Partial<VerifyInput> = {}): { input: VerifyInput; message: string } {
  const account = Account.generate();
  const nonce = generateNonce();
  const message = buildLoginMessage(nonce);
  const address = account.accountAddress.toString();
  const fullMessage = overrides.fullMessage ?? buildFullMessage(address, nonce, message);
  const signature = account.sign(new TextEncoder().encode(message));
  return {
    message,
    input: {
      message,
      nonce,
      fullMessage,
      signature: signature.toString(),
      publicKey: account.publicKey.toString(),
      address,
      ...overrides
    }
  };
}

describe('verifyWalletSignature', () => {
  test('accepts a valid one-line signature from the address owner', () => {
    const { input, message } = signedInput();
    expect(verifyWalletSignature(input, { message })).toBe(true);
  });

  test('accepts the legacy newline login message', () => {
    const account = Account.generate();
    const nonce = generateNonce();
    const message = buildLegacyLoginMessage(nonce);
    const address = account.accountAddress.toString();
    const signature = account.sign(new TextEncoder().encode(message));
    const input: VerifyInput = {
      message,
      nonce,
      fullMessage: buildFullMessage(address, nonce, message),
      signature: signature.toString(),
      publicKey: account.publicKey.toString(),
      address
    };
    expect(explainSignatureFailure(input, { message: buildLoginMessage(nonce) })).toBeNull();
  });

  test('accepts a wallet that signs the bare message as fullMessage (Nova Desk)', () => {
    const account = Account.generate();
    const message = buildLoginMessage(generateNonce());
    const signature = account.sign(new TextEncoder().encode(message));
    const input: VerifyInput = {
      message,
      fullMessage: message,
      signature: signature.toString(),
      publicKey: account.publicKey.toString(),
      address: account.accountAddress.toString()
    };
    expect(explainSignatureFailure(input, { message })).toBeNull();
  });

  test('rejects a challenge signed for a different nonce', () => {
    const { input } = signedInput();
    const expected = buildLoginMessage(generateNonce());
    expect(verifyWalletSignature(input, { message: expected })).toBe(false);
    expect(explainSignatureFailure(input, { message: expected })).toBe('message_mismatch');
  });

  test('rejects when the signed payload does not embed the challenge message', () => {
    const { input, message } = signedInput({ fullMessage: 'something else entirely' });
    expect(explainSignatureFailure(input, { message })).toBe('message_not_in_signed_payload');
  });

  test('rejects when the returned message omits the nonce', () => {
    const account = Account.generate();
    const nonce = generateNonce();
    const message = 'Sign in to the Inferenco poster dashboard';
    const address = account.accountAddress.toString();
    const signature = account.sign(new TextEncoder().encode(message));
    const input: VerifyInput = {
      message,
      nonce,
      fullMessage: buildFullMessage(address, nonce, message),
      signature: signature.toString(),
      publicKey: account.publicKey.toString(),
      address
    };
    expect(explainSignatureFailure(input, { message: buildLoginMessage(nonce) })).toBe('message_mismatch');
  });

  test('rejects a tampered message', () => {
    const { input, message } = signedInput();
    const tampered = { ...input, message: input.message + ' (tampered)' };
    expect(verifyWalletSignature(tampered, { message })).toBe(false);
  });

  test('rejects a signature from a different key', () => {
    const { input, message } = signedInput();
    const other = Account.generate();
    const forged = {
      ...input,
      signature: other.sign(new TextEncoder().encode(input.message)).toString()
    };
    expect(verifyWalletSignature(forged, { message })).toBe(false);
  });

  test('rejects when the public key does not derive the claimed address', () => {
    const { input, message } = signedInput();
    const impostor = { ...input, address: Account.generate().accountAddress.toString() };
    expect(verifyWalletSignature(impostor, { message })).toBe(false);
  });

  test('rejects malformed key material without throwing', () => {
    const { input, message } = signedInput();
    const malformed = { ...input, publicKey: 'not-hex' };
    expect(verifyWalletSignature(malformed, { message })).toBe(false);
  });

  test('accepts a single-key (non-legacy) ed25519 account', () => {
    // Nova Desk accounts use the SingleKey scheme: the address derives from
    // AnyPublicKey(ed25519), not the legacy ed25519 authentication key.
    const account = Account.generate({ scheme: SigningSchemeInput.Ed25519, legacy: false });
    const message = buildLoginMessage(generateNonce());
    const signature = account.privateKey.sign(new TextEncoder().encode(message));
    const input: VerifyInput = {
      message,
      fullMessage: message,
      signature: signature.toString(),
      publicKey: account.publicKey.publicKey.toString(),
      address: account.accountAddress.toString()
    };
    expect(explainSignatureFailure(input, { message })).toBeNull();
  });

  test('accepts a BCS-serialized AnyPublicKey as the public key', () => {
    const account = Account.generate({ scheme: SigningSchemeInput.Ed25519, legacy: false });
    const message = buildLoginMessage(generateNonce());
    const signature = account.privateKey.sign(new TextEncoder().encode(message));
    const input: VerifyInput = {
      message,
      fullMessage: message,
      signature: signature.toString(),
      publicKey: account.publicKey.bcsToHex().toString(),
      address: account.accountAddress.toString()
    };
    expect(explainSignatureFailure(input, { message })).toBeNull();
  });

  test('reports the failing check by name', () => {
    const { input, message } = signedInput();
    const impostor = { ...input, address: Account.generate().accountAddress.toString() };
    expect(explainSignatureFailure(impostor, { message })).toBe('address_mismatch');
    const forged = { ...input, signature: '0x' + 'ab'.repeat(64) };
    expect(explainSignatureFailure(forged, { message })).toBe('signature_invalid');
  });
});

describe('makeAdminFetcher', () => {
  const PRIMARY = '0x' + '1'.repeat(64);
  const SECONDARY = '0xab';

  test('fetches the three admin view functions and filters out 0x0', async () => {
    const view = vi.fn(async (fn: string) => {
      if (fn.endsWith('get_primary_admin')) return PRIMARY;
      if (fn.endsWith('get_secondary_admin')) return SECONDARY;
      return ZERO;
    });
    const fetchAdmins = makeAdminFetcher({
      fullnodeUrl: 'http://unused',
      contractAddress: '0xc0ffee',
      ttlMs: 60_000,
      view
    });

    const admins = await fetchAdmins();

    expect(view).toHaveBeenCalledTimes(3);
    expect(view.mock.calls.map(([fn]) => fn)).toEqual([
      '0xc0ffee::wallet_treasury::get_primary_admin',
      '0xc0ffee::wallet_treasury::get_secondary_admin',
      '0xc0ffee::wallet_treasury::get_tertiary_admin'
    ]);
    expect(admins).toHaveLength(2);
    expect(isAdmin(PRIMARY, admins)).toBe(true);
    expect(isAdmin(SECONDARY, admins)).toBe(true);
    expect(isAdmin(ZERO, admins)).toBe(false);
  });

  test('serves cached admins within the TTL', async () => {
    const view = vi.fn(async () => PRIMARY);
    const fetchAdmins = makeAdminFetcher({
      fullnodeUrl: 'http://unused',
      contractAddress: '0x1',
      ttlMs: 60_000,
      view
    });

    await fetchAdmins();
    await fetchAdmins();

    expect(view).toHaveBeenCalledTimes(3); // one fetch = three view calls
  });

  test('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const view = vi.fn(async () => PRIMARY);
      const fetchAdmins = makeAdminFetcher({
        fullnodeUrl: 'http://unused',
        contractAddress: '0x1',
        ttlMs: 1000,
        view
      });

      await fetchAdmins();
      vi.advanceTimersByTime(1500);
      await fetchAdmins();

      expect(view).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  test('serves stale admins when a refetch fails', async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      const view = vi.fn(async () => {
        if (fail) throw new Error('fullnode down');
        return PRIMARY;
      });
      const fetchAdmins = makeAdminFetcher({
        fullnodeUrl: 'http://unused',
        contractAddress: '0x1',
        ttlMs: 1000,
        view
      });

      const first = await fetchAdmins();
      fail = true;
      vi.advanceTimersByTime(1500);
      const second = await fetchAdmins();

      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test('throws when the first fetch fails and no cache exists', async () => {
    const fetchAdmins = makeAdminFetcher({
      fullnodeUrl: 'http://unused',
      contractAddress: '0x1',
      ttlMs: 1000,
      view: async () => {
        throw new Error('fullnode down');
      }
    });

    await expect(fetchAdmins()).rejects.toThrow('fullnode down');
  });
});

describe('isAdmin', () => {
  test('compares addresses after normalization', () => {
    const longForm = '0x' + '0'.repeat(63) + '1';
    expect(isAdmin('0x1', [longForm])).toBe(true);
    expect(isAdmin(longForm, ['0x1'])).toBe(true);
    expect(isAdmin('0x2', [longForm])).toBe(false);
  });

  test('rejects garbage input without throwing', () => {
    expect(isAdmin('not-an-address', ['0x1'])).toBe(false);
  });
});
