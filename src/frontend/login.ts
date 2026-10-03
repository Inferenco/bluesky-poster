/// <reference lib="dom" />
import { WalletCore } from '@cedra-labs/wallet-adapter-core';
import { Network } from '@cedra-labs/ts-sdk';
import { registerInferWallet } from '@inferenco/infer-wallet-adapter/aip62';
import {
  INFER_CONNECT_NAME,
  tryResumeInferWalletConnection,
  listRecoverableRequests,
  readRecoverableRequest,
  reconcileRecoverableInvocation,
  relaunchRecoverableInvocation,
  acknowledgeRecoverableRequest,
  type RecoveredRequestOutcome
} from '@inferenco/infer-wallet-adapter';

const AUTH_TIMEOUT_MS = 10_000;
const CHALLENGE_MAX_AGE_MS = 5 * 60_000;
const PENDING_LOGIN_KEY = 'inferenco_poster_pending_login_v2';

interface LoginChallenge {
  nonce: string;
  message: string;
  createdAt: number;
}

interface PendingLogin {
  challenge: LoginChallenge;
  address: string;
  publicKey: string;
  invocationId?: string;
  transport?: 'desktop-bridge' | 'mobile-relay';
  requestId?: string;
  sessionId?: string;
}

type SignedMessage = Awaited<ReturnType<WalletCore['signMessage']>>;

const buttonsEl = document.getElementById('wallet-buttons') as HTMLElement;
const statusEl = document.getElementById('wallet-status') as HTMLElement;
// Capture these before the adapter consumes its callback URL. A callback opened
// in another tab must not replace the nonce owned by the original sign-in tab.
const callbackParams = new URL(window.location.href).searchParams;
const isCallbackTab = callbackParams.has('inferRequestId') || callbackParams.has('novaRequestId');
let pending = readPendingLogin();
let callbackWithoutContext = isCallbackTab && !pending;
let challenge: LoginChallenge | null = pending?.challenge ?? null;
let challengeRequest: Promise<LoginChallenge> | null = null;
let verificationRequest: Promise<void> | null = null;
let recoveryRequest: Promise<void> | null = null;
let booting = true;
let signing = false;
let accepted = false;
let statusIsError = false;

registerInferWallet({
  forceRegistration: true,
  desktopRegistration: true,
  detectAliases: true,
  expectedOrigin: window.location.origin,
  mobileReturnMode: 'resume-browser-v1',
  onInvocationPrepared(invocation) {
    if (invocation.method !== 'signMessage') return;
    if (!pending || !sameAddress(invocation.address, pending.address)) {
      throw new Error('The sign-in account changed. Please start again.');
    }
    savePending({ ...pending, invocationId: invocation.invocationId, sessionId: invocation.sessionId, transport: invocation.transport });
  },
  onRequestCreated(request) {
    if (request.method !== 'signMessage') return;
    if (!pending || request.invocationId !== pending.invocationId || request.sessionId !== pending.sessionId) {
      throw new Error('The sign-in request changed. Please start again.');
    }
    savePending({ ...pending, requestId: request.requestId });
    renderWalletButtons();
  },
  onRecoveredOutcome: outcome => handleRecoveredOutcome(outcome).catch(error => setStatus(describeError(error), true))
});

const core = new WalletCore([], { network: Network.TESTNET });

function setStatus(text: string, isError = false): void {
  statusIsError = isError;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'button primary';
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}

function renderWalletButtons(): void {
  buttonsEl.replaceChildren();
  if (accepted) return;
  if (callbackWithoutContext) {
    setStatus('Return to the original sign-in tab to finish, or start a new sign-in here.');
    buttonsEl.append(button('Start a new sign-in here', () => {
      callbackWithoutContext = false;
      renderWalletButtons();
    }, booting));
    return;
  }
  if (pending) {
    buttonsEl.append(button('Check signature', () => void recoverLogin(), booting));
    if (pending.transport === 'mobile-relay' && pending.invocationId && pending.requestId) {
      buttonsEl.append(button('Open Infer Wallet', () => {
        const invocationId = pending?.invocationId;
        if (invocationId) {
          void relaunchRecoverableInvocation(invocationId).catch(error => setStatus(describeError(error), true));
        }
      }, booting));
    }
    buttonsEl.append(button('Cancel sign-in', () => {
      clearPending();
      challenge = null;
      renderWalletButtons();
      setStatus('Sign-in cancelled. Any later approval for that request will be ignored.');
    }, booting || !!verificationRequest));
    return;
  }
  if (booting) {
    setStatus('Restoring wallet connection...');
    return;
  }
  if (core.isConnected() && core.account) {
    if (challenge && Date.now() - challenge.createdAt >= CHALLENGE_MAX_AGE_MS) challenge = null;
    buttonsEl.append(
      button('Sign in with Infer Connect', () => void signIn(), signing || !challenge),
      button('Disconnect', () => void disconnectWallet(), signing)
    );
    if (!challenge) {
      setStatus('Preparing sign-in challenge...');
      void prepareChallenge().catch(error => setStatus(describeError(error), true));
    } else {
      setStatus('Wallet connected. Sign a message to access the dashboard.');
    }
    return;
  }
  const wallets = [...core.wallets].sort((a, b) =>
    Number(b.name === INFER_CONNECT_NAME) - Number(a.name === INFER_CONNECT_NAME));
  for (const wallet of wallets) {
    buttonsEl.append(button('Connect ' + wallet.name, () => void connectWallet(wallet.name), signing));
  }
  setStatus(wallets.length ? 'Connect your wallet to continue.' : 'No Cedra wallets detected. Install Infer Wallet to continue.');
}

