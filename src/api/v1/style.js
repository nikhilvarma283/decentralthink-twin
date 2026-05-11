/**
 * Style Fingerprint API
 * POST /api/v1/style/extract  — extract fingerprint from communication samples
 * GET  /api/v1/style          — get current fingerprint
 * PUT  /api/v1/style          — update/adjust fingerprint manually
 */

import express from 'express';
import multer from 'multer';
import { extractFingerprint } from '../../style/fingerprint.js';
import core from '../../core/client.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /api/v1/style/extract
router.post('/extract', upload.array('samples', 20), async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];
    const { name } = req.body;

    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });
    if (!name) return res.status(400).json({ error: 'name required' });

    // Extract text from uploaded samples
    const samples = (req.files || []).map(f => f.buffer.toString('utf-8'));

    // Also accept inline text samples
    if (req.body.texts) {
      const texts = Array.isArray(req.body.texts) ? req.body.texts : [req.body.texts];
      samples.push(...texts);
    }

    if (!samples.length) return res.status(400).json({ error: 'No samples provided' });

    const fingerprint = await extractFingerprint(samples, name);

    // Store fingerprint in Core's Sovereign Vault (encrypted)
    await core.vaultStore({
      sessionToken,
      key: `twin/style/${walletAddress}`,
      ciphertext: Buffer.from(JSON.stringify(fingerprint)).toString('base64'),
      metadata: { type: 'style_fingerprint', walletAddress, extractedAt: new Date().toISOString() },
    });

    // Log to audit chain
    await core.auditLog({
      sessionToken,
      action: 'twin.style.extracted',
      payload: { walletAddress, sampleCount: samples.length },
    });

    res.json({ success: true, fingerprint });
  } catch (err) {
    logger.error({ err }, 'Style extraction failed');
    res.status(500).json({ error: 'Extraction failed', details: err.message });
  }
});

// GET /api/v1/style
router.get('/', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });

    const { ciphertext } = await core.vaultRead({
      sessionToken,
      key: `twin/style/${walletAddress}`,
    });

    const fingerprint = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
    res.json({ fingerprint });
  } catch (err) {
    res.status(404).json({ error: 'No style fingerprint found. Run /extract first.' });
  }
});

// PUT /api/v1/style — manual adjustments after review
router.put('/', async (req, res) => {
  try {
    const sessionToken = req.headers['x-session-token'];
    const walletAddress = req.headers['x-wallet-address'];
    const { fingerprint } = req.body;
    if (!sessionToken || !walletAddress) return res.status(401).json({ error: 'Missing auth headers' });
    if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' });

    await core.vaultStore({
      sessionToken,
      key: `twin/style/${walletAddress}`,
      ciphertext: Buffer.from(JSON.stringify(fingerprint)).toString('base64'),
      metadata: { type: 'style_fingerprint', walletAddress, updatedAt: new Date().toISOString() },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Style update failed');
    res.status(500).json({ error: 'Update failed' });
  }
});

export default router;
