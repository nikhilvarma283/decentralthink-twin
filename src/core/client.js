/**
 * DecentralThink Core Client
 *
 * All calls to Layer 1 (core.decentralthink.com) go through here.
 * The twin never re-implements what Core already provides:
 *   - Sovereign Vault  → encrypted document storage
 *   - Blockchain Audit → provenance chain for training data
 *   - x402 Payments   → per-query billing
 *   - OPA Policy      → consent + access enforcement
 *   - SIWE Auth       → wallet-based session management
 */

import axios from 'axios';
import { logger } from '../lib/logger.js';

const core = axios.create({
  baseURL: process.env.CORE_API_URL || 'https://core.decentralthink.com',
  headers: {
    'Content-Type': 'application/json',
    'X-Service-Key': process.env.CORE_API_KEY,
  },
  timeout: 30000,
});

// ─── Auth (SIWE) ────────────────────────────────────────────────────────────

export async function getNonce() {
  const { data } = await core.get('/api/v1/auth/nonce');
  return data;
}

export async function verifyWallet({ message, signature }) {
  const { data } = await core.post('/api/v1/auth/verify', { message, signature });
  return data; // { sessionToken, walletAddress, expiresAt }
}

// ─── Sovereign Vault ─────────────────────────────────────────────────────────
// Core stores ciphertext only — the twin sends pre-encrypted blobs.
// Keys are derived client-side from the wallet signature (HKDF).

export async function vaultStore({ sessionToken, key, ciphertext, metadata }) {
  const { data } = await core.post('/api/v1/vault', { key, ciphertext, metadata }, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { vaultId, storedAt }
}

export async function vaultRead({ sessionToken, key }) {
  const { data } = await core.get(`/api/v1/vault/${key}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { ciphertext, metadata }
}

export async function vaultDelete({ sessionToken, key }) {
  const { data } = await core.delete(`/api/v1/vault/${key}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data;
}

// ─── Blockchain Audit Chain ──────────────────────────────────────────────────
// Every training document upload is logged as a hash on Algorand.

export async function auditLog({ sessionToken, action, payload }) {
  const { data } = await core.post('/api/v1/audit', { action, payload }, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { txId, blockHeight, timestamp }
}

export async function auditQuery({ sessionToken, walletAddress, limit = 50 }) {
  const { data } = await core.get('/api/v1/audit', {
    params: { walletAddress, limit },
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data;
}

// ─── x402 Payments ───────────────────────────────────────────────────────────
// Per-query billing: organizations pay to query a twin.

export async function initiatePayment({ sessionToken, twinId, queryId, amount }) {
  const { data } = await core.post('/api/v1/payments', {
    twinId,
    queryId,
    amount,
    currency: 'USDC',
  }, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { paymentId, paymentUrl } or 402 challenge
}

export async function verifyPayment({ sessionToken, paymentId }) {
  const { data } = await core.get(`/api/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { verified: true/false, receipt }
}

// ─── Policy (OPA) ────────────────────────────────────────────────────────────
// Consent scopes and access rules enforced at Core's policy layer.

export async function checkPolicy({ sessionToken, task, context }) {
  try {
    const { data } = await core.post('/api/v1/invoke', {
      task: `policy_check: ${task}`,
      context,
    }, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    return { allowed: data.allow, reasons: data.deny_reasons };
  } catch (err) {
    logger.error({ err }, 'Policy check failed');
    return { allowed: false, reasons: ['policy_check_error'] };
  }
}

// ─── Marketplace ─────────────────────────────────────────────────────────────
// Register the twin as an agent in Core's ZK marketplace.

export async function registerTwin({ sessionToken, twinId, walletAddress, displayName, capabilities, commitment, metadata }) {
  const { data } = await core.post('/api/v1/marketplace', {
    agentId:      twinId,
    walletAddress,
    displayName,
    capabilities: capabilities || ['qa', 'document', 'email'],
    commitment,          // ZK commitment to capabilities
    metadata,
  }, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data;
}

// ─── Earnings / payment summary ───────────────────────────────────────────────

export async function getEarnings({ sessionToken, twinId, walletAddress, days = 30 }) {
  const { data } = await core.get('/api/v1/payments/earnings', {
    params: { twinId, walletAddress, days },
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return data; // { totalGross, platformFee, netEarned, queryCount, byDay }
}

export default {
  getNonce,
  verifyWallet,
  vaultStore,
  vaultRead,
  vaultDelete,
  auditLog,
  auditQuery,
  initiatePayment,
  verifyPayment,
  checkPolicy,
  registerTwin,
  getEarnings,
};
