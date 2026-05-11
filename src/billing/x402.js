/**
 * x402 Billing Layer
 *
 * Implements HTTP 402 Payment Required for per-query twin access.
 *
 * Flow:
 *   1. Caller hits POST /api/v1/query
 *   2. Billing gate checks the twin's pricing config (stored in Core Vault)
 *   3. If price > 0 and no X-Payment-Receipt header:
 *        → Return HTTP 402 with a signed payment challenge
 *   4. Caller pays via Core's x402 endpoint, gets a paymentId receipt
 *   5. Caller retries the query with X-Payment-Receipt: <paymentId>
 *   6. Gate verifies the receipt with Core, then releases the query
 *   7. Revenue is credited to the twin owner's wallet by Core
 *
 * Free tier:
 *   If queryLimitFree > 0, the first N queries per caller per day are free.
 *   Daily free-tier usage is tracked in Core Vault.
 *
 * Owner queries:
 *   The twin owner (callerAddress === ownerAddress) is always free.
 */

import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const PRICING_VAULT_KEY = (twinId) => `twin/pricing/${twinId}`;
const USAGE_VAULT_KEY   = (twinId, callerAddress, date) =>
  `twin/usage/${twinId}/${callerAddress}/${date}`;

// ─── Default pricing ──────────────────────────────────────────────────────────

export const DEFAULT_PRICING = {
  pricePerQuery:   0,       // USDC — 0 = free tier only
  currency:        'USDC',
  queryLimitFree:  10,      // free queries per caller per day (0 = no free tier)
  ownerFreeAccess: true,    // owner always queries free
  platformFeePct:  10,      // % kept by DecentralThink platform
  active:          true,
};

// ─── Pricing CRUD ─────────────────────────────────────────────────────────────

/**
 * Set or update a twin's pricing configuration.
 * Only the twin owner (session token must match) should call this.
 */
export async function setPricing({ sessionToken, twinId, pricing }) {
  const merged = { ...DEFAULT_PRICING, ...pricing, updatedAt: Math.floor(Date.now() / 1000) };

  // Validate
  if (merged.pricePerQuery < 0)   throw new Error('pricePerQuery cannot be negative');
  if (merged.pricePerQuery > 100) throw new Error('pricePerQuery cannot exceed 100 USDC');
  if (merged.platformFeePct < 0 || merged.platformFeePct > 50) {
    throw new Error('platformFeePct must be 0–50');
  }

  await core.vaultStore({
    sessionToken,
    key:        PRICING_VAULT_KEY(twinId),
    ciphertext: Buffer.from(JSON.stringify(merged)).toString('base64'),
    metadata:   { type: 'pricing', twinId, pricePerQuery: merged.pricePerQuery },
  });

  await core.auditLog({
    sessionToken,
    action:  'twin.pricing.updated',
    payload: { twinId, pricePerQuery: merged.pricePerQuery, queryLimitFree: merged.queryLimitFree },
  });

  logger.info({ twinId, pricePerQuery: merged.pricePerQuery }, 'Twin pricing updated');
  return merged;
}

/**
 * Read a twin's current pricing config.
 * Readable without a session token (pricing is public info).
 */
export async function getPricing({ sessionToken, twinId }) {
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: PRICING_VAULT_KEY(twinId) });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    return { ...DEFAULT_PRICING };
  }
}

// ─── Free-tier usage tracking ─────────────────────────────────────────────────

async function getFreeTierUsage({ sessionToken, twinId, callerAddress }) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: USAGE_VAULT_KEY(twinId, callerAddress, date),
    });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    return { count: 0, date };
  }
}

async function incrementFreeTierUsage({ sessionToken, twinId, callerAddress }) {
  const date = new Date().toISOString().slice(0, 10);
  const usage = await getFreeTierUsage({ sessionToken, twinId, callerAddress });
  const updated = { count: usage.count + 1, date, lastUsed: Math.floor(Date.now() / 1000) };

  await core.vaultStore({
    sessionToken,
    key:        USAGE_VAULT_KEY(twinId, callerAddress, date),
    ciphertext: Buffer.from(JSON.stringify(updated)).toString('base64'),
    metadata:   { type: 'usage_counter', twinId, callerAddress, date },
  });

  return updated;
}

// ─── Billing gate ─────────────────────────────────────────────────────────────

/**
 * Check if a query is billable and return the appropriate gate result.
 *
 * Returns one of:
 *   { pass: true,  free: true,  reason: 'owner_access' | 'free_tier' }
 *   { pass: true,  free: false, receipt: { paymentId, amount, verified } }
 *   { pass: false, payment402: { amount, currency, paymentUrl, queryId, challenge } }
 */
