/**
 * MCP HTTP Transport — v1
 *
 * Exposes the twin as an MCP server over HTTP (Streamable HTTP transport,
 * MCP spec 2025-03-26). Any MCP-compatible client (Claude Desktop, custom
 * agents, orchestrators) can connect to this endpoint.
 *
 * Endpoints:
 *   GET  /api/v1/mcp/:twinId            — MCP server discovery (returns server info)
 *   POST /api/v1/mcp/:twinId            — JSON-RPC 2.0 messages (main transport)
 *   GET  /api/v1/mcp/:twinId/sse        — SSE stream for server-initiated events
 *   GET  /api/v1/mcp/registry           — list all live twins registered in ZK Marketplace
 *
 * Authentication:
 *   The twinOwner wallet address is resolved from the twin registry.
 *   Callers identify themselves via X-Wallet-Address header.
 *   Payments via X-Payment-Receipt header (x402 flow).
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "dr-varma-twin": {
 *       "url": "https://twin.decentralthink.com/api/v1/mcp/twin_abc123",
 *       "transport": "http"
 *     }
 *   }
 * }
 */

import express from 'express';
import { handleMCPRequest } from '../../mcp/server.js';
import { TOOL_DEFINITIONS } from '../../mcp/tools.js';
import core from '../../core/client.js';
import { getSoulToken } from '../../soultoken/index.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// In-memory twin registry cache (refreshed on each registry request)
// In production: use Redis or Core ZK Marketplace lookup
const twinRegistry = new Map();

// ─── Resolve twin context from registry ──────────────────────────────────────

async function resolveTwin(twinId, sessionToken) {
  // Check cache first
  if (twinRegistry.has(twinId)) {
    return twinRegistry.get(twinId);
  }

  // Try to load from Core vault (onboarding stores identity there)
  try {
    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: `twin/onboarding/${twinId}`,
    });
    const state = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    const ctx = {
      twinId,
      twinOwner: state.identity?.walletAddress,
      displayName: state.identity?.displayName,
    };
    twinRegistry.set(twinId, ctx);
    return ctx;
  } catch {
    return null;
  }
}

// ─── GET /api/v1/mcp/:twinId — discovery ─────────────────────────────────────

/**
 * Returns human-readable server info + tool manifest.
 * Used by MCP clients during connection setup.
 */
router.get('/:twinId', async (req, res) => {
  try {
    const { twinId } = req.params;
    const sessionToken = req.headers['x-session-token'];

    const twin = await resolveTwin(twinId, sessionToken);
    if (!twin) {
      return res.status(404).json({ error: `Twin ${twinId} not found or not yet activated` });
    }

    const soulToken = sessionToken
      ? await getSoulToken({ sessionToken, twinId }).catch(() => null)
      : null;

    res.json({
      name:        `DecentralThink Twin — ${twin.displayName || twinId}`,
      version:     '1.0.0',
      protocol:    'MCP 2025-03-26',
      twinId,
      ownerAddress: twin.twinOwner,
      transport: {
        http: `${req.protocol}://${req.get('host')}/api/v1/mcp/${twinId}`,
        sse:  `${req.protocol}://${req.get('host')}/api/v1/mcp/${twinId}/sse`,
      },
      tools: TOOL_DEFINITIONS.map(t => ({ name: t.name, description: t.description })),
      soulToken: soulToken ? { assetId: soulToken.assetId, network: 'algorand' } : null,
      claudeDesktopConfig: {
        mcpServers: {
          [`${twin.displayName?.toLowerCase().replace(/\s+/g, '-') || twinId}-twin`]: {
            url:       `${req.protocol}://${req.get('host')}/api/v1/mcp/${twinId}`,
            transport: 'http',
          },
        },
      },
    });
  } catch (err) {
    logger.error({ err }, 'MCP discovery failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/v1/mcp/:twinId — JSON-RPC 2.0 main transport ──────────────────

router.post('/:twinId', async (req, res) => {
  const { twinId } = req.params;
  const sessionToken  = req.headers['x-session-token'];
  const callerAddress = req.headers['x-wallet-address'];

  if (!sessionToken) {
    return res.status(401).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32001, message: 'Missing X-Session-Token header' },
    });
  }

  try {
    // Resolve the twin's owner address from registry
    const twin = await resolveTwin(twinId, sessionToken);
    if (!twin) {
      return res.status(404).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32002, message: `Twin ${twinId} not found` },
      });
    }

    const ctx = {
      twinId,
      twinOwner:   twin.twinOwner,
      sessionToken,
      callerAddress,
    };

    const body = req.body;

    // Validate JSON-RPC structure
    if (!body || (Array.isArray(body) ? body.length === 0 : !body.method)) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error — invalid JSON-RPC request' },
      });
    }

    const response = await handleMCPRequest(body, ctx);

    // Notifications return null — respond 202 Accepted
    if (response === null) {
      return res.status(202).end();
    }

    // For streaming responses (tools/call with SSE), set appropriate headers
    if (req.headers.accept?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify(response)}\n\n`);
      return res.end();
    }

    res.json(response);

  } catch (err) {
    logger.error({ err, twinId }, 'MCP request handler failed');
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: 'Internal error', data: err.message },
    });
  }
});

// ─── GET /api/v1/mcp/:twinId/sse — SSE stream ────────────────────────────────

/**
 * Server-Sent Events stream for server-initiated messages.
 * Kept alive with periodic ping events (every 30s).
 * Used by MCP clients that prefer streaming transport.
 */
router.get('/:twinId/sse', async (req, res) => {
  const { twinId } = req.params;
  const sessionToken = req.headers['x-session-token'];

  if (!sessionToken) {
    return res.status(401).json({ error: 'Missing X-Session-Token' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering

  // Send initial endpoint event (MCP spec requires this)
  const postEndpoint = `${req.protocol}://${req.get('host')}/api/v1/mcp/${twinId}`;
  res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: postEndpoint })}\n\n`);

  // Keepalive ping every 30 seconds
  const ping = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 30_000);

  logger.info({ twinId }, 'MCP SSE client connected');

  req.on('close', () => {
    clearInterval(ping);
    logger.info({ twinId }, 'MCP SSE client disconnected');
  });
});

// ─── GET /api/v1/mcp/registry — list all live twins ──────────────────────────

/**
 * Lists all twins that have completed onboarding (have a Soul Token).
 * Enables agents to discover available twins before connecting.
 */
router.get('/registry', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'Missing X-Session-Token' });
  }

  try {
    // Query the Core ZK Marketplace for registered twins
    const { data } = await core.vaultRead({
      sessionToken,
      key: 'twin/registry/index',
    }).catch(() => ({ data: null }));

    // If no index built yet, return whatever's in the local cache
    const twins = data
      ? JSON.parse(Buffer.from(data.ciphertext, 'base64').toString('utf-8'))
      : Array.from(twinRegistry.values());

    const baseUrl = `${req.protocol}://${req.get('host')}/api/v1/mcp`;

    res.json({
      twins: twins.map(t => ({
        twinId:      t.twinId,
        displayName: t.displayName,
        mcpEndpoint: `${baseUrl}/${t.twinId}`,
        sseEndpoint: `${baseUrl}/${t.twinId}/sse`,
      })),
      total: twins.length,
      protocol: 'MCP 2025-03-26',
    });
  } catch (err) {
    logger.error({ err }, 'Registry lookup failed');
    res.status(500).json({ error: err.message });
  }
});

export default router;
