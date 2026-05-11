/**
 * Twin Query API — v1
 *
 * POST /api/v1/query
 *
 * Full request flow:
 *   1. Auth — valid session token required
 *   2. Access grant check — caller must have a Soul Token grant (or be the owner)
 *   3. Billing gate — x402 HTTP 402 challenge / payment receipt verification
 *   4. Style fingerprint load — fetched from Core Vault for this twin
 *   5. Query engine — RAG → boundary → style-guided generation
 *   6. Payment audit — record the paid query event on Algorand
 *
 * HTTP 402 response (payment required):
 * {
 *   "error": "Payment required",
 *   "x402": {
 *     "amount": 0.05,
 *     "currency": "USDC",
 *     "paymentUrl": "https://core.decentralthink.com/api/v1/payments/pay/...",
 *     "paymentId": "pay_...",
 *     "queryId": "query_...",
 *     "scheme": "exact",
 *     "network": "algorand"
 *   }
 * }
 *
 * Retry with: X-Payment-Receipt: <paymentId>
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { queryTwin } from '../../twin/engine.js';
import { billingGate } from '../../billing/x402.js';
import { verifyAccess } from '../../soultoken/index.js';
import core from '../../core/client.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// POST /api/v1/query
router.post('/', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token header' });

  const {
    twinId,
    twinOwner,       // wallet address of twin owner (required)
    query,
    context = 'qa',
  } = req.body;

  const callerAddress    = req.headers['x-wallet-address'] || req.body.callerAddress;
  const paymentReceiptId = req.headers['x-payment-receipt'];
  const queryId          = `query_${Date.now()}_${uuidv4().slice(0, 8)}`;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!twinOwner)    return res.status(400).json({ error: 'twinOwner required' });
  if (!twinId)       return res.status(400).json({ error: 'twinId required' });
  if (!query)        return res.status(400).json({ error: 'query required' });
  if (query.length > 2000) return res.status(400).json({ error: 'query too long (max 2000 chars)' });

  try {
    // ── Step 1: Access grant check ────────────────────────────────────────────
    // Owner can always query their own twin.
    const isOwner = callerAddress?.toLowerCase() === twinOwner?.toLowerCase();

    if (!isOwner) {
      const access = await verifyAccess({ sessionToken, twinId, callerAddress });
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Access denied — no valid grant found for this twin',
          reason: access.reason,
          hint:   'Contact the twin owner to request access at POST /api/v1/billing/:twinId/grants',
        });
      }

      // Honour per-grant query limits if set
      if (access.grant?.queryLimitPerDay) {
        // (Usage counted inside billingGate free-tier logic below — reuses same day bucket)
      }
    }

    // ── Step 2: Billing gate (x402) ───────────────────────────────────────────
    const gate = await billingGate({
      sessionToken,
      twinId,
      ownerAddress:   twinOwner,
      callerAddress,
      queryId,
      paymentReceiptId,
    });

    if (!gate.pass) {
      // Issue HTTP 402 Payment Required
      return res.status(402).json({
        error:   'Payment required',
        queryId,
        x402:    gate.payment402,
        message: `Retry this request with header: X-Payment-Receipt: <paymentId> after completing payment at ${gate.payment402?.paymentUrl}`,
      });
    }

    // ── Step 3: Load style fingerprint from Core Vault ────────────────────────
    let styleFingerprint = null;
    try {
      const { ciphertext } = await core.vaultRead({
        sessionToken,
        key: `twin/style/${twinOwner}`,
      });
      styleFingerprint = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    } catch {
      // No fingerprint yet — engine uses defaults
      logger.info({ twinId }, 'No style fingerprint in vault — using defaults');
    }

    // ── Step 4: Run query engine ──────────────────────────────────────────────
    const result = await queryTwin({
      sessionToken,
      twinOwner,
      walletAddress: twinOwner,
      twinId,
      query,
      context,
      styleFingerprint,
    });

    if (result.denied) {
      return res.status(403).json({ error: 'Access denied by policy', reasons: result.reasons });
    }

    // ── Step 5: Log paid query on Algorand (non-fatal if fails) ───────────────
    if (!gate.free && gate.receipt) {
      core.auditLog({
        sessionToken,
        action: 'twin.query.paid',
        payload: {
          queryId,
          twinId,
          twinOwner,
          callerAddress,
          amount:      gate.receipt?.amount,
          platformFee: gate.receipt?.platformFee,
          confidence:  result.confidence,
          queryLength: query.length,
        },
      }).catch(err => logger.warn({ err }, 'Paid query audit log failed (non-fatal)'));
    }

    // ── Response ──────────────────────────────────────────────────────────────
    res.json({
      queryId,
      answer:        result.answer,
      // Legacy field — keep for backward compat
      response:      result.answer,
      confidence:    result.confidence,
      boundaryScore: result.boundaryScore,
      // Billing metadata
      billing: {
        charged:           !gate.free,
        amount:            gate.free ? 0 : gate.receipt?.amount,
        currency:          'USDC',
        freeTierUsed:      gate.freeTierUsed,
        freeTierRemaining: gate.freeTierRemaining,
      },
    });

  } catch (err) {
    logger.error({ err, queryId }, 'Twin query failed');
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

export default router;
