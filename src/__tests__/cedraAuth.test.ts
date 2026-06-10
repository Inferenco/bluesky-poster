import { describe, expect, test, vi } from 'vitest';
import { Account } from '@cedra-labs/ts-sdk';
import {
  LOGIN_MESSAGE,
  generateNonce,
  isAdmin,
  makeAdminFetcher,
  verifyWalletSignature,
  type VerifyInput
} from '../auth/cedraAuth.js';

const ZERO = '0x' + '0'.repeat(64);

function buildFullMessage(address: string, nonce: string, message: string): string {
  // Mirrors the Nova wallet adapter's createFullMessage.
  return ['CEDRA', '', address, nonce, '', message].join('\n');
}

function signedInput(overrides: Partial<VerifyInput> = {}): { input: VerifyInput; nonce: string } {
  const account = Account.generate();
  const nonce = generateNonce();
  const address = account.accountAddress.toString();
  const fullMessage = overrides.fullMessage ?? buildFullMessage(address, nonce, LOGIN_MESSAGE);
  const signature = account.sign(new TextEncoder().encode(fullMessage));
  return {
    nonce,
    input: {
      message: LOGIN_MESSAGE,
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
  test('accepts a valid signature from the address owner', () => {
    const { input, nonce } = signedInput();
    expect(verifyWalletSignature(input, { nonce, message: LOGIN_MESSAGE })).toBe(true);
  });

  test('rejects a mismatched nonce', () => {
    const { input } = signedInput();
    expect(verifyWalletSignature(input, { nonce: generateNonce(), message: LOGIN_MESSAGE })).toBe(false);
  });

  test('rejects when the signed payload does not embed the nonce', () => {
    const account = Account.generate();
    const nonce = generateNonce();
    const fullMessage = buildFullMessage(account.accountAddress.toString(), 'other-nonce', LOGIN_MESSAGE);
    const signature = account.sign(new TextEncoder().encode(fullMessage));
    const input: VerifyInput = {
      message: LOGIN_MESSAGE,
      nonce,
      fullMessage,
      signature: signature.toString(),
      publicKey: account.publicKey.toString(),
      address: account.accountAddress.toString()
    };
    expect(verifyWalletSignature(input, { nonce, message: LOGIN_MESSAGE })).toBe(false);
  });

  test('rejects a tampered message', () => {
    const { input, nonce } = signedInput();
    const tampered = { ...input, fullMessage: input.fullMessage + ' (tampered)' };
    expect(verifyWalletSignature(tampered, { nonce, message: LOGIN_MESSAGE })).toBe(false);
  });

  test('rejects a signature from a different key', () => {
    const { input, nonce } = signedInput();
    const other = Account.generate();
    const forged = {
      ...input,
      signature: other.sign(new TextEncoder().encode(input.fullMessage)).toString()
    };
    expect(verifyWalletSignature(forged, { nonce, message: LOGIN_MESSAGE })).toBe(false);
  });

  test('rejects when the public key does not derive the claimed address', () => {
    const { input, nonce } = signedInput();
    const impostor = { ...input, address: Account.generate().accountAddress.toString() };
    expect(verifyWalletSignature(impostor, { nonce, message: LOGIN_MESSAGE })).toBe(false);
  });

  test('rejects malformed key material without throwing', () => {
    const { input, nonce } = signedInput();
    const malformed = { ...input, publicKey: 'not-hex' };
    expect(verifyWalletSignature(malformed, { nonce, message: LOGIN_MESSAGE })).toBe(false);
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