async function connectWallet(name: string): Promise<void> {
  buttonsEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
  setStatus('Connecting wallet...');
  try {
    await core.connect(name);
    renderWalletButtons();
  } catch (error) {
    renderWalletButtons();
    setStatus(describeError(error), true);
  }
}

async function disconnectWallet(): Promise<void> {
  try {
    await core.disconnect();
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    challenge = null;
    clearPending();
    renderWalletButtons();
  }
}

async function prepareChallenge(): Promise<LoginChallenge> {
  if (challenge) return challenge;
  if (challengeRequest) return challengeRequest;
  challengeRequest = (async () => {
    const response = await fetchWithTimeout('/api/auth/nonce');
    if (!response.ok) throw new Error('Could not get a sign-in challenge from the server.');
    const body = await response.json() as { nonce: string; message: string };
    challenge = { ...body, createdAt: Date.now() };
    renderWalletButtons();
    return challenge;
  })().finally(() => { challengeRequest = null; });
  return challengeRequest;
}

async function signIn(): Promise<void> {
  if (signing || pending || accepted) return;
  const account = core.account;
  if (!core.isConnected() || !account || !challenge) return;
  if (Date.now() - challenge.createdAt >= CHALLENGE_MAX_AGE_MS) {
    challenge = null;
    renderWalletButtons();
    return;
  }
  const context: PendingLogin = {
    challenge,
    address: String(account.address),
    publicKey: String(account.publicKey)
  };
  signing = true;
  try {
    // Keep only this tab's challenge/account association. Transport credentials,
    // encryption, request creation and durable result recovery belong to the adapter.
    savePending(context);
    renderWalletButtons();
    setStatus('Approve the sign-in message in your wallet, then return here.');
    const signed = await core.signMessage({ message: challenge.message, nonce: challenge.nonce });
    await verifySignedLogin(signed, context);
  } catch (error) {
    if (!isCurrent(context)) return;
    // WalletCore may turn structured adapter errors into strings. Once an
    // invocation exists, keep its identity and reconcile instead of signing again.
    if (!(pending as PendingLogin | null)?.invocationId) {
      clearPending();
      challenge = null;
    }
    renderWalletButtons();
    setStatus(describeError(error), true);
  } finally {
    signing = false;
    renderPreservingError();
  }
}

async function handleRecoveredOutcome(outcome: Readonly<RecoveredRequestOutcome>): Promise<void> {
  const context = pending;
  if (!context || outcome.method !== 'signMessage' ||
      !context.invocationId || outcome.invocationId !== context.invocationId ||
      outcome.sessionId !== context.sessionId || !sameAddress(outcome.address, context.address) ||
      (context.requestId && context.requestId !== outcome.requestId)) return;

  if (outcome.status === 'approved' && 'message' in outcome.output) {
    await verifySignedLogin(outcome.output, context, outcome.recoveryId);
  } else if (outcome.status === 'rejected') {
    clearPending();
    challenge = null;
    await acknowledgeRecoverableRequest(outcome.recoveryId).catch(() => {});
    renderWalletButtons();
    setStatus('The sign-in request was rejected.', true);
  } else if (outcome.status === 'unknown') {
    setStatus('The signature result could not be confirmed. Check again or cancel sign-in.', true);
  } else if (outcome.status === 'pending') {
    setStatus('Waiting for signature approval in your wallet.');
  }
}

