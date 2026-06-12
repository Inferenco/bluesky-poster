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
void tryResumeNovaWalletConnection(core);

const buttonsEl = document.getElementById('wallet-buttons') as HTMLElement;
const statusEl = document.getElementById('wallet-status') as HTMLElement;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

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

async function signIn(walletName: string): Promise<void> {
  const allButtons = buttonsEl.querySelectorAll('button');
  allButtons.forEach(b => { b.disabled = true; });
  try {
    setStatus('Connecting wallet...');
    // A resumed session may point at a previously used account; drop it so
    // the wallet prompts fresh (connect() also throws if already connected).
    if (core.isConnected()) {
      try {
        await core.disconnect();
      } catch {
        // stale session — safe to continue with a fresh connect
      }
    }
    await core.connect(walletName);
    const account = core.account;
    if (!account) {
      throw new Error('Wallet did not return an account');
    }

    setStatus('Requesting login challenge...');
    const nonceRes = await fetchWithTimeout('/api/auth/nonce');
    if (!nonceRes.ok) throw new Error('Could not get login challenge from server');
    const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };

    setStatus('Waiting for signature...');
    const signed = await core.signMessage({ message, nonce });

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
      window.location.href = '/';
      return;
    }
    if (verifyRes.status === 403) {
      setStatus('This wallet is not an admin of the treasury contract.', true);
    } else if (verifyRes.status === 502) {
      setStatus('Could not verify treasury admins. Check the contract or fullnode URL.', true);
    } else {
      const error = await readAuthError(verifyRes);
      setStatus(error ? `Signature verification failed: ${error}` : 'Signature verification failed. Please try again.', true);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      setStatus('Verification timed out. Check the server logs and try again.', true);
    } else {
      setStatus(describeError(error), true);
    }
  } finally {
    allButtons.forEach(b => { b.disabled = false; });
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
