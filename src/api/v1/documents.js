/**
 * Document upload API
 * POST /api/v1/documents  — ingest a training document
 * GET  /api/v1/documents  — list provenance manifest
 * DELETE /api/v1/documents/:id — right to forget
 */

import express from 'express';
import multer from 'multer';
import { ingestDocument, removeDocument } from '../../knowledge/ingest.js';
import core from '../../core/client.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/plain', 'application/pdf', 'text/markdown',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype) || file.originalname.endsWith('.md'));
  },
});

const VALID_CATEGORIES = ['emails', 'articles', 'presentations', 'transcripts', 'notes', 'annotated_references'];

// POST /api/v1/documents
router.post('/', upload.single('document'), async (req, res) => {
  try {
    const { category } = req.body;
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];

    if (!req.file) return res.status(400).json({ error: 'No document uploaded' });
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }

    const result = await ingestDocument({
      sessionToken,
      walletAddress,
      content:   req.file.buffer,
      filename:  req.file.originalname,
      mimeType:  req.file.mimetype,
      category,
    });

    res.status(201).json({
      success: true,
      documentId: result.documentId,
      hash:       result.hash,
      txId:       result.txId,        // Algorand transaction — verifiable provenance
      chunkCount: result.chunkCount,
    });
  } catch (err) {
    logger.error({ err }, 'Document ingest failed');
    res.status(500).json({ error: 'Ingest failed', details: err.message });
  }
});

// GET /api/v1/documents — full provenance manifest from Algorand
router.get('/', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });

    const audit = await core.auditQuery({ sessionToken, walletAddress });
    const documents = audit.records?.filter(r => r.action === 'twin.document.upload') || [];

    res.json({ documents, total: documents.length });
  } catch (err) {
    logger.error({ err }, 'Provenance query failed');
    res.status(500).json({ error: 'Query failed' });
  }
});

// DELETE /api/v1/documents/:id — right to forget
router.delete('/:id', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });

    const result = await removeDocument({
      sessionToken,
      walletAddress,
      documentId: req.params.id,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'Document removal failed');
    res.status(500).json({ error: 'Removal failed' });
  }
});

export default router;
