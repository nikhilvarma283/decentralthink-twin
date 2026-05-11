/**
 * Onboarding Flow — State Machine
 *
 * Guides the twin owner through 5 sequential steps:
 *
 *   Step 1 — Identity & Wallet      SIWE sign-in, Core session created
 *   Step 2 — Knowledge Upload       First batch of training data ingested
 *   Step 3 — Style Calibration      Fingerprint extracted from samples
 *   Step 4 — Domain Review          Ontology generated, owner approves/edits
 *   Step 5 — Twin Activation        Soul Token minted, twin goes live
 *
 * State is persisted in Core Vault so it survives page refreshes / re-logins.
 * Each step is idempotent — safe to retry if a step partially fails.
 */

import core from '../core/client.js';
import { ensureCollection, ingestDocument, generateDomainOntology } from '../knowledge/ingest.js';
import { extractFingerprint } from '../style/fingerprint.js';
import { mintSoulToken } from '../soultoken/index.js';
import { logger } from '../lib/logger.js';

// ─── Step definitions ─────────────────────────────────────────────────────────

export const STEPS = {
  IDENTITY:    1,
  KNOWLEDGE:   2,
  STYLE:       3,
  DOMAINS:     4,
  ACTIVATION:  5,
};

export const STEP_NAMES = {
  1: 'identity',
  2: 'knowledge',
  3: 'style',
  4: 'domains',
  5: 'activation',
};

const VAULT_KEY = (twinId) => `twin/onboarding/${twinId}`;

// ─── Load / Save state ────────────────────────────────────────────────────────

export async function loadState({ sessionToken, twinId }) {
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: VAULT_KEY(twinId) });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    // First time — return fresh state
    return createFreshState(twinId);
  }
}

async function saveState({ sessionToken, state }) {
  await core.vaultStore({
    sessionToken,
    key: VAULT_KEY(state.twinId),
    ciphertext: Buffer.from(JSON.stringify(state)).toString('base64'),
    metadata: { type: 'onboarding_state', twinId: state.twinId, step: state.currentStep },
  });
  return state;
}

function createFreshState(twinId) {
  return {
    twinId,
    currentStep:   STEPS.IDENTITY,
    completedSteps: [],
    startedAt:     Math.floor(Date.now() / 1000),
    identity:      null,
    knowledge:     { docCount: 0, categories: [], totalWords: 0 },
    style:         null,
    domains:       null,
    activation:    null,
  };
}

// ─── Step 1 — Identity & Wallet ───────────────────────────────────────────────

/**
 * Called after SIWE sign-in succeeds.
 * Records the wallet address and creates the Qdrant collection.
 *
 * @param {object} opts
 * @param {string} opts.sessionToken  - Core session token from SIWE
 * @param {string} opts.twinId
 * @param {string} opts.walletAddress
 * @param {string} opts.displayName
 * @param {string} opts.email         - Optional
 */
export async function completeIdentityStep({ sessionToken, twinId, walletAddress, displayName, email }) {
  let state = await loadState({ sessionToken, twinId });

  if (state.completedSteps.includes(STEPS.IDENTITY)) {
    logger.info({ twinId }, 'Identity step already completed — skipping');
    return { state, skipped: true };
  }

  // Create the Qdrant collection for this wallet
  await ensureCollection(walletAddress);

  // Register twin with Core ZK Marketplace
  await core.registerTwin({
    sessionToken,
    twinId,
    walletAddress,
    displayName,
    metadata: { email, createdAt: Math.floor(Date.now() / 1000) },
  });

  // Audit
  await core.auditLog({
    sessionToken,
    action: 'twin.onboarding.identity_completed',
    payload: { twinId, walletAddress, displayName },
  });

  state = {
    ...state,
    currentStep: STEPS.KNOWLEDGE,
    completedSteps: [...state.completedSteps, STEPS.IDENTITY],
    identity: {
      walletAddress,
      displayName,
      email: email || null,
      completedAt: Math.floor(Date.now() / 1000),
    },
  };

  await saveState({ sessionToken, state });
  logger.info({ twinId, walletAddress }, 'Onboarding step 1 complete: identity');
  return { state };
}

// ─── Step 2 — Knowledge Upload ────────────────────────────────────────────────

/**
 * Called after each batch of documents is ingested.
 * Advances to Step 3 once minimum thresholds are met.
 *
 * Thresholds (configurable via env):
 *   MIN_DOCS  = 3  (at least 3 documents)
 *   MIN_WORDS = 500 (at least 500 total words)
 *
 * @param {object} opts
 * @param {string} opts.sessionToken
 * @param {string} opts.twinId
 * @param {number} opts.docsAdded     - Number of docs ingested in this batch
 * @param {string[]} opts.categories  - Categories used in this batch
 * @param {number} opts.wordsAdded    - Approx words added
 */
