/// <reference lib="dom" />
import { WalletCore } from '@cedra-labs/wallet-adapter-core';
import { Network } from '@cedra-labs/ts-sdk';
import { registerNovaWallet } from '@inferenco/nova-wallet-adapter/aip62';
import {
  tryResumeNovaWalletConnection,
  readValidatedExternalSession,
  signMessageViaMobileRelay,
  NOVA_CONNECT_NAME
} from '@inferenco/nova-wallet-adapter';

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
let loginChallenge: LoginChallenge | null = null;
let loginChallengeRequest: Promise<LoginChallenge> | null = null;

interface LoginChallenge {
  nonce: string;
  message: string;
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
  if (core.isConnected() && core.account) {
    const account = core.account;
    void prepareLoginChallenge().catch(error => {
      setStatus(describeError(error), true);
    });
    const signButton = document.createElement('button');
    signButton.type = 'button';
    signButton.className = 'button primary';
    signButton.textContent = 'Sign in with Nova Wallet';
    signButton.disabled = !loginChallenge;
    signButton.addEventListener('click', () => {
      void signInConnectedWallet();
    });

    const disconnectButton = document.createElement('button');
    disconnectButton.type = 'button';
    disconnectButton.className = 'button';
    disconnectButton.textContent = 'Disconnect';
    disconnectButton.addEventListener('click', () => {
      void disconnectWallet();
    });

    buttonsEl.append(signButton, disconnectButton);
    setStatus(
      loginChallenge
        ? `Wallet connected: ${shortAddress(String(account.address))}`
        : 'Wallet connected. Preparing sign-in challenge...'
    );
    return;
  }

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
      void connectWallet(wallet.name);
    });
    buttonsEl.append(button);
  }
}

async function connectWallet(walletName: string): Promise<void> {
  const allButtons = buttonsEl.querySelectorAll('button');
  allButtons.forEach(b => { b.disabled = true; });
  try {
    setStatus('Connecting wallet...');
    await core.connect(walletName);
    await prepareLoginChallenge();
    renderWalletButtons();
    setStatus('Wallet connected. Tap Sign in with Nova Wallet to continue.');
  } catch (error) {
    if (core.isConnected() && core.account) {
      renderWalletButtons();
      setStatus('Wallet connected. Tap Sign in with Nova Wallet to continue.');
    } else {
      setStatus(describeError(error), true);
    }
  } finally {
    allButtons.forEach(b => { b.disabled = false; });
  }
}

async function disconnectWallet(): Promise<void> {
  try {
    await core.disconnect();
  } catch {
    // Already disconnected or stale wallet state; render from current core state.
  } finally {
    clearLoginChallenge();
    renderWalletButtons();
  }
}

async function signInConnectedWallet(): Promise<void> {
  const allButtons = buttonsEl.querySelectorAll('button');
  allButtons.forEach(b => { b.disabled = true; });
  try {
    if (!core.isConnected()) {
      throw new Error('Wallet is not connected');
    }

    const account = core.account;
    if (!account) {
      throw new Error('Wallet did not return an account');
    }

    const challenge = loginChallenge;
    if (!challenge) {
      setStatus('Sign-in challenge is still loading. Please try again.', true);
      void prepareLoginChallenge();
      return;
    }

    setStatus('Opening Nova Wallet for signature...');
    const signPayload = {
      address: true,
      application: true,
      chainId: true,
      message: challenge.message,
      nonce: challenge.nonce
    };
    const signed = await signMessageWithNova(signPayload);

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
    clearLoginChallenge();
    if (verifyRes.status === 403) {
      setStatus('This wallet is not an admin of the treasury contract.', true);
    } else if (verifyRes.status === 502) {
      setStatus('Could not verify treasury admins. Check the contract or fullnode URL.', true);
    } else {
      const error = await readAuthError(verifyRes);
      setStatus(error ? `Signature verification failed: ${error}` : 'Signature verification failed. Please try again.', true);
    }
  } catch (error) {
    clearLoginChallenge();
    void prepareLoginChallenge().catch(() => {
      // The original signing error is more useful to show here.
    });
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      setStatus('Verification timed out. Check the server logs and try again.', true);
    } else {
      setStatus(describeError(error), true);
    }
  } finally {
    allButtons.forEach(b => { b.disabled = false; });
  }
}

async function signMessageWithNova(input: Parameters<typeof core.signMessage>[0]): ReturnType<typeof core.signMessage> {
  if (isMobile) {
    const session = await readValidatedExternalSession();
    if (session?.transport === 'mobile-relay') {
      return signMessageViaMobileRelay(input, session);
    }
  }
  return core.signMessage(input);
}

async function prepareLoginChallenge(): Promise<LoginChallenge> {
  if (loginChallenge) return loginChallenge;
  if (loginChallengeRequest) return loginChallengeRequest;
  loginChallengeRequest = fetchLoginChallenge()
    .then(challenge => {
      loginChallenge = challenge;
      renderWalletButtons();
      return challenge;
    })
    .finally(() => {
      loginChallengeRequest = null;
    });
  return loginChallengeRequest;
}

async function fetchLoginChallenge(): Promise<LoginChallenge> {
  const nonceRes = await fetchWithTimeout('/api/auth/nonce');
  if (!nonceRes.ok) throw new Error('Could not get login challenge from server');
  return (await nonceRes.json()) as LoginChallenge;
}

function clearLoginChallenge(): void {
  loginChallenge = null;
  loginChallengeRequest = null;
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

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
}

core.on('standardWalletsAdded', renderWalletButtons);
core.on('connect', renderWalletButtons);
core.on('disconnect', renderWalletButtons);
core.on('accountChange', renderWalletButtons);
renderWalletButtons();
