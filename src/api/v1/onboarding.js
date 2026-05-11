/**
 * Onboarding API — v1
 *
 * REST endpoints that drive the 5-step twin creation wizard.
 * All routes require a valid Core session token (X-Session-Token header).
 *
 * POST /api/v1/onboarding/start              — Step 1: record identity after SIWE
 * GET  /api/v1/onboarding/:twinId/state      — Get current progress
 * POST /api/v1/onboarding/:twinId/style      — Step 3: trigger style calibration
 * POST /api/v1/onboarding/:twinId/domains    — Step 4: generate domain ontology
 * POST /api/v1/onboarding/:twinId/domains/approve — Step 4: approve domain list
 * POST /api/v1/onboarding/:twinId/activate   — Step 5: mint Soul Token
 * GET  /api/v1/onboarding/:twinId/sandbox    — Step 5: test the twin before activation
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  loadState,
  getProgressSummary,
  completeIdentityStep,
  recordKnowledgeProgress,
  completeStyleStep,
  generateDomainsStep,
  approveDomains,
  activateTwin,
} from '../../onboarding/flow.js';
import { queryTwin } from '../../twin/engine.js';
import core from '../../core/client.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireSession(req, res, next) {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Missing X-Session-Token header' });
  }
  req.sessionToken = sessionToken;
  next();
}

router.use(requireSession);

// ─── GET /state ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/onboarding/:twinId/state
 * Returns current onboarding progress.
 */
