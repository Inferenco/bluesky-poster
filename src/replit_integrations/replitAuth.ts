import * as oidcClient from 'openid-client';
import memoize from 'memoizee';
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface SessionUser {
  sub: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    oidcState?: string;
    codeVerifier?: string;
    user?: SessionUser;
  }
}

const getOidcConfig = memoize(
  async (): Promise<oidcClient.Configuration> => {
    return await oidcClient.discovery(
      new URL(process.env.ISSUER_URL ?? 'https://replit.com/oidc'),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000, promise: true }
);

export function getRequestHost(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-host'] as string | undefined;
  return forwarded?.split(',')[0].trim() ?? request.hostname;
}

export function getCallbackUrl(host: string): string {
  return `https://${host}/api/callback`;
}

export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function buildLoginUrl(
  callbackUrl: string,
  state: string,
  codeVerifier: string
): Promise<string> {
  const config = await getOidcConfig();
  const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);
  return oidcClient.buildAuthorizationUrl(config, {
    scope: 'openid email profile offline_access',
    redirect_uri: callbackUrl,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).href;
}

export async function exchangeCode(
  callbackUrl: string,
  currentUrl: URL,
  expectedState: string,
  codeVerifier: string
): Promise<oidcClient.TokenEndpointResponse & oidcClient.TokenEndpointResponseHelpers> {
  const config = await getOidcConfig();
  return await oidcClient.authorizationCodeGrant(
    config,
    currentUrl,
    { pkceCodeVerifier: codeVerifier, expectedState },
    new URLSearchParams({ redirect_uri: callbackUrl })
  );
}

export async function buildLogoutUrl(host: string): Promise<string> {
  const config = await getOidcConfig();
  return oidcClient.buildEndSessionUrl(config, {
    client_id: process.env.REPL_ID!,
    post_logout_redirect_uri: `https://${host}`,
  }).href;
}

export function extractUserFromClaims(claims: Record<string, unknown>): SessionUser {
  const username = String(
    claims.preferred_username ??
    claims.username ??
    claims.sub ??
    ''
  ).toLowerCase();
  return {
    sub: String(claims.sub ?? ''),
    username,
    email: claims.email ? String(claims.email) : null,
    firstName: claims.first_name ? String(claims.first_name) : null,
    lastName: claims.last_name ? String(claims.last_name) : null,
  };
}

export function isUserAllowed(user: SessionUser, allowedUsers: string[]): boolean {
  if (allowedUsers.length === 0) return true;
  return allowedUsers.some(
    (a) => a === user.username || a === user.sub || a === user.email?.toLowerCase()
  );
}
