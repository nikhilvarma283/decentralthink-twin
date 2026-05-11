/**
 * MCP Tool Definitions
 *
 * Defines the four tools this twin exposes to AI agents via the
 * Model Context Protocol (JSON-RPC 2.0 over HTTP + SSE).
 *
 * Tools:
 *   query_twin             — ask the twin a question (full billing + consent pipeline)
 *   check_knowledge_boundary — does this twin have knowledge on a topic? (no query consumed)
 *   get_twin_capabilities  — what domains does this twin know? what are its access rules?
 *   get_twin_pricing       — what does a query cost?
 *
 * Every tool enforces the same invariants as the REST query endpoint:
 *   - Soul Token grant required (or owner)
 *   - Billing gate (x402)
 *   - Knowledge boundary by absence
 */

// ─── Tool manifests (returned by tools/list) ──────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'query_twin',
    description:
      'Ask this Digital Twin a question. The twin only answers within its verified knowledge boundary — ' +
      'if it doesn\'t know something, it says so cleanly rather than hallucinating. ' +
      'Responses are stylistically calibrated to sound like the actual person, not a generic AI.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question or request to pose to the twin.',
          maxLength: 2000,
        },
        context: {
          type: 'string',
          enum: ['qa', 'email', 'document', 'chat'],
          description: 'The interaction context — affects tone and style. Default: qa.',
          default: 'qa',
        },
        callerAddress: {
          type: 'string',
          description: 'The Algorand/Ethereum wallet address of the calling agent or organisation.',
        },
        paymentReceiptId: {
          type: 'string',
          description: 'x402 payment receipt ID (required once free tier is exhausted).',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'check_knowledge_boundary',
    description:
      'Check whether this twin has knowledge relevant to a topic WITHOUT consuming a query or triggering billing. ' +
      'Returns a confidence score and the matching knowledge domains. ' +
      'Use this before query_twin to avoid paying for a query the twin cannot answer.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic or subject area to probe.',
          maxLength: 500,
        },
      },
      required: ['topic'],
    },
  },

  {
    name: 'get_twin_capabilities',
    description:
      'Returns the twin\'s knowledge domains, communication style summary, access policy, and Soul Token details. ' +
      'Use this first to understand what the twin knows and how to interact with it.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_twin_pricing',
    description:
      'Returns the current pricing for querying this twin: price per query, free tier limit, and currency. ' +
      'No authentication required.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── Tool name → handler map (populated by server.js) ────────────────────────

export const TOOL_NAMES = TOOL_DEFINITIONS.map(t => t.name);
