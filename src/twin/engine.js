/**
 * Twin Inference Engine
 *
 * Query pipeline:
 *   1. Policy check (Core OPA) — is this caller allowed?
 *   2. x402 payment check (Core) — has the caller paid?
 *   3. RAG retrieval (Qdrant) — what does the twin know about this?
 *   4. Boundary scoring — how confident should the twin be?
 *   5. Style-guided generation (Ollama) — respond as the person, not as an AI
 *   6. Audit log (Core/Algorand) — log the query event
 */

import axios from 'axios';
import { retrieve } from '../knowledge/ingest.js';
import { buildStylePrompt, getDeferralPhrase } from '../style/fingerprint.js';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const BOUNDARY = {
  STRONG:  parseFloat(process.env.BOUNDARY_STRONG  || '0.85'),
  PARTIAL: parseFloat(process.env.BOUNDARY_PARTIAL || '0.70'),
  WEAK:    parseFloat(process.env.BOUNDARY_WEAK    || '0.40'),
};

/**
 * @param {object} opts
 * @param {string} opts.sessionToken     - Core session token (caller's)
 * @param {string} opts.twinOwner        - Wallet address of the twin's owner (legacy param)
 * @param {string} opts.walletAddress    - Alias for twinOwner (onboarding uses this)
 * @param {string} opts.twinId           - Twin identifier (used for onboarding/sandbox)
 * @param {string} opts.query            - The question being asked
 * @param {string} opts.context          - 'email' | 'chat' | 'document' | 'qa'
 * @param {object} opts.styleFingerprint - The twin owner's style profile
 * @param {boolean} opts.sandboxMode     - If true, skip OPA/payment checks and audit
 * @returns {object}                     - { answer, boundaryScore, confidence, queryId, sources }
 */
export async function queryTwin({
  sessionToken,
  twinOwner,
  walletAddress,
  twinId,
  query,
  context = 'qa',
  styleFingerprint,
  sandboxMode = false,
}) {
  // Normalise owner address — accept either param name
  const owner = twinOwner || walletAddress;
  const queryId = `query_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ── Step 1: Policy check via Core OPA (skipped in sandbox) ──────────────────
  if (!sandboxMode) {
    const policy = await core.checkPolicy({
      sessionToken,
      task: 'twin.query',
      context: { twinOwner: owner, query: query.slice(0, 200), context },
    });

    if (!policy.allowed) {
      logger.warn({ queryId, reasons: policy.reasons }, 'Twin query denied by policy');
      return { queryId, answer: null, denied: true, reasons: policy.reasons };
    }
  }

  // ── Step 2: RAG retrieval ────────────────────────────────────────────────────
  const results = await retrieve({ walletAddress: owner, query, limit: 5 });
  const topScore = results.length ? results[0].score : 0;
  const confidence = classifyConfidence(topScore);

  logger.info({ queryId, topScore, confidence, resultCount: results.length, sandboxMode }, 'RAG retrieval complete');

  // ── Step 3: Build response ───────────────────────────────────────────────────
  let answer;

  if (topScore < BOUNDARY.WEAK) {
    // No relevant knowledge found — clean deferral in the person's voice
    answer = getDeferralPhrase(styleFingerprint, 'out_of_scope', query);
  } else {
    // Build context from retrieved chunks
    const retrievedContext = results.map(r => r.text).join('\n\n---\n\n');

    // Build the style-aware system prompt
    const systemPrompt = buildSystemPrompt({
      styleFingerprint,
      confidence,
      context,
      retrievedContext,
    });

    answer = await generateResponse({ systemPrompt, query, confidence, styleFingerprint });
  }

  // ── Step 4: Audit the query (not the response — privacy; skipped in sandbox) ─
  if (!sandboxMode) {
    await core.auditLog({
      sessionToken,
      action: 'twin.query',
      payload: {
        queryId,
        twinOwner: owner,
        twinId,
        confidence,
        boundaryScore: topScore,
        contextType: context,
        // Never log the actual query or response — only metadata
        queryLength: query.length,
      },
    });
  }

  return {
    queryId,
    answer,
    // Keep legacy field name too for backward compat
    response: answer,
    boundaryScore: topScore,
    confidence,
    sources: results.slice(0, 5).map(r => ({
      score:    r.score,
      category: r.payload?.category,
      filename: r.payload?.filename,
    })),
    denied: false,
    sandbox: sandboxMode,
  };
}

// ─── Confidence classification ────────────────────────────────────────────────

function classifyConfidence(score) {
  if (score >= BOUNDARY.STRONG)  return 'strong';
  if (score >= BOUNDARY.PARTIAL) return 'partial';
  if (score >= BOUNDARY.WEAK)    return 'weak';
  return 'none';
}

// ─── System prompt construction ───────────────────────────────────────────────

function buildSystemPrompt({ styleFingerprint, confidence, context, retrievedContext }) {
  const stylePart = buildStylePrompt(styleFingerprint, context);

  const confidenceInstruction = {
    strong:  'You have strong knowledge of this topic. Respond with full confidence.',
    partial: 'You have partial knowledge of this topic. Respond but acknowledge the limits: "I\'ve worked around this area but I\'m not the deepest expert — here\'s what I can share..."',
    weak:    'You have only tangential knowledge of this topic. Acknowledge this openly: "I\'ve come across this but I\'d defer to a specialist. Here\'s my rough understanding..."',
    none:    '',
  }[confidence];

  return `${stylePart}

KNOWLEDGE CONTEXT (retrieved from your verified knowledge base):
${retrievedContext}

CONFIDENCE LEVEL: ${confidence}
${confidenceInstruction}

CRITICAL RULES — never break these:
- Never claim knowledge you don't have. If the context doesn't support an answer, say so in your natural voice.
- Never sound like a generic AI. No "Great question!", "It's important to note that...", "Certainly!", "Absolutely!", "Here are some key considerations:", "Let me break this down for you", "In conclusion..."
- Respond as the person described above, using their actual communication style.
- If uncertain, use their natural deferral language, not generic AI hedging.`;
}

// ─── Response generation via Ollama ──────────────────────────────────────────

async function generateResponse({ systemPrompt, query, confidence, styleFingerprint }) {
  try {
    const { data } = await axios.post(
      `${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/chat`,
      {
        model: process.env.INFERENCE_MODEL || 'nous-hermes2',
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: query },
        ],
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 1024,
        },
      }
    );
    return data.message?.content || getDeferralPhrase(styleFingerprint, 'uncertain', query);
  } catch (err) {
    logger.error({ err }, 'Inference failed');
    return getDeferralPhrase(styleFingerprint, 'uncertain', query);
  }
}
