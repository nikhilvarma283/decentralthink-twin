import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { logger } from './lib/logger.js';
import documentsRouter from './api/v1/documents.js';
import queryRouter from './api/v1/query.js';
import styleRouter from './api/v1/style.js';
import ingestRouter from './api/v1/ingest.js';
import onboardingRouter from './api/v1/onboarding.js';
import billingRouter from './api/v1/billing.js';
import mcpRouter from './api/v1/mcp.js';

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = { api: 'ok' };

  // Check Qdrant
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const q = new QdrantClient({ url: process.env.QDRANT_URL || 'http://qdrant:6333' });
    await q.getCollections();
    checks.qdrant = 'ok';
  } catch {
    checks.qdrant = 'unreachable';
  }

  // Check Core
  try {
    const axios = (await import('axios')).default;
    await axios.get(`${process.env.CORE_API_URL || 'https://core.decentralthink.com'}/health`, { timeout: 3000 });
    checks.core = 'ok';
  } catch {
    checks.core = 'unreachable';
  }

  // Check Ollama
  try {
    const axios = (await import('axios')).default;
    await axios.get(`${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/tags`, { timeout: 3000 });
    checks.ollama = 'ok';
  } catch {
    checks.ollama = 'unreachable';
  }

  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 207).json({
    status: allOk ? 'ok' : 'degraded',
    version: '0.1.0',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/v1/documents',  documentsRouter);
app.use('/api/v1/query',      queryRouter);
app.use('/api/v1/style',      styleRouter);
app.use('/api/v1/ingest',     ingestRouter);
app.use('/api/v1/onboarding', onboardingRouter);
app.use('/api/v1/billing',    billingRouter);
app.use('/api/v1/mcp',        mcpRouter);

// ─── MCP well-known discovery (standard path for MCP clients) ─────────────────
// Agents can check https://twin.decentralthink.com/.well-known/mcp to get
// the list of available twins.
app.get('/.well-known/mcp', (req, res) => {
  res.json({
    registry:  `${req.protocol}://${req.get('host')}/api/v1/mcp/registry`,
    protocol:  'MCP 2025-03-26',
    transport: 'http+sse',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'DecentralThink Twin API started');
  logger.info({ coreUrl: process.env.CORE_API_URL }, 'Connected to DecentralThink Core');
  logger.info({ mcpRegistry: `http://localhost:${PORT}/api/v1/mcp/registry` }, 'MCP agent interface active');
});

export default app;
