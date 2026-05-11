/**
 * Billing API — v1
 *
 * Twin owner manages pricing; organisations see what a query costs.
 *
 * GET  /api/v1/billing/:twinId/pricing          — public: what does this twin cost?
 * PUT  /api/v1/billing/:twinId/pricing          — owner only: set pricing
 * GET  /api/v1/billing/:twinId/earnings         — owner only: revenue dashboard
 * GET  /api/v1/billing/:twinId/usage            — owner only: query stats
 * GET  /api/v1/billing/:twinId/grants           — list all access grants
 * POST /api/v1/billing/:twinId/grants           — create an access grant
 * DELETE /api/v1/billing/:twinId/grants/:addr   — revoke an access grant
 */

import express from 'express';
import { setPricing, getPricing, getEarnings, getUsageStats } from '../../billing/x402.js';
import { grantAccess, revokeAccess, getSoulToken } from '../../soultoken/index.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// ─── GET /pricing — public ─────────────────────────────────────────────────────

/**
 * Anyone can check what a twin charges. No auth required.
 */
router.get('/:twinId/pricing', async (req, res) => {
  try {
    const { twinId } = req.params;
    // Pricing is public — pass undefined session token, getPricing handles the miss
    const sessionToken = req.headers['x-session-token'];
    const pricing = await getPricing({ sessionToken, twinId });

    res.json({
      twinId,
      pricePerQuery:   pricing.pricePerQuery,
      currency:        pricing.currency,
      queryLimitFree:  pricing.queryLimitFree,
      active:          pricing.active,
      // Don't expose platformFeePct or internal config
    });
  } catch (err) {
    logger.error({ err }, 'Get pricing failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /pricing — owner only ────────────────────────────────────────────────

/**
 * PUT /api/v1/billing/:twinId/pricing
 * Body: { pricePerQuery, queryLimitFree, active }
 *
 * Examples:
 *   { pricePerQuery: 0.05, queryLimitFree: 5 }   — $0.05 USDC after 5 free/day
 *   { pricePerQuery: 0,    queryLimitFree: 0 }   — fully open (no payment required)
 *   { active: false }                             — take twin offline
 */
router.put('/:twinId/pricing', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId } = req.params;
    const { pricePerQuery, queryLimitFree, active } = req.body;

    const pricing = await setPricing({
      sessionToken,
      twinId,
      pricing: {
        ...(pricePerQuery  !== undefined && { pricePerQuery }),
        ...(queryLimitFree !== undefined && { queryLimitFree }),
        ...(active         !== undefined && { active }),
      },
    });

    res.json({
      twinId,
      pricing: {
        pricePerQuery:  pricing.pricePerQuery,
        currency:       pricing.currency,
        queryLimitFree: pricing.queryLimitFree,
        active:         pricing.active,
        updatedAt:      pricing.updatedAt,
      },
      message: pricing.pricePerQuery > 0
        ? `Callers will be charged ${pricing.pricePerQuery} ${pricing.currency} per query after ${pricing.queryLimitFree} free queries/day.`
        : 'Twin is set to open access (no charge).',
    });
  } catch (err) {
    logger.error({ err }, 'Set pricing failed');
    const status = err.message.includes('cannot') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── GET /earnings — owner only ───────────────────────────────────────────────

/**
 * GET /api/v1/billing/:twinId/earnings?days=30&walletAddress=0x...
 * Revenue dashboard: gross, platform fee, net, by-day breakdown.
 */
router.get('/:twinId/earnings', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId } = req.params;
    const { walletAddress, days = '30' } = req.query;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress query param required' });

    const earnings = await getEarnings({
      sessionToken,
      twinId,
      walletAddress,
      days: parseInt(days, 10),
    });

    res.json(earnings);
  } catch (err) {
    logger.error({ err }, 'Get earnings failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /usage — owner only ──────────────────────────────────────────────────

/**
 * GET /api/v1/billing/:twinId/usage?days=30&walletAddress=0x...
 * Query stats: volume, confidence distribution, top callers.
 */
router.get('/:twinId/usage', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId } = req.params;
    const { walletAddress, days = '30' } = req.query;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress query param required' });

    const stats = await getUsageStats({
      sessionToken,
      twinId,
      walletAddress,
      days: parseInt(days, 10),
    });

    res.json(stats);
  } catch (err) {
    logger.error({ err }, 'Get usage stats failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /grants — list access grants ────────────────────────────────────────

/**
 * GET /api/v1/billing/:twinId/grants
 * Returns the Soul Token info which contains grant metadata.
 */
router.get('/:twinId/grants', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId } = req.params;
    const soulToken = await getSoulToken({ sessionToken, twinId });

    if (!soulToken) {
      return res.status(404).json({ error: 'Twin not yet activated — no Soul Token found' });
    }

    res.json({
      twinId,
      assetId:  soulToken.assetId,
      metadata: {
        defaultScopes:    soulToken.metadata?.properties?.defaultScopes,
        queryLimitPerDay: soulToken.metadata?.properties?.queryLimitPerDay,
        expiry:           soulToken.metadata?.properties?.expiry,
      },
      note: 'Individual grants are stored in Core Vault. Use Core audit log to see all grantees.',
    });
  } catch (err) {
    logger.error({ err }, 'Get grants failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /grants — create an access grant ───────────────────────────────────

/**
 * POST /api/v1/billing/:twinId/grants
 * Body: { granteeAddress, scopes, queryLimitPerDay, expiryDays }
 *
 * Grants an organisation access to query this twin.
 * The Soul Token stays with the owner — only the access record is created.
 */
router.post('/:twinId/grants', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId } = req.params;
    const {
      granteeAddress,
      scopes          = ['qa'],
      queryLimitPerDay = 50,
      expiryDays      = 365,
    } = req.body;

    if (!granteeAddress) return res.status(400).json({ error: 'granteeAddress required' });

    const { grantId, txId, grant } = await grantAccess({
      sessionToken,
      twinId,
      granteeAddress,
      scopes: { scopes, queryLimitPerDay, expiryDays },
    });

    res.status(201).json({
      grantId,
      twinId,
      granteeAddress,
      grant: {
        scopes:          grant.scopes,
        queryLimitPerDay: grant.queryLimitPerDay,
        expiry:          grant.expiry,
        grantedAt:       grant.grantedAt,
      },
      txId,
      message: `Access granted to ${granteeAddress}. Grant recorded on Algorand (txId: ${txId}).`,
    });
  } catch (err) {
    logger.error({ err }, 'Grant access failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /grants/:addr — revoke ───────────────────────────────────────────

/**
 * DELETE /api/v1/billing/:twinId/grants/:granteeAddress
 * Revokes an organisation's access. Recorded on Algorand audit chain.
 */
router.delete('/:twinId/grants/:granteeAddress', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });

  try {
    const { twinId, granteeAddress } = req.params;

    const { txId } = await revokeAccess({ sessionToken, twinId, granteeAddress });

    res.json({
      twinId,
      granteeAddress,
      revoked: true,
      txId,
      message: `Access revoked for ${granteeAddress}. Logged on Algorand (txId: ${txId}).`,
    });
  } catch (err) {
    logger.error({ err }, 'Revoke access failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
