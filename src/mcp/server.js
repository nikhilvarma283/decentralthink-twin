/**
 * MCP Server — Twin Agent Interface
 *
 * Implements the Model Context Protocol (MCP) over HTTP transport.
 * Exposes this Digital Twin as a tool-bearing MCP server that any
 * MCP-compatible AI agent (Claude, GPT, custom agents) can discover and call.
 *
 * Transport: HTTP (Streamable HTTP — MCP spec 2025-03-26)
 *   POST /api/v1/mcp/:twinId          — JSON-RPC 2.0 messages
 *   GET  /api/v1/mcp/:twinId/sse      — SSE stream for server-initiated messages
 *
 * Protocol:
 *   Client sends: initialize → tools/list → tools/call
 *   Server responds: serverInfo + capabilities → tool manifest → tool result
 *
 * All tool calls run through the same pipeline as the REST query endpoint:
 *   Soul Token grant check → x402 billing gate → RAG engine → audit log
 *
 * Composite workflows:
 *   An orchestrating agent can call check_knowledge_boundary on multiple twins,
 *   then selectively call query_twin only on the ones with relevant knowledge.
 *   This avoids paying for queries twins cannot answer.
 */

import { TOOL_DEFINITIONS } from './tools.js';
import { queryTwin } from '../twin/engine.js';
import { billingGate } from '../billing/x402.js';
import { verifyAccess } from '../soultoken/index.js';
import { getPricing } from '../billing/x402.js';
import { retrieve, generateDomainOntology } from '../knowledge/ingest.js';
import { getSoulToken } from '../soultoken/index.js';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

const SERVER_INFO = {
  name:    'decentralthink-twin',
  version: '1.0.0',
};

const CAPABILITIES = {
  tools: { listChanged: false },
};

// ─── Main MCP request handler ─────────────────────────────────────────────────

/**
 * Handle a single JSON-RPC 2.0 request (or batch).
 *
 * @param {object|object[]} body    - Parsed JSON-RPC body
 * @param {object}          ctx     - { twinId, twinOwner, sessionToken, sseStream? }
 * @returns {object|object[]|null}  - JSON-RPC response(s), or null for notifications
 */
export async function handleMCPRequest(body, ctx) {
  // Batch requests
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map(msg => handleSingleMessage(msg, ctx))
    );
    return responses.filter(Boolean); // drop null notification responses
  }

  return handleSingleMessage(body, ctx);
}

async function handleSingleMessage(msg, ctx) {
  // Notifications (no id) — process but don't respond
  if (msg.id === undefined || msg.id === null) {
    await handleNotification(msg, ctx).catch(() => {});
    return null;
  }

  try {
    const result = await dispatch(msg, ctx);
    return jsonRpcSuccess(msg.id, result);
  } catch (err) {
    return jsonRpcError(msg.id, err);
  }
}

// ─── Method dispatcher ────────────────────────────────────────────────────────

async function dispatch(msg, ctx) {
  switch (msg.method) {
    case 'initialize':      return handleInitialize(msg.params, ctx);
    case 'ping':            return {};
    case 'tools/list':      return handleToolsList(msg.params);
    case 'tools/call':      return handleToolCall(msg.params, ctx);
    default:
      throw mcpError(-32601, `Method not found: ${msg.method}`);
  }
}

// ─── initialize ──────────────────────────────────────────────────────────────

function handleInitialize(params, ctx) {
  const clientVersion = params?.protocolVersion || '2025-03-26';

  logger.info({ twinId: ctx.twinId, clientVersion, clientInfo: params?.clientInfo }, 'MCP client connected');

  return {
    protocolVersion: '2025-03-26',
    serverInfo:      SERVER_INFO,
    capabilities:    CAPABILITIES,
    instructions:    buildServerInstructions(ctx),
  };
}

function buildServerInstructions(ctx) {
  return (
    `You are interacting with an Authentic Digital Twin (DecentralThink Twin v1). ` +
    `Twin ID: ${ctx.twinId}. ` +
    `This twin only answers within its verified knowledge boundary. ` +
    `If it lacks knowledge on a topic, it returns a clean deferral rather than hallucinating. ` +
    `Call get_twin_capabilities first to understand what this twin knows. ` +
    `Call check_knowledge_boundary before query_twin to avoid paying for unanswerable queries. ` +
    `Queries may require payment — check get_twin_pricing and supply X-Payment-Receipt if needed.`
  );
}

// ─── tools/list ──────────────────────────────────────────────────────────────

function handleToolsList() {
  return { tools: TOOL_DEFINITIONS };
}

// ─── tools/call ──────────────────────────────────────────────────────────────

