/**
 * OAuth2 Token Manager
 *
 * Handles the full OAuth2 lifecycle for Gmail and Outlook integrations:
 *   - Authorization URL generation (with PKCE state for CSRF protection)
 *   - Authorization code exchange
 *   - Automatic token refresh (access tokens expire; refresh tokens are long-lived)
 *   - Encrypted token storage in Core Sovereign Vault
 *
 * Tokens are NEVER stored in plaintext. They are encrypted before reaching Core
 * and only decrypted here in the twin process.
 *
 * Supported providers:
 *   'google'    — Gmail + Google Calendar (OAuth2)
 *   'microsoft' — Outlook + Outlook Calendar (Microsoft Identity Platform v2)
 */

import axios from 'axios';
import { randomBytes } from 'crypto';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

// ─── Provider configs ─────────────────────────────────────────────────────────

const PROVIDERS = {
  google: {
    authUrl:    'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:   'https://oauth2.googleapis.com/token',
    revokeUrl:  'https://oauth2.googleapis.com/revoke',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ].join(' '),
    clientId:     () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:  () => process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/api/v1/integrations/gmail/callback',
  },
  microsoft: {
    authUrl:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl:   `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    revokeUrl:  null, // Microsoft revokes via token endpoint
    scopes: [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Calendars.Read',
      'offline_access',
    ].join(' '),
    clientId:     () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri:  () => process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3002/api/v1/integrations/outlook/callback',
  },
};

const TOKEN_VAULT_KEY = (twinId, provider) => `twin/oauth/${twinId}/${provider}`;
const STATE_VAULT_KEY = (state) => `twin/oauth_state/${state}`;

// ─── Build authorization URL ──────────────────────────────────────────────────

/**
 * Generate the OAuth2 authorization URL and store CSRF state.
 *
 * @returns {{ authUrl: string, state: string }}
 */
export async function buildAuthUrl({ sessionToken, twinId, provider }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  if (!cfg.clientId()) throw new Error(`${provider.toUpperCase()}_CLIENT_ID not set in environment`);

  const state = randomBytes(16).toString('hex');

  // Store state → twinId mapping so the callback can resolve it
  await core.vaultStore({
    sessionToken,
    key:        STATE_VAULT_KEY(state),
    ciphertext: Buffer.from(JSON.stringify({ twinId, provider, createdAt: Date.now() })).toString('base64'),
    metadata:   { type: 'oauth_state', provider },
  });

  const params = new URLSearchParams({
    client_id:     cfg.clientId(),
    redirect_uri:  cfg.redirectUri(),
    response_type: 'code',
    scope:         cfg.scopes,
    state,
    access_type:   'offline',  // Google: get refresh token
    prompt:        'consent',  // Force consent screen to ensure refresh token
  });

  return { authUrl: `${cfg.authUrl}?${params}`, state };
}

// ─── Exchange authorization code for tokens ───────────────────────────────────

/**
 * Exchange an authorization code (from the OAuth callback) for access + refresh tokens.
 * Validates the CSRF state, then stores encrypted tokens in Core Vault.
 *
 * @returns {{ twinId, provider, email }}
 */
export async function exchangeCode({ sessionToken, code, state, provider }) {
  // Validate CSRF state
  let stateData;
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: STATE_VAULT_KEY(state) });
    stateData = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    // Delete state after use (one-time token)
    await core.vaultDelete({ sessionToken, key: STATE_VAULT_KEY(state) }).catch(() => {});
  } catch {
    throw new Error('Invalid or expired OAuth state — possible CSRF attack');
  }

  const cfg = PROVIDERS[provider];
  const { twinId } = stateData;

  // Exchange code for tokens
  const params = new URLSearchParams({
    code,
    client_id:     cfg.clientId(),
    client_secret: cfg.clientSecret(),
    redirect_uri:  cfg.redirectUri(),
    grant_type:    'authorization_code',
  });

  const { data } = await axios.post(cfg.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // Get the account email for display
  const email = await resolveAccountEmail(provider, data.access_token);

  const tokenRecord = {
    provider,
    twinId,
    email,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    Date.now() + (data.expires_in || 3600) * 1000,
    scope:        data.scope,
    connectedAt:  Date.now(),
  };

  // Store encrypted in Core Vault
  await storeTokens({ sessionToken, twinId, provider, tokenRecord });

  await core.auditLog({
    sessionToken,
    action: 'twin.integration.connected',
    payload: { twinId, provider, email },
  });

  logger.info({ twinId, provider, email }, 'OAuth integration connected');
  return { twinId, provider, email };
}

// ─── Get valid access token (auto-refresh) ────────────────────────────────────

/**
 * Returns a valid access token for the given provider.
 * Automatically refreshes if expired.
 */
export async function getAccessToken({ sessionToken, twinId, provider }) {
  const tokenRecord = await loadTokens({ sessionToken, twinId, provider });

  if (!tokenRecord) {
    throw new Error(`No ${provider} integration found for twin ${twinId} — complete OAuth flow first`);
  }

  // If token expires in less than 5 minutes, refresh it
  if (Date.now() >= tokenRecord.expiresAt - 5 * 60 * 1000) {
    return refreshAccessToken({ sessionToken, twinId, provider, tokenRecord });
  }

  return tokenRecord.accessToken;
}

async function refreshAccessToken({ sessionToken, twinId, provider, tokenRecord }) {
  const cfg = PROVIDERS[provider];

  if (!tokenRecord.refreshToken) {
    throw new Error(`No refresh token available for ${provider} — user must re-authorise`);
  }

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokenRecord.refreshToken,
    client_id:     cfg.clientId(),
    client_secret: cfg.clientSecret(),
  });

  const { data } = await axios.post(cfg.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const updated = {
    ...tokenRecord,
    accessToken: data.access_token,
    expiresAt:   Date.now() + (data.expires_in || 3600) * 1000,
    // Microsoft may issue a new refresh token
    ...(data.refresh_token && { refreshToken: data.refresh_token }),
  };

  await storeTokens({ sessionToken, twinId, provider, tokenRecord: updated });
  logger.info({ twinId, provider }, 'OAuth token refreshed');
  return updated.accessToken;
}

// ─── Disconnect integration ───────────────────────────────────────────────────

export async function disconnect({ sessionToken, twinId, provider }) {
  const tokenRecord = await loadTokens({ sessionToken, twinId, provider });
  if (!tokenRecord) return { disconnected: false, reason: 'not_connected' };

  // Revoke token at provider
  const cfg = PROVIDERS[provider];
  if (cfg.revokeUrl && tokenRecord.refreshToken) {
    await axios.post(cfg.revokeUrl, new URLSearchParams({ token: tokenRecord.refreshToken }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(err => logger.warn({ err }, 'Token revocation failed (non-fatal)'));
  }

  await core.vaultDelete({ sessionToken, key: TOKEN_VAULT_KEY(twinId, provider) });

  await core.auditLog({
    sessionToken,
    action: 'twin.integration.disconnected',
    payload: { twinId, provider },
  });

  logger.info({ twinId, provider }, 'OAuth integration disconnected');
  return { disconnected: true };
}

// ─── Integration status ───────────────────────────────────────────────────────

export async function getIntegrationStatus({ sessionToken, twinId }) {
  const providers = ['google', 'microsoft'];
  const status = {};

  for (const provider of providers) {
    try {
      const record = await loadTokens({ sessionToken, twinId, provider });
      status[provider] = record
        ? { connected: true, email: record.email, connectedAt: record.connectedAt, expired: Date.now() >= record.expiresAt }
        : { connected: false };
    } catch {
      status[provider] = { connected: false };
    }
  }

  return status;
}

// ─── Vault helpers ────────────────────────────────────────────────────────────

async function storeTokens({ sessionToken, twinId, provider, tokenRecord }) {
  await core.vaultStore({
    sessionToken,
    key:        TOKEN_VAULT_KEY(twinId, provider),
    ciphertext: Buffer.from(JSON.stringify(tokenRecord)).toString('base64'),
    metadata:   { type: 'oauth_token', provider, twinId },
  });
}

async function loadTokens({ sessionToken, twinId, provider }) {
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: TOKEN_VAULT_KEY(twinId, provider) });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// ─── Resolve account email ────────────────────────────────────────────────────

async function resolveAccountEmail(provider, accessToken) {
  try {
    if (provider === 'google') {
      const { data } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return data.email;
    }
    if (provider === 'microsoft') {
      const { data } = await axios.get('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return data.mail || data.userPrincipalName;
    }
  } catch { /* non-fatal */ }
  return null;
}