export async function recordKnowledgeProgress({ sessionToken, twinId, docsAdded, categories = [], wordsAdded = 0 }) {
  let state = await loadState({ sessionToken, twinId });

  if (state.currentStep < STEPS.KNOWLEDGE) {
    throw new Error('Must complete identity step first');
  }

  const MIN_DOCS  = parseInt(process.env.ONBOARDING_MIN_DOCS  || '3',  10);
  const MIN_WORDS = parseInt(process.env.ONBOARDING_MIN_WORDS || '500', 10);

  // Merge categories
  const allCategories = [...new Set([...state.knowledge.categories, ...categories])];

  state = {
    ...state,
    knowledge: {
      docCount:   state.knowledge.docCount + docsAdded,
      categories: allCategories,
      totalWords: state.knowledge.totalWords + wordsAdded,
    },
  };

  const thresholdMet = state.knowledge.docCount >= MIN_DOCS && state.knowledge.totalWords >= MIN_WORDS;

  if (thresholdMet && !state.completedSteps.includes(STEPS.KNOWLEDGE)) {
    state = {
      ...state,
      currentStep:    STEPS.STYLE,
      completedSteps: [...state.completedSteps, STEPS.KNOWLEDGE],
    };

    await core.auditLog({
      sessionToken,
      action: 'twin.onboarding.knowledge_threshold_met',
      payload: { twinId, docCount: state.knowledge.docCount, totalWords: state.knowledge.totalWords },
    });

    logger.info({ twinId, docCount: state.knowledge.docCount }, 'Onboarding step 2 complete: knowledge threshold met');
  }

  await saveState({ sessionToken, state });
  return { state, thresholdMet, remaining: { docs: Math.max(0, MIN_DOCS - state.knowledge.docCount), words: Math.max(0, MIN_WORDS - state.knowledge.totalWords) } };
}

// ─── Step 3 — Style Calibration ──────────────────────────────────────────────

/**
 * Extract style fingerprint from ingested writing samples.
 * Uses the retrieval system to pull representative samples automatically.
 *
 * @param {object} opts
 * @param {string} opts.sessionToken
 * @param {string} opts.twinId
 * @param {string} opts.walletAddress
 * @param {string} opts.displayName
 * @param {string[]} [opts.manualSamples]  - Optional extra text samples provided directly
 */
export async function completeStyleStep({ sessionToken, twinId, walletAddress, displayName, manualSamples = [] }) {
  let state = await loadState({ sessionToken, twinId });

  if (state.currentStep < STEPS.STYLE) {
    throw new Error(`Cannot run style step yet — currently on step ${state.currentStep}`);
  }
  if (state.completedSteps.includes(STEPS.STYLE)) {
    logger.info({ twinId }, 'Style step already completed — returning cached fingerprint');
    return { state, fingerprint: state.style, skipped: true };
  }

  // Pull samples from vault (stored during ingest)
  const samples = await gatherWritingSamples({ sessionToken, twinId, walletAddress, manualSamples });

  if (samples.length === 0) {
    throw new Error('No writing samples available for style calibration — upload personal documents first');
  }

  const fingerprint = await extractFingerprint(samples, displayName);

  state = {
    ...state,
    currentStep:    STEPS.DOMAINS,
    completedSteps: [...state.completedSteps, STEPS.STYLE],
    style:          { ...fingerprint, calibratedAt: Math.floor(Date.now() / 1000) },
  };

  await saveState({ sessionToken, state });

  await core.auditLog({
    sessionToken,
    action: 'twin.onboarding.style_calibrated',
    payload: { twinId, sampleCount: samples.length },
  });

  logger.info({ twinId, sampleCount: samples.length }, 'Onboarding step 3 complete: style fingerprint');
  return { state, fingerprint };
}

/**
 * Gather writing samples for style extraction.
 * Reads from the Core vault manifest to find personal-signal documents.
 */
async function gatherWritingSamples({ sessionToken, twinId, walletAddress, manualSamples }) {
  const samples = [...manualSamples];

  // Try to read the document manifest stored during ingest
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: `twin/doc_manifest/${twinId}`,
    });
    const manifest = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));

    // Take up to 10 excerpts from personal-signal docs
    const personalDocs = manifest.docs
      .filter(d => d.personalScore > 0.15)
      .slice(0, 10);

    for (const doc of personalDocs) {
      if (doc.excerpt) samples.push(doc.excerpt);
    }
  } catch {
    // Manifest not yet built — fine, use manualSamples only
  }

  return samples;
}

// ─── Step 4 — Domain Review ───────────────────────────────────────────────────