async function handleToolCall(params, ctx) {
  const { name, arguments: args = {} } = params;

  switch (name) {
    case 'query_twin':
      return toolQueryTwin(args, ctx);
    case 'check_knowledge_boundary':
      return toolCheckBoundary(args, ctx);
    case 'get_twin_capabilities':
      return toolGetCapabilities(args, ctx);
    case 'get_twin_pricing':
      return toolGetPricing(args, ctx);
    default:
      throw mcpError(-32602, `Unknown tool: ${name}`);
  }
}

// ─── Tool: query_twin ─────────────────────────────────────────────────────────

async function toolQueryTwin(args, ctx) {
  const { query, context = 'qa', callerAddress, paymentReceiptId } = args;

  if (!query) throw mcpError(-32602, 'query is required');
  if (query.length > 2000) throw mcpError(-32602, 'query too long (max 2000 chars)');

  const queryId = `mcp_${Date.now()}_${uuidv4().slice(0, 8)}`;

  // ── Grant check ────────────────────────────────────────────────────────────
  const isOwner = callerAddress?.toLowerCase() === ctx.twinOwner?.toLowerCase();
  if (!isOwner && callerAddress) {
    const access = await verifyAccess({
      sessionToken: ctx.sessionToken,
      twinId:       ctx.twinId,
      callerAddress,
    });
    if (!access.allowed) {
      return toolError(
        `Access denied — no valid grant for address ${callerAddress}. ` +
        `Contact the twin owner to request access.`,
        { code: 'NO_GRANT', reason: access.reason }
      );
    }
  }

  // ── Billing gate ───────────────────────────────────────────────────────────
  const gate = await billingGate({
    sessionToken:    ctx.sessionToken,
    twinId:          ctx.twinId,
    ownerAddress:    ctx.twinOwner,
    callerAddress:   callerAddress || ctx.twinOwner,
    queryId,
    paymentReceiptId,
  });

  if (!gate.pass) {
    const p = gate.payment402;
    return toolError(
      `Payment required — ${p.amount} ${p.currency} per query. ` +
      `Complete payment at: ${p.paymentUrl} ` +
      `then retry with paymentReceiptId: "${p.paymentId}"`,
      {
        code:     'PAYMENT_REQUIRED',
        x402:     p,
        httpCode: 402,
      }
    );
  }

  // ── Load style fingerprint ─────────────────────────────────────────────────
  let styleFingerprint = null;
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken: ctx.sessionToken,
      key: `twin/style/${ctx.twinOwner}`,
    });
    styleFingerprint = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch { /* use defaults */ }

  // ── Run query ──────────────────────────────────────────────────────────────
  const result = await queryTwin({
    sessionToken:    ctx.sessionToken,
    twinOwner:       ctx.twinOwner,
    walletAddress:   ctx.twinOwner,
    twinId:          ctx.twinId,
    query,
    context,
    styleFingerprint,
  });

  if (result.denied) {
    return toolError('Query denied by access policy', { reasons: result.reasons });
  }

  // ── Paid query audit ───────────────────────────────────────────────────────
  if (!gate.free && gate.receipt) {
    core.auditLog({
      sessionToken: ctx.sessionToken,
      action: 'twin.query.paid',
      payload: {
        queryId,
        twinId:        ctx.twinId,
        twinOwner:     ctx.twinOwner,
        callerAddress,
        amount:        gate.receipt?.amount,
        confidence:    result.confidence,
        transport:     'mcp',
        queryLength:   query.length,
      },
    }).catch(err => logger.warn({ err }, 'MCP paid query audit failed'));
  }

  return toolSuccess([
    textContent(result.answer),
  ], {
    queryId,
    confidence:    result.confidence,
    boundaryScore: result.boundaryScore,
    billing: {
      charged:           !gate.free,
      amount:            gate.free ? 0 : gate.receipt?.amount,
      currency:          'USDC',
      freeTierUsed:      gate.freeTierUsed,
      freeTierRemaining: gate.freeTierRemaining,
    },
  });
}

// ─── Tool: check_knowledge_boundary ──────────────────────────────────────────

