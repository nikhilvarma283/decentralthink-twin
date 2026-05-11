/**
 * Unified Ingest API
 *
 * Accepts ANY content type — files, URLs, YouTube links, profiles, etc.
 * Routes to the correct extractor, then through the provenance pipeline.
 *
 * POST /api/v1/ingest/file    — file upload (multipart)
 * POST /api/v1/ingest/url     — URL or YouTube link
 * POST /api/v1/ingest/text    — raw text / bio paste
 * POST /api/v1/ingest/batch   — multiple URLs at once
 * GET  /api/v1/ingest/status/:jobId — async job status
 */

import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { extract, detectType } from '../../knowledge/extractors/index.js';
import { ingestDocument } from '../../knowledge/ingest.js';
import { validateContent } from '../../knowledge/validation/antiEnhancement.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// Accept all file types — extractor handles validation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB (for video files)
});

// In-memory job tracker (replace with Redis for production)
const jobs = new Map();

// ─── POST /api/v1/ingest/file ─────────────────────────────────────────────────

router.post('/file', upload.single('file'), async (req, res) => {
  try {
    const { category, ownerUserId } = req.body;
    const sessionToken   = req.headers['x-session-token'];
    const walletAddress  = req.headers['x-wallet-address'];

    if (!req.file)                    return res.status(400).json({ error: 'No file uploaded' });
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });

    const source = {
      buffer:     req.file.buffer,
      filename:   req.file.originalname,
      mimeType:   req.file.mimetype,
      category:   category || 'general',
      ownerUserId,
    };

    // For large files (video/audio) run async
    if (req.file.size > 10 * 1024 * 1024) {
      const jobId = uuidv4();
      jobs.set(jobId, { status: 'processing', startedAt: new Date().toISOString() });
      processAsync(jobId, source, sessionToken, walletAddress);
      return res.status(202).json({ jobId, status: 'processing', message: 'Large file queued for processing' });
    }

    const result = await processSource(source, sessionToken, walletAddress);
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, 'File ingest failed');
    const status = err.code === 'ANTI_ENHANCEMENT_BLOCKED' ? 422 : 500;
    res.status(status).json({ error: err.message, code: err.code, flags: err.flags });
  }
});

// ─── POST /api/v1/ingest/url ──────────────────────────────────────────────────

router.post('/url', async (req, res) => {
  try {
    const { url, category } = req.body;
    const sessionToken  = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];

    if (!url)                            return res.status(400).json({ error: 'url required' });
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });

    // Detect type upfront so we can queue YouTube/long videos async
    const type = detectType({ url });

    if (type === 'youtube') {
      const jobId = uuidv4();
      jobs.set(jobId, { status: 'processing', startedAt: new Date().toISOString(), url });
      processAsync(jobId, { url, category: category || 'transcripts' }, sessionToken, walletAddress);
      return res.status(202).json({ jobId, status: 'processing', message: 'YouTube video queued for transcription', url });
    }

    const source = { url, category: category || 'articles' };
    const result = await processSource(source, sessionToken, walletAddress);
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, 'URL ingest failed');
    const status = err.code === 'ANTI_ENHANCEMENT_BLOCKED' ? 422 : 500;
    res.status(status).json({ error: err.message, code: err.code, flags: err.flags });
  }
});

// ─── POST /api/v1/ingest/text ─────────────────────────────────────────────────

router.post('/text', async (req, res) => {
  try {
    const { text, title, category } = req.body;
    const sessionToken  = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];

    if (!text)                           return res.status(400).json({ error: 'text required' });
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });
    if (text.length < 50)                return res.status(400).json({ error: 'text too short (min 50 chars)' });

    const source = {
      rawText:  text,
      filename: title ? `${title}.txt` : `text_${Date.now()}.txt`,
      mimeType: 'text/plain',
      category: category || 'notes',
    };
    const result = await processSource(source, sessionToken, walletAddress);
    res.status(201).json(result);
  } catch (err) {
    logger.error({ err }, 'Text ingest failed');
    const status = err.code === 'ANTI_ENHANCEMENT_BLOCKED' ? 422 : 500;
    res.status(status).json({ error: err.message, code: err.code, flags: err.flags });
  }
});