router.get('/:twinId/state', async (req, res) => {
  try {
    const { twinId } = req.params;
    const state = await loadState({ sessionToken: req.sessionToken, twinId });
    res.json({ twinId, progress: getProgressSummary(state) });
  } catch (err) {
    logger.error({ err }, 'Failed to load onboarding state');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /start — Step 1: Identity ───────────────────────────────────────────

/**
 * POST /api/v1/onboarding/start
 * Body: { walletAddress, displayName, email? }
 * Called immediately after SIWE sign-in succeeds.
 * Creates the twin ID and initialises the onboarding state.
 */
router.post('/start', async (req, res) => {
  try {
    const { walletAddress, displayName, email } = req.body;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
    if (!displayName)  return res.status(400).json({ error: 'displayName is required' });

    // Derive twinId deterministically from wallet (or use provided one)
    const twinId = req.body.twinId || `twin_${walletAddress.toLowerCase().slice(2, 10)}_${uuidv4().slice(0, 8)}`;

    const { state } = await completeIdentityStep({
      sessionToken:  req.sessionToken,
      twinId,
      walletAddress,
      displayName,
      email,
    });

    res.status(201).json({
      twinId,
      nextStep: 'knowledge',
      progress: getProgressSummary(state),
      message:  'Identity confirmed. Upload your knowledge to continue.',
    });
  } catch (err) {
    logger.error({ err }, 'Onboarding start failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:twinId/style — Step 3 ─────────────────────────────────────────────

/**
 * POST /api/v1/onboarding/:twinId/style
 * Body: { walletAddress, displayName, samples?: string[] }
 * Triggers style fingerprint extraction.
 * Can be called after sufficient documents are ingested.
 */
router.post('/:twinId/style', async (req, res) => {
  try {
    const { twinId } = req.params;
    const { walletAddress, displayName, samples = [] } = req.body;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });
    if (!displayName)  return res.status(400).json({ error: 'displayName is required' });

    const { state, fingerprint, skipped } = await completeStyleStep({
      sessionToken:   req.sessionToken,
      twinId,
      walletAddress,
      displayName,
      manualSamples:  samples,
    });

    res.json({
      twinId,
      skipped,
      fingerprint: {
        voice:          fingerprint.voice,
        formality:      fingerprint.formality,
        technicalDepth: fingerprint.technicalDepth,
        keyPhrases:     fingerprint.keyPhrases?.slice(0, 10),
        topicsToAvoid:  fingerprint.topicsToAvoid,
      },
      nextStep: 'domains',
      progress: getProgressSummary(state),
    });
  } catch (err) {
    logger.error({ err, twinId: req.params.twinId }, 'Style calibration failed');
    const status = err.message.includes('Cannot run') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /:twinId/domains — Step 4: Generate ─────────────────────────────────

/**
 * POST /api/v1/onboarding/:twinId/domains
 * Body: { walletAddress }
 * Generates the domain ontology from ingested knowledge.
 * Returns the list of proposed domains for owner review.
 */
router.post('/:twinId/domains', async (req, res) => {
  try {
    const { twinId } = req.params;
    const { walletAddress } = req.body;

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    const { state, domains, needsApproval } = await generateDomainsStep({
      sessionToken:  req.sessionToken,
      twinId,
      walletAddress,
    });

    res.json({
      twinId,
      domains,
      needsApproval,
      message: 'Review these knowledge domains. Remove any you don\'t want to represent. Then POST to /domains/approve.',
      progress: getProgressSummary(state),
    });
  } catch (err) {
    logger.error({ err, twinId: req.params.twinId }, 'Domain generation failed');
    const status = err.message.includes('Cannot run') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /:twinId/domains/approve — Step 4: Approve ──────────────────────────

/**
 * POST /api/v1/onboarding/:twinId/domains/approve
 * Body: { domains: [{ primary, related[], description }] }
 * Owner confirms/edits the domain list.
 */
router.post('/:twinId/domains/approve', async (req, res) => {
  try {
    const { twinId } = req.params;
    const { domains } = req.body;

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'domains must be a non-empty array' });
    }

    const { state } = await approveDomains({
      sessionToken:    req.sessionToken,
      twinId,
      approvedDomains: domains,
    });

    res.json({
      twinId,
      approved:  true,
      domains,
      nextStep:  'activation',
      progress:  getProgressSummary(state),
      message:   'Domains locked in. Ready to activate your twin.',
    });
  } catch (err) {
    logger.error({ err, twinId: req.params.twinId }, 'Domain approval failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:twinId/sandbox — Test before activation ────────────────────────────

/**
 * GET /api/v1/onboarding/:twinId/sandbox?q=<query>&walletAddress=<addr>
 * Lets the owner test their twin before minting the Soul Token.
 * Returns a response using current knowledge + style, with a preview watermark.
 */
router.get('/:twinId/sandbox', async (req, res) => {
  try {
    const { twinId } = req.params;
    const { q: query, walletAddress } = req.query;

    if (!query)         return res.status(400).json({ error: 'q (query) is required' });
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    // Load state to check at least knowledge is done
    const state = await loadState({ sessionToken: req.sessionToken, twinId });
    if (!state.completedSteps.includes(1)) {
      return res.status(400).json({ error: 'Complete onboarding steps 1–3 before testing' });
    }

    // Run the query engine in sandbox mode (no audit log, no rate limit check)
    const result = await queryTwin({
      sessionToken: req.sessionToken,
      twinId,
      walletAddress,
      query,
      callerAddress: walletAddress,  // Owner queries their own twin
      sandboxMode:   true,
    });

    res.json({
      twinId,
      sandbox:   true,
      query,
      answer:    result.answer,
      confidence: result.confidence,
      sources:   result.sources?.slice(0, 3),
      watermark: '⚠️  SANDBOX — twin not yet activated. Responses are for preview only.',
      progress:  getProgressSummary(state),
    });
  } catch (err) {
    logger.error({ err, twinId: req.params.twinId }, 'Sandbox query failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:twinId/activate — Step 5 ──────────────────────────────────────────

/**
 * POST /api/v1/onboarding/:twinId/activate
 * Body: { ownerMnemonic, ownerAddress, manifestHash?, defaultScopes? }
 *
 * defaultScopes defaults: { scopes: ['qa'], queryLimitPerDay: 100, expiryDays: 365 }
 *
 * ⚠️  ownerMnemonic is sensitive. In production the mnemonic should stay in
 *     Core Vault and be retrieved server-side rather than sent over the wire.
 *     For the MVP this flow is acceptable over HTTPS.
 */
router.post('/:twinId/activate', async (req, res) => {
  try {
    const { twinId } = req.params;
    const {
      ownerMnemonic,
      ownerAddress,
      manifestHash,
      defaultScopes = { scopes: ['qa'], queryLimitPerDay: 100, expiryDays: 365 },
    } = req.body;

    if (!ownerMnemonic) return res.status(400).json({ error: 'ownerMnemonic is required' });
    if (!ownerAddress)  return res.status(400).json({ error: 'ownerAddress is required' });

    const { state, activation, soulToken, skipped } = await activateTwin({
      sessionToken: req.sessionToken,
      twinId,
      ownerMnemonic,
      ownerAddress,
      manifestHash:  manifestHash || `manifest_${twinId}`,
      defaultScopes,
    });

    res.status(skipped ? 200 : 201).json({
      twinId,
      live:      true,
      skipped,
      soulToken: {
        assetId: soulToken?.assetId || activation.assetId,
        txId:    soulToken?.txId    || activation.txId,
        network: process.env.ALGORAND_NETWORK || 'testnet',
      },
      activation,
      progress: getProgressSummary(state),
      message:  'Your Digital Twin is now live. Share your Twin ID with organisations to grant access.',
    });
  } catch (err) {
    logger.error({ err, twinId: req.params.twinId }, 'Twin activation failed');
    const status = err.message.includes('not ready') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Knowledge progress hook (called by ingest.js) ───────────────────────────

/**
 * POST /api/v1/onboarding/:twinId/knowledge-progress
 * Internal endpoint called by the ingest API after each successful ingest.
 * Updates the knowledge progress counter and advances step if threshold is met.
 */
router.post('/:twinId/knowledge-progress', async (req, res) => {
  try {
    const { twinId } = req.params;
    const { docsAdded = 1, categories = [], wordsAdded = 0 } = req.body;

    const result = await recordKnowledgeProgress({
      sessionToken: req.sessionToken,
      twinId,
      docsAdded,
      categories,
      wordsAdded,
    });

    res.json({
      twinId,
      thresholdMet: result.thresholdMet,
      remaining:    result.remaining,
      progress:     getProgressSummary(result.state),
    });
  } catch (err) {
    // Non-fatal — ingest already succeeded, just log
    logger.warn({ err, twinId: req.params.twinId }, 'Knowledge progress update failed (non-fatal)');
    res.status(200).json({ warning: err.message });
  }
});

export default router;