async function recoverLogin(): Promise<void> {
  if (recoveryRequest || !pending || accepted) return recoveryRequest ?? undefined;
  recoveryRequest = (async () => {
    const context = pending;
    if (!context?.invocationId) {
      setStatus('This sign-in cannot be resumed. Cancel it and sign in again.', true);
      return;
    }
    setStatus('Checking the original signature request...');
    const requests = await listRecoverableRequests();
    const request = requests.find(row =>
      row.invocationId === context.invocationId && row.sessionId === context.sessionId &&
      row.method === 'signMessage' && sameAddress(row.address, context.address));
    const result = request
      ? await readRecoverableRequest(request.recoveryId)
      : await reconcileRecoverableInvocation(context.invocationId);
    if ('recoveryId' in result) await handleRecoveredOutcome(result);
    else if (isCurrent(context)) setStatus('The signature result is not available yet. Check again or cancel sign-in.', true);
  })().catch(error => setStatus(describeError(error), true))
    .finally(() => { recoveryRequest = null; });
  return recoveryRequest;
}

async function verifySignedLogin(signed: SignedMessage, context: PendingLogin, recoveryId?: string): Promise<void> {
  if (accepted || !isCurrent(context)) return;
  if (signed.message !== context.challenge.message ||
      (signed.nonce && signed.nonce !== context.challenge.nonce)) {
    throw new Error('The signature does not match this sign-in challenge.');
  }
  if (verificationRequest) return verificationRequest;
  verificationRequest = (async () => {
    setStatus('Verifying signature...');
    const response = await fetchWithTimeout('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: signed.message,
        nonce: signed.nonce,
        fullMessage: signed.fullMessage,
        signature: String(signed.signature),
        publicKey: context.publicKey,
        address: context.address
      })
    });
    if (!isCurrent(context)) return;
    if (!response.ok) {
      clearPending();
      challenge = null;
      const body = await response.json().catch(() => ({})) as { error?: string };
      renderWalletButtons();
      setStatus(response.status === 403
        ? 'This wallet is not an admin of the treasury contract.'
        : response.status === 502
          ? 'Could not verify treasury admins. Please try again.'
          : 'Sign-in failed: ' + (body.error ?? 'please try again.'), true);
      return;
    }
    accepted = true;
    const completed = pending;
    clearPending();
    // The server accepted this challenge. Acknowledge only its exact adapter receipt.
    try {
      const id = recoveryId ?? (await listRecoverableRequests()).find(row =>
        row.invocationId === completed?.invocationId && row.sessionId === completed?.sessionId &&
        row.method === 'signMessage' && sameAddress(row.address, context.address))?.recoveryId;
      if (id) await acknowledgeRecoverableRequest(id);
    } catch {
      // Login already succeeded; a stale receipt must not cause a second verification.
    }
    window.location.href = '/';
  })().finally(() => {
    verificationRequest = null;
    renderPreservingError();
  });
  renderWalletButtons();
  return verificationRequest;
}

function renderPreservingError(): void {
  const message = statusEl.textContent;
  const wasError = statusIsError;
  renderWalletButtons();
  if (wasError && message) setStatus(message, true);
}

function isCurrent(context: PendingLogin): boolean {
  return pending?.challenge.nonce === context.challenge.nonce &&
    pending.challenge.message === context.challenge.message &&
    sameAddress(pending.address, context.address);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase().replace(/^0x/, '').padStart(64, '0') ===
    b.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function savePending(value: PendingLogin): void {
  sessionStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(value));
  pending = value;
}

function clearPending(): void {
  pending = null;
  sessionStorage.removeItem(PENDING_LOGIN_KEY);
}

function readPendingLogin(): PendingLogin | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_LOGIN_KEY) ?? 'null') as PendingLogin | null;
    if (!value || !value.address || !value.publicKey || !value.challenge?.nonce ||
        !value.challenge.message || !Number.isFinite(value.challenge.createdAt) ||
        Date.now() - value.challenge.createdAt >= CHALLENGE_MAX_AGE_MS ||
        value.challenge.createdAt > Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Wallet connection failed.';
}

core.on('standardWalletsAdded', renderWalletButtons);
core.on('connect', renderWalletButtons);
core.on('disconnect', renderWalletButtons);
core.on('accountChange', () => {
  if (pending && core.account && !sameAddress(String(core.account.address), pending.address)) {
    clearPending();
    challenge = null;
  }
  renderWalletButtons();
});
window.addEventListener('pageshow', () => { void recoverLogin(); });
window.addEventListener('focus', () => { void recoverLogin(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void recoverLogin();
});

renderWalletButtons();
void (async () => {
  try {
    await tryResumeInferWalletConnection(core);
    await recoverLogin();
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    booting = false;
    renderWalletButtons();
  }
})();