// ─── POST /api/v1/ingest/batch ────────────────────────────────────────────────

router.post('/batch', async (req, res) => {
  try {
    const { urls, category } = req.body;
    const sessionToken  = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];

    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' });
    if (urls.length > 20)                      return res.status(400).json({ error: 'max 20 URLs per batch' });
    if (!sessionToken || !walletAddress)       return res.status(401).json({ error: 'Missing auth headers' });

    const jobId = uuidv4();
    jobs.set(jobId, { status: 'processing', total: urls.length, done: 0, results: [] });

    // Process all URLs concurrently (with a concurrency limit)
    processBatchAsync(jobId, urls, category || 'articles', sessionToken, walletAddress);

    res.status(202).json({ jobId, total: urls.length, status: 'processing' });
  } catch (err) {
    logger.error({ err }, 'Batch ingest failed');
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/v1/ingest/status/:jobId ────────────────────────────────────────

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Shared processing helpers ────────────────────────────────────────────────

async function processSource(source, sessionToken, walletAddress) {
  // Step 1: Extract text from the source
  const extracted = await extract(source);

  if (!extracted.text || extracted.text.length < 30) {
    throw new Error('Extracted content is too short or empty');
  }

  // Step 2: Anti-enhancement validation
  const validation = await validateContent({
    text:        extracted.text,
    category:    source.category || 'general',
    filename:    source.filename || source.url || 'unknown',
    contentType: extracted.contentType,
  });

  if (validation.blocked) {
    const err = new Error(
      'Content blocked by anti-enhancement validator: high AI-generation signal with no personal signal detected. ' +
      'Upload your own writing, not AI-generated content.'
    );
    err.code    = 'ANTI_ENHANCEMENT_BLOCKED';
    err.flags   = validation.flags;
    throw err;
  }

  // Step 3: Ingest into the provenance pipeline
  const result = await ingestDocument({
    sessionToken,
    walletAddress,
    content:  Buffer.from(extracted.text, 'utf-8'),
    filename: source.filename || source.url || `content_${Date.now()}`,
    mimeType: 'text/plain',
    category: source.category || 'general',
    sourceMetadata: extracted.metadata,
    contentType: extracted.contentType,
  });

  return {
    success: true,
    documentId:  result.documentId,
    hash:        result.hash,
    txId:        result.txId,
    chunkCount:  result.chunkCount,
    contentType: extracted.contentType,
    extractedLength: extracted.text.length,
    sourceMetadata: extracted.metadata,
    // Surface any anti-enhancement warnings so the owner can see them
    validationWarnings: validation.warnings.length ? validation.warnings : undefined,
    validationFlags:    Object.keys(validation.flags).length ? validation.flags : undefined,
  };
}

async function processAsync(jobId, source, sessionToken, walletAddress) {
  try {
    const result = await processSource(source, sessionToken, walletAddress);
    jobs.set(jobId, { status: 'done', ...result, completedAt: new Date().toISOString() });
  } catch (err) {
    jobs.set(jobId, { status: 'failed', error: err.message, failedAt: new Date().toISOString() });
    logger.error({ jobId, err }, 'Async ingest job failed');
  }
}

async function processBatchAsync(jobId, urls, category, sessionToken, walletAddress) {
  const CONCURRENCY = 3;
  const results = [];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(url => processSource({ url, category }, sessionToken, walletAddress))
    );
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? { ok: true, ...s.value } : { ok: false, error: s.reason?.message });
    }
    const job = jobs.get(jobId);
    jobs.set(jobId, { ...job, done: results.length, results });
  }

  jobs.set(jobId, { status: 'done', total: urls.length, done: results.length, results, completedAt: new Date().toISOString() });
}

export default router;
