import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: null as any,
  core: {
    wallets: [{ name: 'Infer Connect' }],
    account: { address: '0x123', publicKey: '0xabc' },
    isConnected: vi.fn(() => true),
    connect: vi.fn(),
    disconnect: vi.fn(),
    signMessage: vi.fn(),
    on: vi.fn()
  },
  resume: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  reconcile: vi.fn(),
  relaunch: vi.fn(),
  acknowledge: vi.fn()
}));

vi.mock('@cedra-labs/wallet-adapter-core', () => ({
  WalletCore: class { constructor() { return mocks.core; } }
}));
vi.mock('@inferenco/infer-wallet-adapter/aip62', () => ({
  registerInferWallet: (options: any) => { mocks.options = options; }
}));
vi.mock('@inferenco/infer-wallet-adapter', () => ({
  INFER_CONNECT_NAME: 'Infer Connect',
  tryResumeInferWalletConnection: mocks.resume,
  listRecoverableRequests: mocks.list,
  readRecoverableRequest: mocks.read,
  reconcileRecoverableInvocation: mocks.reconcile,
  relaunchRecoverableInvocation: mocks.relaunch,
  acknowledgeRecoverableRequest: mocks.acknowledge
}));

class Element {
  textContent = '';
  disabled = false;
  type = '';
  className = '';
  children: Element[] = [];
  listeners = new Map<string, () => void>();
  classList = { toggle: vi.fn() };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  querySelectorAll() { return this.children; }
  addEventListener(event: string, fn: () => void) { this.listeners.set(event, fn); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}

const key = 'inferenco_poster_pending_login_v2';
const challenge = { nonce: 'nonce-1', message: 'Sign in. Nonce: nonce-1' };
const invocation = {
  invocationId: 'inv-1', sessionId: 'session-1', address: '0x123',
  network: 'testnet', chainId: 250, method: 'signMessage',
  transport: 'mobile-relay', state: 'prepared'
};
const request = { ...invocation, requestId: 'request-1' };
const receipt = { ...request, recoveryId: 'recovery-1' };
const signed = {
  message: challenge.message, nonce: '', fullMessage: challenge.message,
  signature: '0xsignature', prefix: 'CEDRA'
};
const approved = { ...receipt, status: 'approved', output: signed };

let buttons: Element;
let status: Element;
let storage: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let events: Map<string, () => void>;
let location: { origin: string; href: string };

function savedContext(overrides: Record<string, unknown> = {}) {
  return {
    challenge: { ...challenge, createdAt: Date.now() },
    address: '0x123', publicKey: '0xabc',
    invocationId: 'inv-1', requestId: 'request-1', sessionId: 'session-1',
    ...overrides
  };
}

function click(label: string) {
  const element = buttons.children.find(child => child.textContent === label);
  expect(element, 'Expected button: ' + label).toBeDefined();
  expect(element!.disabled).toBe(false);
  element!.click();
}

async function boot() {
  await import('../../src/frontend/login.js');
  await vi.waitFor(() => expect(location.href === '/' || buttons.children.some(child => !child.disabled)).toBe(true));
}

async function signReady() {
  await vi.waitFor(() => expect(
    buttons.children.find(child => child.textContent === 'Sign in with Infer Connect')?.disabled
  ).toBe(false));
  click('Sign in with Infer Connect');
}

function verifyCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/auth/verify');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  buttons = new Element();
  status = new Element();
  storage = new Map();
  events = new Map();
  location = { origin: 'http://localhost:3000', href: 'http://localhost:3000/' };
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => storage.set(name, value),
    removeItem: (name: string) => storage.delete(name)
  });
  vi.stubGlobal('document', {
    getElementById: (id: string) => id === 'wallet-buttons' ? buttons : status,
    createElement: () => new Element(),
    addEventListener: (name: string, listener: () => void) => events.set(name, listener),
    visibilityState: 'visible'
  });
  vi.stubGlobal('window', {
    location,
    addEventListener: (name: string, listener: () => void) => events.set(name, listener)
  });
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/nonce') return Response.json(challenge);
    if (url === '/api/auth/verify') return Response.json({ ok: true });
    throw new Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.core.isConnected.mockReturnValue(true);
  mocks.resume.mockResolvedValue(true);
  mocks.list.mockResolvedValue([]);
  mocks.read.mockResolvedValue(approved);
  mocks.reconcile.mockResolvedValue({ ...receipt, status: 'pending' });
  mocks.acknowledge.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.core.signMessage.mockImplementation(async () => {
    await mocks.options.onInvocationPrepared(invocation);
    await mocks.options.onRequestCreated(request);
    mocks.list.mockResolvedValue([receipt]);
    return signed;
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Infer Connect sign-in', () => {
  test('uses the adapter for signing and accepts the desktop empty nonce echo', async () => {
    await boot();
    await signReady();
    await vi.waitFor(() => expect(location.href).toBe('/'));
    expect(mocks.resume).toHaveBeenCalledWith(mocks.core);
    expect(mocks.options).toMatchObject({
      expectedOrigin: location.origin, mobileReturnMode: 'resume-browser-v1', forceRegistration: true
    });
    expect(mocks.core.signMessage).toHaveBeenCalledExactlyOnceWith(challenge);
    expect(verifyCalls()).toHaveLength(1);
    expect(JSON.parse(verifyCalls()[0][1].body)).toMatchObject({
      message: challenge.message, nonce: '', signature: signed.signature, address: '0x123', publicKey: '0xabc'
    });
    expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith('recovery-1');
    expect(storage.has(key)).toBe(false);
  });

  test('deduplicates direct signing and recovered delivery before consuming the nonce', async () => {
    let approveServer!: (value: Response) => void;
    fetchMock.mockImplementation(async (url: string) => url === '/api/auth/nonce'
      ? Response.json(challenge)
      : new Promise<Response>(resolve => { approveServer = resolve; }));
    mocks.core.signMessage.mockImplementation(async () => {
      await mocks.options.onInvocationPrepared(invocation);
      await mocks.options.onRequestCreated(request);
      void mocks.options.onRecoveredOutcome(approved);
      return signed;
    });
    await boot();
    await signReady();
    await vi.waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect(buttons.children.find(child => child.textContent === 'Cancel sign-in')?.disabled).toBe(true);
    await mocks.options.onRecoveredOutcome({ ...approved, invocationId: 'unrelated' });
    expect(verifyCalls()).toHaveLength(1);
    approveServer(Response.json({ ok: true }));
    await vi.waitFor(() => expect(location.href).toBe('/'));
    await mocks.options.onRecoveredOutcome(approved);
    expect(verifyCalls()).toHaveLength(1);
  });

  test('recovers the original login after reload without replacing the server nonce', async () => {
    storage.set(key, JSON.stringify(savedContext()));
    mocks.list.mockResolvedValue([receipt]);
    await boot();
    await vi.waitFor(() => expect(location.href).toBe('/'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/verify']);
    expect(mocks.core.signMessage).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('recovery-1');
  });

  test.each(['inferRequestId', 'novaRequestId'])(
    'does not replace the original nonce when a %s callback opens in a new tab',
    async parameter => {
      location.href += '?' + parameter + '=request-1';
      mocks.resume.mockImplementationOnce(async () => {
        // The adapter consumes callback parameters while restoring its session.
        location.href = location.origin + '/';
        await mocks.options.onRecoveredOutcome(approved);
        return true;
      });
      await import('../../src/frontend/login.js');
      await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalled());
      expect(status.textContent).toContain('original sign-in tab');
      expect(buttons.children.map(child => child.textContent)).toEqual(['Start a new sign-in here']);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.core.signMessage).not.toHaveBeenCalled();
      events.get('focus')?.();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  test('allows an explicit fresh sign-in after a connection callback without a pending signature', async () => {
    location.href += '?inferRequestId=connect-request';
    await boot();
    expect(fetchMock).not.toHaveBeenCalled();
    click('Start a new sign-in here');
    await signReady();
    await vi.waitFor(() => expect(location.href).toBe('/'));
    expect(mocks.core.signMessage).toHaveBeenCalledExactlyOnceWith(challenge);
  });

  test('re-enables cancellation after a recovered verification request times out', async () => {
    storage.set(key, JSON.stringify(savedContext()));
    await boot();
    fetchMock.mockRejectedValueOnce(new Error('Verification request timed out'));
    mocks.list.mockResolvedValue([receipt]);
    click('Check signature');
    await vi.waitFor(() => expect(status.textContent).toContain('timed out'));
    click('Cancel sign-in');
    expect(storage.has(key)).toBe(false);
  });

  test('keeps an unknown request after WalletCore flattens its error to a string', async () => {
    mocks.core.signMessage.mockImplementation(async () => {
      await mocks.options.onInvocationPrepared(invocation);
      await mocks.options.onRequestCreated(request);
      throw 'Wallet result not yet confirmed';
    });
    await boot();
    await signReady();
    await vi.waitFor(() => expect(status.textContent).toContain('not yet confirmed'));
    expect(JSON.parse(storage.get(key)!)).toMatchObject({
      invocationId: 'inv-1', requestId: 'request-1', sessionId: 'session-1'
    });
    expect(storage.get(key)).not.toMatch(/sharedSecret|sessionToken|dappSessionToken/);
    click('Check signature');
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith('inv-1'));
    expect(mocks.core.signMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/nonce')).toHaveLength(1);
  });

  test('ignores another request, session, account, or challenge during recovery', async () => {
    storage.set(key, JSON.stringify(savedContext()));
    await boot();
    for (const change of [
      { requestId: 'wrong' }, { sessionId: 'wrong' },
      { address: '0x999' }, { invocationId: 'wrong' },
      { method: 'signTransaction' }, { output: { ...signed, message: 'wrong' } },
      { output: { ...signed, nonce: 'wrong' } }
    ]) await mocks.options.onRecoveredOutcome({ ...approved, ...change });
    expect(verifyCalls()).toHaveLength(0);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  test('does not offer mobile relaunch for an outstanding desktop request', async () => {
    mocks.core.signMessage.mockImplementation(async () => {
      await mocks.options.onInvocationPrepared({ ...invocation, transport: 'desktop-bridge' });
      await mocks.options.onRequestCreated(request);
      throw 'Desktop approval is still pending';
    });
    await boot();
    await signReady();
    await vi.waitFor(() => expect(status.textContent).toContain('Desktop approval'));
    expect(buttons.children.some(child => child.textContent === 'Open Infer Wallet')).toBe(false);
    expect(buttons.children.some(child => child.textContent === 'Check signature')).toBe(true);
  });

  test('does not accept a late signature after the user cancels sign-in', async () => {
    let resolveSignature!: (value: typeof signed) => void;
    mocks.core.signMessage.mockImplementation(async () => {
      await mocks.options.onInvocationPrepared(invocation);
      await mocks.options.onRequestCreated(request);
      return new Promise(resolve => { resolveSignature = resolve; });
    });
    await boot();
    await signReady();
    await vi.waitFor(() => expect(JSON.parse(storage.get(key)!).requestId).toBe('request-1'));
    expect(buttons.children.find(child => child.textContent === 'Open Infer Wallet')?.disabled).toBe(false);
    click('Open Infer Wallet');
    expect(mocks.relaunch).toHaveBeenCalledWith('inv-1');
    click('Cancel sign-in');
    resolveSignature(signed);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(verifyCalls()).toHaveLength(0);
    expect(storage.has(key)).toBe(false);
    await vi.waitFor(() => expect(
      buttons.children.find(child => child.textContent === 'Sign in with Infer Connect')?.disabled
    ).toBe(false));
  });

  test('discards an expired pending challenge and requires a new explicit signature', async () => {
    storage.set(key, JSON.stringify(savedContext({
      challenge: { ...challenge, createdAt: Date.now() - 6 * 60_000 }
    })));
    await boot();
    expect(mocks.core.signMessage).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/nonce']);
  });
});