/**
 * Generate the domain ontology and present it to the owner for approval.
 * Owner can add/remove/rename domains before confirming.
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken
 * @param {string}   opts.twinId
 * @param {string}   opts.walletAddress
 * @param {string[]} [opts.approvedDomains]  - If provided, skip generation and just approve
 */
export async function generateDomainsStep({ sessionToken, twinId, walletAddress, approvedDomains = null }) {
  let state = await loadState({ sessionToken, twinId });

  if (state.currentStep < STEPS.DOMAINS) {
    throw new Error(`Cannot run domain step yet — currently on step ${state.currentStep}`);
  }

  // If domains already generated but not yet approved, allow re-approval
  if (approvedDomains !== null) {
    return approveDomains({ sessionToken, twinId, state, approvedDomains });
  }

  // Generate fresh ontology from the Qdrant collection
  const ontology = await generateDomainOntology({ sessionToken, walletAddress });

  state = {
    ...state,
    domains: {
      generated:   ontology,
      approved:    null,
      generatedAt: Math.floor(Date.now() / 1000),
    },
  };

  await saveState({ sessionToken, state });
  logger.info({ twinId, domainCount: ontology.length }, 'Domain ontology generated — awaiting owner approval');
  return { state, domains: ontology, needsApproval: true };
}

export async function approveDomains({ sessionToken, twinId, state, approvedDomains }) {
  if (!state) state = await loadState({ sessionToken, twinId });

  state = {
    ...state,
    currentStep:    STEPS.ACTIVATION,
    completedSteps: [...state.completedSteps, STEPS.DOMAINS],
    domains: {
      ...state.domains,
      approved:   approvedDomains,
      approvedAt: Math.floor(Date.now() / 1000),
    },
  };

  await saveState({ sessionToken, state });

  await core.auditLog({
    sessionToken,
    action: 'twin.onboarding.domains_approved',
    payload: { twinId, domainCount: approvedDomains.length, domains: approvedDomains.map(d => d.primary || d).slice(0, 5) },
  });

  logger.info({ twinId }, 'Onboarding step 4 complete: domains approved');
  return { state, approved: true };
}

// ─── Step 5 — Twin Activation ─────────────────────────────────────────────────

/**
 * Final step: mint the Soul Token and activate the twin.
 * After this the twin is queryable by authorised callers.
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken
 * @param {string}   opts.twinId
 * @param {string}   opts.ownerMnemonic    - Algorand mnemonic from Core vault
 * @param {string}   opts.ownerAddress
 * @param {string}   opts.manifestHash     - SHA-256 of the training manifest
 * @param {object}   [opts.defaultScopes]  - Soul Token access policy
 */
export async function activateTwin({ sessionToken, twinId, ownerMnemonic, ownerAddress, manifestHash, defaultScopes }) {
  let state = await loadState({ sessionToken, twinId });

  if (state.currentStep < STEPS.ACTIVATION) {
    throw new Error(`Twin is not ready for activation — currently on step ${state.currentStep}. Complete all prior steps.`);
  }
  if (state.completedSteps.includes(STEPS.ACTIVATION)) {
    logger.info({ twinId }, 'Twin already activated — returning existing Soul Token');
    return { state, activation: state.activation, skipped: true };
  }

  const approvedDomains = state.domains?.approved || state.domains?.generated || [];
  const displayName = state.identity?.displayName || 'Unknown';

  const { assetId, txId, metadata } = await mintSoulToken({
    sessionToken,
    ownerMnemonic,
    ownerAddress,
    twinId,
    ownerName:    displayName,
    domains:      approvedDomains,
    manifestHash,
    defaultScopes,
  });

  state = {
    ...state,
    currentStep:    null,          // All steps done
    completedSteps: [...state.completedSteps, STEPS.ACTIVATION],
    activation: {
      assetId,
      txId,
      ownerAddress,
      manifestHash,
      activatedAt: Math.floor(Date.now() / 1000),
      live:        true,
    },
  };

  await saveState({ sessionToken, state });

  logger.info({ twinId, assetId, txId }, 'Onboarding complete — twin activated');
  return {
    state,
    activation: state.activation,
    soulToken: { assetId, txId, metadata },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a user-friendly summary of onboarding progress.
 */
export function getProgressSummary(state) {
  const totalSteps = Object.keys(STEPS).length;
  const completed  = state.completedSteps.length;
  const pct        = Math.round((completed / totalSteps) * 100);

  return {
    twinId:        state.twinId,
    currentStep:   state.currentStep,
    currentStepName: state.currentStep ? STEP_NAMES[state.currentStep] : 'complete',
    completedSteps: state.completedSteps,
    percentComplete: pct,
    isComplete:    state.completedSteps.includes(STEPS.ACTIVATION),
    knowledge:     state.knowledge,
    domainsReady:  !!(state.domains?.generated),
    twinLive:      !!(state.activation?.live),
  };
}
