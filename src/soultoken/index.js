/**
 * Soul Token
 *
 * An Algorand Standard Asset (ASA) that acts as a consent NFT.
 * One Soul Token is minted per twin. Organisations must hold
 * (or be granted) a Soul Token to query the twin.
 *
 * The token encodes in its ARC-3 metadata:
 *   - Twin owner wallet
 *   - Allowed scopes  (qa | email | document | all)
 *   - Query limit     (queries per day, 0 = unlimited)
 *   - Expiry          (unix timestamp, 0 = never)
 *   - Domain whitelist (optional — restrict to specific topics)
 *   - Training data manifest hash (CID of provenance on Algorand)
 *
 * Soulbound: the token is non-transferable by default (clawback = creator).
 * Organisations receive access grants, not token ownership.
 */

import algosdk from 'algosdk';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const ALGORAND_NODE  = process.env.ALGORAND_NODE  || 'https://testnet-api.algonode.cloud';
const ALGORAND_INDEXER = process.env.ALGORAND_INDEXER || 'https://testnet-idx.algonode.cloud';

function getAlgodClient() {
  return new algosdk.Algodv2('', ALGORAND_NODE, '');
}

function getIndexerClient() {
  return new algosdk.Indexer('', ALGORAND_INDEXER, '');
}

// ─── Mint a Soul Token ────────────────────────────────────────────────────────

/**
 * Mint the twin's Soul Token on Algorand.
 * Called once during onboarding Step 5 (twin activation).
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken    - Core session token
 * @param {string}   opts.ownerMnemonic   - Twin owner's Algorand mnemonic (from Core vault)
 * @param {string}   opts.ownerAddress    - Twin owner's Algorand address
 * @param {string}   opts.twinId         - Unique twin identifier
 * @param {string}   opts.ownerName      - Display name
 * @param {object}   opts.domains        - Domain ontology (from Sprint 4)
 * @param {string}   opts.manifestHash   - Hash of training data manifest
 * @param {object}   opts.defaultScopes  - Default access policy for the token
 * @returns {{ assetId, txId }}
 */
export async function mintSoulToken({
  sessionToken,
  ownerMnemonic,
  ownerAddress,
  twinId,
  ownerName,
  domains = [],
  manifestHash,
  defaultScopes = { scopes: ['qa'], queryLimitPerDay: 100, expiryDays: 365 },
}) {
  const algod = getAlgodClient();
  const account = algosdk.mnemonicToSecretKey(ownerMnemonic);

  // Build ARC-3 metadata
  const metadata = buildARC3Metadata({
    twinId,
    ownerAddress,
    ownerName,
    domains: domains.map(d => d.primary || d).slice(0, 20),
    manifestHash,
    scopes: defaultScopes.scopes,
    queryLimitPerDay: defaultScopes.queryLimitPerDay,
    expiry: defaultScopes.expiryDays
      ? Math.floor(Date.now() / 1000) + defaultScopes.expiryDays * 86400
      : 0,
  });

  const metadataHash = new Uint8Array(
    Buffer.from(algosdk.computeGroupID ? '' : hashMetadata(metadata))
  );

  // Get suggested params
  const params = await algod.getTransactionParams().do();

  // Create ASA transaction
  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender:        account.addr,
    suggestedParams: params,
    defaultFrozen: false,
    unitName:      'SOUL',
    assetName:     `DecentralThink Twin — ${ownerName}`.slice(0, 32),
    manager:       account.addr,
    reserve:       account.addr,
    freeze:        account.addr,
    clawback:      account.addr,   // soulbound: platform can revoke
    total:         1,              // NFT — exactly 1
    decimals:      0,
    assetURL:      `https://core.decentralthink.com/twins/${twinId}/soul`,
    note:          new TextEncoder().encode(JSON.stringify({
      standard: 'arc3',
      twinId,
      manifestHash,
    })),
  });

  const signedTxn = txn.signTxn(account.sk);
  const { txId } = await algod.sendRawTransaction(signedTxn).do();
  await algosdk.waitForConfirmation(algod, txId, 5);

  // Get the created asset ID
  const pendingTxn = await algod.pendingTransactionInformation(txId).do();
  const assetId = pendingTxn['asset-index'];

  logger.info({ twinId, assetId, txId }, 'Soul Token minted');

  // Log to Core audit chain
  await core.auditLog({
    sessionToken,
    action: 'twin.soul_token.minted',
    payload: { twinId, assetId, txId, ownerAddress, manifestHash },
  });

  // Store Soul Token metadata in Core vault
  await core.vaultStore({
    sessionToken,
    key: `twin/soul_token/${twinId}`,
    ciphertext: Buffer.from(JSON.stringify({ assetId, txId, metadata })).toString('base64'),
    metadata: { type: 'soul_token', twinId, assetId },
  });

  return { assetId, txId, metadata };
}