async function toolCheckBoundary(args, ctx) {
  const { topic } = args;
  if (!topic) throw mcpError(-32602, 'topic is required');

  // Run a retrieval probe — no query consumed, no billing
  const results = await retrieve({
    walletAddress: ctx.twinOwner,
    query:         topic,
    limit:         3,
  });

  const topScore   = results.length ? results[0].score : 0;
  const confidence = topScore >= 0.85 ? 'strong'
                   : topScore >= 0.70 ? 'partial'
                   : topScore >= 0.40 ? 'weak'
                   : 'none';

  const hasKnowledge = topScore >= 0.40;

  const summary = hasKnowledge
    ? `This twin has ${confidence} knowledge on "${topic}" (score: ${topScore.toFixed(3)}). Querying is likely to produce a useful answer.`
    : `This twin does not appear to have knowledge on "${topic}" (score: ${topScore.toFixed(3)}). A query would return a deferral.`;

  return toolSuccess([textContent(summary)], {
    topic,
    hasKnowledge,
    confidence,
    topScore,
    matchingChunks: results.slice(0, 3).map(r => ({
      score:    r.score,
      category: r.payload?.category,
      snippet:  r.payload?.text?.slice(0, 120),
    })),
  });
}

// ─── Tool: get_twin_capabilities ─────────────────────────────────────────────

async function toolGetCapabilities(args, ctx) {
  // Load Soul Token for domain info
  const soulToken = await getSoulToken({ sessionToken: ctx.sessionToken, twinId: ctx.twinId });
  const props = soulToken?.metadata?.properties || {};

  // Load style fingerprint summary
  let styleSummary = null;
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken: ctx.sessionToken,
      key: `twin/style/${ctx.twinOwner}`,
    });
    const fp = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    styleSummary = {
      voice:          fp.voice,
      formality:      fp.formality,
      technicalDepth: fp.technicalDepth,
    };
  } catch { /* fingerprint not yet calibrated */ }

  const domains = props.knowledgeDomains || [];
  const domainList = domains.length
    ? domains.map(d => `• ${d.primary || d}${d.description ? ` — ${d.description}` : ''}`).join('\n')
    : 'No domains mapped yet.';

  const text =
    `DecentralThink Authentic Digital Twin\n` +
    `Owner: ${props.ownerName || ctx.twinOwner}\n` +
    `Twin ID: ${ctx.twinId}\n\n` +
    `KNOWLEDGE DOMAINS:\n${domainList}\n\n` +
    `STYLE: ${styleSummary ? `${styleSummary.voice}, ${styleSummary.formality} formality, ${styleSummary.technicalDepth} technical depth` : 'Not yet calibrated'}\n\n` +
    `ACCESS POLICY:\n` +
    `  Default scopes: ${(props.defaultScopes || ['qa']).join(', ')}\n` +
    `  Query limit: ${props.queryLimitPerDay || 'unlimited'}/day\n` +
    `  Expires: ${props.expiry ? new Date(props.expiry * 1000).toISOString().slice(0, 10) : 'never'}\n\n` +
    `SOUL TOKEN (consent NFT):\n` +
    `  Asset ID: ${soulToken?.assetId || 'not yet minted'}\n` +
    `  Network: Algorand\n` +
    `  Soulbound: yes (non-transferable)\n`;

  return toolSuccess([textContent(text)], {
    twinId:       ctx.twinId,
    ownerAddress: ctx.twinOwner,
    domains,
    styleSummary,
    soulToken: soulToken ? { assetId: soulToken.assetId } : null,
  });
}

// ─── Tool: get_twin_pricing ───────────────────────────────────────────────────

async function toolGetPricing(args, ctx) {
  const pricing = await getPricing({ sessionToken: ctx.sessionToken, twinId: ctx.twinId });

  const text = pricing.pricePerQuery === 0
    ? `This twin is free to query (open access). Free tier: ${pricing.queryLimitFree} queries/day per caller.`
    : `This twin charges ${pricing.pricePerQuery} ${pricing.currency} per query after ${pricing.queryLimitFree} free queries/day. ` +
      `Use get_twin_pricing to retrieve current pricing before querying.`;

  return toolSuccess([textContent(text)], {
    pricePerQuery:  pricing.pricePerQuery,
    currency:       pricing.currency,
    queryLimitFree: pricing.queryLimitFree,
    active:         pricing.active,
  });
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function jsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, err) {
  if (err.isMCPError) {
    return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, data: err.data } };
  }
  logger.error({ err }, 'MCP handler threw unexpected error');
  return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: err.message } };
}

function mcpError(code, message, data) {
  const e = new Error(message);
  e.isMCPError = true;
  e.code = code;
  e.data = data;
  return e;
}

// ─── Tool response helpers ────────────────────────────────────────────────────

function toolSuccess(content, metadata = {}) {
  return { content, isError: false, _meta: metadata };
}

function toolError(message, metadata = {}) {
  return {
    content:  [textContent(`Error: ${message}`)],
    isError:  true,
    _meta:    metadata,
  };
}

function textContent(text) {
  return { type: 'text', text };
}