export async function billingGate({ sessionToken, twinId, ownerAddress, callerAddress, queryId, paymentReceiptId }) {
  const pricing = await getPricing({ sessionToken, twinId });

  if (!pricing.active) {
    return { pass: false, reason: 'twin_billing_inactive' };
  }

  // ── Owner always free ──────────────────────────────────────────────────────
  if (pricing.ownerFreeAccess && callerAddress?.toLowerCase() === ownerAddress?.toLowerCase()) {
    return { pass: true, free: true, reason: 'owner_access' };
  }

  // ── Check free tier ────────────────────────────────────────────────────────
  if (pricing.queryLimitFree > 0) {
    const usage = await getFreeTierUsage({ sessionToken, twinId, callerAddress });
    if (usage.count < pricing.queryLimitFree) {
      await incrementFreeTierUsage({ sessionToken, twinId, callerAddress });
      return {
        pass:     true,
        free:     true,
        reason:   'free_tier',
        freeTierUsed:      usage.count + 1,
        freeTierRemaining: pricing.queryLimitFree - usage.count - 1,
      };
    }
  }

  // ── Paid query ─────────────────────────────────────────────────────────────
  if (pricing.pricePerQuery === 0) {
    // No price set but free tier exhausted — still pass (open access)
    return { pass: true, free: true, reason: 'open_access' };
  }

  // If caller provided a payment receipt, verify it
  if (paymentReceiptId) {
    try {
      const { verified, receipt } = await core.verifyPayment({
        sessionToken,
        paymentId: paymentReceiptId,
      });

      if (verified) {
        logger.info({ twinId, callerAddress, queryId, paymentReceiptId }, 'Payment verified');
        return { pass: true, free: false, receipt };
      } else {
        logger.warn({ paymentReceiptId }, 'Payment receipt not verified');
        return issuePaymentChallenge({ sessionToken, twinId, queryId, pricing });
      }
    } catch (err) {
      logger.error({ err, paymentReceiptId }, 'Payment verification failed');
      return issuePaymentChallenge({ sessionToken, twinId, queryId, pricing });
    }
  }

  // No receipt — issue payment challenge
  return issuePaymentChallenge({ sessionToken, twinId, queryId, pricing });
}

async function issuePaymentChallenge({ sessionToken, twinId, queryId, pricing }) {
  const { paymentId, paymentUrl } = await core.initiatePayment({
    sessionToken,
    twinId,
    queryId,
    amount: pricing.pricePerQuery,
  });

  return {
    pass: false,
    payment402: {
      amount:        pricing.pricePerQuery,
      currency:      pricing.currency,
      paymentUrl,
      paymentId,
      queryId,
      // x402 standard fields
      x402Version:  1,
      scheme:       'exact',
      network:      'algorand',
      resource:     `/api/v1/query`,
      description:  `Query this Digital Twin — ${pricing.pricePerQuery} ${pricing.currency}`,
    },
  };
}

// ─── Earnings tracker ─────────────────────────────────────────────────────────

/**
 * Get aggregated earnings for a twin.
 * Reads from Core's audit log, filters payment events.
 */
export async function getEarnings({ sessionToken, twinId, walletAddress, days = 30 }) {
  const logs = await core.auditQuery({ sessionToken, walletAddress, limit: 200 });

  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const paymentEvents = (logs.events || []).filter(e =>
    e.action === 'twin.query.paid' &&
    e.payload?.twinId === twinId &&
    e.timestamp >= since
  );

  const totalGross = paymentEvents.reduce((sum, e) => sum + (e.payload?.amount || 0), 0);
  const platformFee = paymentEvents.reduce((sum, e) => sum + (e.payload?.platformFee || 0), 0);
  const totalNet    = totalGross - platformFee;

  // Bucket by day
  const byDay = {};
  for (const e of paymentEvents) {
    const day = new Date(e.timestamp * 1000).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (e.payload?.amount || 0);
  }

  return {
    twinId,
    period:      `${days}d`,
    queryCount:  paymentEvents.length,
    grossEarned: totalGross,
    platformFee,
    netEarned:   totalNet,
    currency:    'USDC',
    byDay,
  };
}

/**
 * Get per-query usage stats: top callers, query volume, free vs paid split.
 */
export async function getUsageStats({ sessionToken, twinId, walletAddress, days = 30 }) {
  const logs = await core.auditQuery({ sessionToken, walletAddress, limit: 500 });
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const queryEvents = (logs.events || []).filter(e =>
    (e.action === 'twin.query' || e.action === 'twin.query.paid') &&
    e.payload?.twinId === twinId &&
    e.timestamp >= since
  );

  // Confidence distribution
  const confidenceDist = { strong: 0, partial: 0, weak: 0, none: 0 };
  const callerCounts = {};
  let paidCount = 0;
  let freeCount  = 0;

  for (const e of queryEvents) {
    const conf   = e.payload?.confidence || 'none';
    const caller = e.payload?.callerAddress || 'unknown';
    confidenceDist[conf] = (confidenceDist[conf] || 0) + 1;
    callerCounts[caller] = (callerCounts[caller] || 0) + 1;
    if (e.action === 'twin.query.paid') paidCount++;
    else freeCount++;
  }

  const topCallers = Object.entries(callerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([address, count]) => ({ address, count }));

  return {
    twinId,
    period:          `${days}d`,
    totalQueries:    queryEvents.length,
    paidQueries:     paidCount,
    freeQueries:     freeCount,
    confidenceDist,
    topCallers,
  };
}
