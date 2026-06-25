/// <reference lib="dom" />
import { WalletCore } from '@cedra-labs/wallet-adapter-core';
import { Network } from '@cedra-labs/ts-sdk';
import { registerNovaWallet } from '@inferenco/nova-wallet-adapter/aip62';
import { tryResumeNovaWalletConnection, NOVA_CONNECT_NAME } from '@inferenco/nova-wallet-adapter';

const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

registerNovaWallet({
  forceRegistration: true,
  websiteUrl: isMobile ? 'https://inferenco.com/nova-wallet' : 'https://inferenco.com/nova-desk',
  desktopRegistration: true,
  detectAliases: true
});

const core = new WalletCore([], { network: Network.TESTNET });

const buttonsEl = document.getElementById('wallet-buttons') as HTMLElement;
const statusEl = document.getElementById('wallet-status') as HTMLElement;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const PENDING_LOGIN_KEY = 'inferenco_poster_pending_wallet_login';
const PENDING_LOGIN_MAX_AGE_MS = 10 * 60_000;

interface LoginChallenge {
  nonce: string;
  message: string;
}

interface PendingLogin {
  walletName: string;
  stage: 'connect' | 'sign';
  startedAt: number;
  challenge?: LoginChallenge;
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function renderWalletButtons(): void {
  const wallets = [...core.wallets];
  const novaIndex = wallets.findIndex(w => w.name === NOVA_CONNECT_NAME);
  if (novaIndex > 0) {
    const [nova] = wallets.splice(novaIndex, 1);
    wallets.unshift(nova);
  }

  buttonsEl.replaceChildren();
  if (wallets.length === 0) {
    setStatus('No Cedra wallets detected. Install Nova Wallet to continue.');
    return;
  }

  for (const wallet of wallets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button primary';
    button.textContent = `Connect ${wallet.name}`;
    button.addEventListener('click', () => {
      void signIn(wallet.name);
    });
    buttonsEl.append(button);
  }
}

async function signIn(
  walletName: string,
  options: { useExistingConnection?: boolean; challenge?: LoginChallenge } = {}
): Promise<void> {
  const allButtons = buttonsEl.querySelectorAll('button');
  allButtons.forEach(b => { b.disabled = true; });
  try {
    const useCurrentConnection = options.useExistingConnection || core.isConnected();
    if (!useCurrentConnection) {
      setStatus('Connecting wallet...');
      rememberPendingLogin({ walletName, stage: 'connect' });
      // A resumed session may point at a previously used account; drop it so
      // the wallet prompts fresh (connect() also throws if already connected).
      if (core.isConnected()) {
        try {
          await core.disconnect();
        } catch {
          // stale session - safe to continue with a fresh connect
        }
      }
      await core.connect(walletName);
    } else if (!core.isConnected()) {
      setStatus('Restoring wallet connection...');
      rememberPendingLogin({ walletName, stage: 'connect' });
      await core.connect(walletName);
    }

    const account = core.account;
    if (!account) {
      throw new Error('Wallet did not return an account');
    }

    let challenge = options.challenge;
    const pending = readPendingLogin();
    if (!challenge && pending?.stage === 'sign' && pending.walletName === walletName) {
      challenge = pending.challenge;
    }
    if (!challenge) {
      setStatus('Requesting login challenge...');
      const nonceRes = await fetchWithTimeout('/api/auth/nonce');
      if (!nonceRes.ok) throw new Error('Could not get login challenge from server');
      challenge = (await nonceRes.json()) as LoginChallenge;
    }

    setStatus('Waiting for signature...');
    rememberPendingLogin({ walletName, stage: 'sign', challenge });
    const signed = await core.signMessage({ message: challenge.message, nonce: challenge.nonce });

    setStatus('Verifying...');
    const verifyRes = await fetchWithTimeout('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: signed.message,
        nonce: signed.nonce,
        fullMessage: signed.fullMessage,
        signature: String(signed.signature),
        publicKey: String(account.publicKey),
        address: String(account.address)
      })
    });

    if (verifyRes.ok) {
      clearPendingLogin();
      window.location.href = '/';
      return;
    }
    clearPendingLogin();
    if (verifyRes.status === 403) {
      setStatus('This wallet is not an admin of the treasury contract.', true);
    } else if (verifyRes.status === 502) {
      setStatus('Could not verify treasury admins. Check the contract or fullnode URL.', true);
    } else {
      const error = await readAuthError(verifyRes);
      setStatus(error ? `Signature verification failed: ${error}` : 'Signature verification failed. Please try again.', true);
    }
  } catch (error) {
    clearPendingLogin();
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      setStatus('Verification timed out. Check the server logs and try again.', true);
    } else {
      setStatus(describeError(error), true);
    }
  } finally {
    allButtons.forEach(b => { b.disabled = false; });
  }
}

async function resumePendingLogin(): Promise<void> {
  const pending = readPendingLogin();
  if (!pending) {
    void tryResumeNovaWalletConnection(core);
    return;
  }

  try {
    setStatus('Restoring Nova Connect session...');
    await tryResumeNovaWalletConnection(core);
    if (core.isConnected()) {
      setStatus(
        pending.stage === 'sign'
          ? 'Wallet connected. Tap Connect Nova Connect to continue signing in.'
          : 'Wallet connected. Tap Connect Nova Connect to sign in.'
      );
      return;
    }
    setStatus('Return from Nova Wallet detected. Tap Connect Nova Connect to continue.');
  } catch {
    clearPendingLogin();
    setStatus('Could not restore the wallet session. Please connect again.', true);
  }
}

function rememberPendingLogin(input: Omit<PendingLogin, 'startedAt'>): void {
  try {
    localStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify({
      ...input,
      startedAt: Date.now()
    } satisfies PendingLogin));
  } catch {
    // Local storage may be unavailable in restricted browsers; login can
    // still continue while the current page remains alive.
  }
}

function readPendingLogin(): PendingLogin | null {
  try {
    const raw = localStorage.getItem(PENDING_LOGIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingLogin;
    if (!parsed.walletName || Date.now() - parsed.startedAt > PENDING_LOGIN_MAX_AGE_MS) {
      clearPendingLogin();
      return null;
    }
    return parsed;
  } catch {
    clearPendingLogin();
    return null;
  }
}

function clearPendingLogin(): void {
  try {
    localStorage.removeItem(PENDING_LOGIN_KEY);
  } catch {
    // no-op
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  // wallet-adapter-core sometimes throws plain strings (e.g. "already connected")
  if (typeof error === 'string' && error.trim()) return error;
  return 'Wallet connection failed.';
}

async function readAuthError(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

core.on('standardWalletsAdded', renderWalletButtons);
renderWalletButtons();
void resumePendingLogin();
