/// <reference lib="dom" />
import { WalletCore } from '@cedra-labs/wallet-adapter-core';
import { Network } from '@cedra-labs/ts-sdk';
import { registerNovaWallet } from '@inferenco/nova-wallet-adapter/aip62';
import {
  tryResumeNovaWalletConnection,
  readValidatedExternalSession,
  fetchJsonWithTimeout,
  encryptJson,
  decryptJson,
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
const MOBILE_RELAY_BASE_URL = 'https://nova-service-160604102004.europe-west1.run.app';
const PENDING_SIGN_REQUEST_KEY = 'inferenco_poster_pending_sign_request';
const PENDING_SIGN_MAX_AGE_MS = 5 * 60_000;
let loginChallenge: LoginChallenge | null = null;
let loginChallengeRequest: Promise<LoginChallenge> | null = null;

interface LoginChallenge {
  nonce: string;
  message: string;
}

interface PendingSignRequest {
  requestId: string;
  walletDeeplinkUrl: string;
  relayBaseUrl: string;
  sessionToken: string;
  sharedSecret: string;
  challenge: LoginChallenge;
  address: string;
  publicKey: string;
  createdAt: number;
}

interface MobileRequestCreateResponse {
  requestId: string;
  walletDeeplinkUrl: string;
}

interface MobileRequestStatusResponse {
  status: string;
  encryptedResult?: unknown;
  errorMessage?: string;
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
  const pendingSignRequest = readPendingSignRequest();
  if (pendingSignRequest) {
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'button primary';
    openButton.textContent = 'Open Nova Wallet to sign';
    openButton.addEventListener('click', () => {
      window.location.href = pendingSignRequest.walletDeeplinkUrl;
    });

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'button';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
      clearPendingSignRequest();
      clearLoginChallenge();
      renderWalletButtons();
    });

    buttonsEl.append(openButton, cancelButton);
    setStatus('Signature request is pending. Open Nova Wallet to approve it, then return here.');
    void resumePendingSignRequest().catch(error => {
      setStatus(describeError(error), true);
    });
    return;
  }

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
    const signed = await signMessageWithNova(signPayload, challenge, account);

    await verifySignedLogin(signed, {
      address: String(account.address),
      publicKey: String(account.publicKey)
    });
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

async function signMessageWithNova(
  input: Parameters<typeof core.signMessage>[0],
  challenge: LoginChallenge,
  account: NonNullable<typeof core.account>
): ReturnType<typeof core.signMessage> {
  if (isMobile) {
    const session = await readValidatedExternalSession();
    if (session?.transport === 'mobile-relay' && session.dappSessionToken && session.sharedSecret) {
      const relayBaseUrl = session.relayBaseUrl ?? MOBILE_RELAY_BASE_URL;
      const response = await fetchJsonWithTimeout<MobileRequestCreateResponse>(
        buildRelayUrl(relayBaseUrl, '/v1/requests'),
        AUTH_REQUEST_TIMEOUT_MS,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: session.sessionId,
            dappSessionToken: session.dappSessionToken,
            method: 'signMessage',
            callbackUrl: callbackUrlWithoutMarkers(),
            encryptedRequest: encryptJson(input, session.sharedSecret),
            requestMetadata: {
              origin: window.location.origin,
              appName: document.title || 'Inferenco Poster'
            }
          })
        }
      );
      rememberPendingSignRequest({
        requestId: response.requestId,
        walletDeeplinkUrl: response.walletDeeplinkUrl,
        relayBaseUrl,
        sessionToken: session.dappSessionToken,
        sharedSecret: session.sharedSecret,
        challenge,
        address: String(account.address),
        publicKey: String(account.publicKey),
        createdAt: Date.now()
      });
      window.location.href = response.walletDeeplinkUrl;
      throw new Error('Signature request opened in Nova Wallet. Return here after approving.');
    }
  }
  return core.signMessage(input);
}

async function resumePendingSignRequest(): Promise<void> {
  const pending = readPendingSignRequest();
  if (!pending) return;

  const result = await fetchJsonWithTimeout<MobileRequestStatusResponse>(
    buildRelayUrl(pending.relayBaseUrl, `/v1/requests/${encodeURIComponent(pending.requestId)}`),
    AUTH_REQUEST_TIMEOUT_MS,
    {
      headers: {
        'x-nova-session-token': pending.sessionToken
      }
    }
  );

  if (result.status === 'approved' && result.encryptedResult) {
    const signed = decryptJson(result.encryptedResult, pending.sharedSecret) as Awaited<ReturnType<typeof core.signMessage>>;
    clearPendingSignRequest();
    await verifySignedLogin(signed, {
      address: pending.address,
      publicKey: pending.publicKey
    });
    return;
  }

  if (['rejected', 'expired', 'cancelled', 'revoked'].includes(result.status)) {
    clearPendingSignRequest();
    clearLoginChallenge();
    setStatus(result.errorMessage ?? `Nova signature request ${result.status}.`, true);
  }
}

async function verifySignedLogin(
  signed: Awaited<ReturnType<typeof core.signMessage>>,
  account: { address: string; publicKey: string }
): Promise<void> {
  setStatus('Verifying...');
  const verifyRes = await fetchWithTimeout('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: signed.message,
      nonce: signed.nonce,
      fullMessage: signed.fullMessage,
      signature: String(signed.signature),
      publicKey: account.publicKey,
      address: account.address
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

function rememberPendingSignRequest(request: PendingSignRequest): void {
  localStorage.setItem(PENDING_SIGN_REQUEST_KEY, JSON.stringify(request));
}

function readPendingSignRequest(): PendingSignRequest | null {
  try {
    const raw = localStorage.getItem(PENDING_SIGN_REQUEST_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingSignRequest;
    if (!pending.requestId || Date.now() - pending.createdAt > PENDING_SIGN_MAX_AGE_MS) {
      clearPendingSignRequest();
      return null;
    }
    return pending;
  } catch {
    clearPendingSignRequest();
    return null;
  }
}

function clearPendingSignRequest(): void {
  localStorage.removeItem(PENDING_SIGN_REQUEST_KEY);
}

function buildRelayUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function callbackUrlWithoutMarkers(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('novaRequestId');
  url.searchParams.delete('novaStatus');
  return url.toString();
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