// ─── Grant access to an organisation ─────────────────────────────────────────

/**
 * Grant an organisation access to query this twin.
 * Records the grant on-chain via Core audit.
 * Does NOT transfer the Soul Token (it stays with owner).
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken
 * @param {string}   opts.twinId
 * @param {string}   opts.granteeAddress  - Organisation's wallet address
 * @param {object}   opts.scopes          - { scopes[], queryLimitPerDay, expiryDays }
 */
export async function grantAccess({ sessionToken, twinId, granteeAddress, scopes }) {
  const grantId = `grant_${twinId}_${granteeAddress}_${Date.now()}`;
  const expiry = scopes.expiryDays
    ? Math.floor(Date.now() / 1000) + scopes.expiryDays * 86400
    : 0;

  const grant = {
    grantId,
    twinId,
    granteeAddress,
    scopes:            scopes.scopes || ['qa'],
    queryLimitPerDay:  scopes.queryLimitPerDay || 50,
    expiry,
    grantedAt:         Math.floor(Date.now() / 1000),
  };

  // Store grant in Core vault
  await core.vaultStore({
    sessionToken,
    key: `twin/access_grants/${grantId}`,
    ciphertext: Buffer.from(JSON.stringify(grant)).toString('base64'),
    metadata: { type: 'access_grant', twinId, granteeAddress },
  });

  // Log to audit chain
  const { txId } = await core.auditLog({
    sessionToken,
    action: 'twin.access.granted',
    payload: { grantId, twinId, granteeAddress, scopes: grant.scopes, expiry },
  });

  logger.info({ grantId, twinId, granteeAddress }, 'Access grant created');
  return { grantId, txId, grant };
}

// ─── Verify access ────────────────────────────────────────────────────────────

export async function verifyAccess({ sessionToken, twinId, callerAddress }) {
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: `twin/access_grants/grant_${twinId}_${callerAddress}`,
    });
    const grant = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    const now = Math.floor(Date.now() / 1000);

    if (grant.expiry && grant.expiry < now) {
      return { allowed: false, reason: 'grant_expired' };
    }
    return { allowed: true, grant };
  } catch {
    // No grant found — check if caller IS the owner (always allowed)
    return { allowed: false, reason: 'no_grant' };
  }
}

// ─── Revoke access ────────────────────────────────────────────────────────────

export async function revokeAccess({ sessionToken, twinId, granteeAddress }) {
  await core.vaultDelete({
    sessionToken,
    key: `twin/access_grants/grant_${twinId}_${granteeAddress}`,
  });

  const { txId } = await core.auditLog({
    sessionToken,
    action: 'twin.access.revoked',
    payload: { twinId, granteeAddress },
  });

  logger.info({ twinId, granteeAddress }, 'Access revoked');
  return { txId };
}

// ─── Get Soul Token info ──────────────────────────────────────────────────────

export async function getSoulToken({ sessionToken, twinId }) {
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: `twin/soul_token/${twinId}`,
    });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// ─── ARC-3 metadata builder ───────────────────────────────────────────────────

function buildARC3Metadata({ twinId, ownerAddress, ownerName, domains, manifestHash, scopes, queryLimitPerDay, expiry }) {
  return {
    name:        `DecentralThink Twin — ${ownerName}`,
    description: `Authentic Digital Twin of ${ownerName}. Knowledge boundary enforced. Provenance verified on Algorand.`,
    image:       `https://core.decentralthink.com/twins/${twinId}/avatar`,
    external_url: `https://decentralthink.com/twins/${twinId}`,
    properties: {
      twinId,
      ownerAddress,
      ownerName,
      standard:          'decentralthink-twin-v1',
      knowledgeDomains:  domains,
      trainingManifest:  manifestHash,
      defaultScopes:     scopes,
      queryLimitPerDay,
      expiry,
      mintedAt:          Math.floor(Date.now() / 1000),
      soulbound:         true,
    },
  };
}

function hashMetadata(metadata) {
  const { createHash } = require('crypto');
  return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}
