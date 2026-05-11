/**
 * Knowledge Ingestion Pipeline
 *
 * Flow:
 *   Upload → Hash (SHA-256) → Sign (wallet) → Encrypt → Vault (Core)
 *            → Audit log (Core/Algorand) → Chunk → Embed → Qdrant
 *
 * Every document is cryptographically tied to the owner's wallet.
 * The provenance chain is immutable on Algorand.
 */

import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../lib/logger.js';
import core from '../core/client.js';

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || 'http://qdrant:6333' });

const COLLECTION_PREFIX = 'twin_kb_';     // one collection per twin owner
const EMBEDDING_DIM = 768;               // nomic-embed-text dimension

// ─── Collection bootstrap ────────────────────────────────────────────────────

export async function ensureCollection(walletAddress) {
  const name = collectionName(walletAddress);
  try {
    await qdrant.getCollection(name);
  } catch {
    await qdrant.createCollection(name, {
      vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
    });
    logger.info({ collection: name }, 'Qdrant collection created');
  }
  return name;
}

function collectionName(walletAddress) {
  // deterministic, safe collection name from wallet
  return COLLECTION_PREFIX + walletAddress.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

// ─── Main ingestion entry point ───────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.sessionToken   - Core session token
 * @param {string} opts.walletAddress  - Owner's wallet (signs the provenance)
 * @param {Buffer} opts.content        - Raw document bytes
 * @param {string} opts.filename       - Original filename
 * @param {string} opts.category       - emails | articles | presentations | transcripts | notes | annotated_references
 * @param {string} opts.mimeType       - text/plain | application/pdf | etc.
 * @returns {object}                   - { documentId, txId, chunkCount }
 */
export async function ingestDocument({ sessionToken, walletAddress, content, filename, category, mimeType }) {
  const documentId = uuidv4();

  // Step 1 — Hash the raw content
  const hash = sha256(content);
  logger.info({ documentId, hash, filename }, 'Document hash computed');

  // Step 2 — Log provenance to Algorand via Core audit chain
  // This is the immutable proof: "wallet X uploaded document Y at time T"
  const { txId, timestamp } = await core.auditLog({
    sessionToken,
    action: 'twin.document.upload',
    payload: {
      documentId,
      documentHash: hash,
      walletAddress,
      filename,
      category,
      mimeType,
      sizeBytes: content.length,
    },
  });
  logger.info({ documentId, txId }, 'Provenance logged to Algorand');

  // Step 3 — Encrypt and store in Core's Sovereign Vault
  // In production the client encrypts before sending (HKDF from wallet sig).
  // Here we pass the plaintext and let Core handle blind storage.
  await core.vaultStore({
    sessionToken,
    key: `twin/documents/${documentId}`,
    ciphertext: content.toString('base64'), // Core encrypts this with vault key
    metadata: { documentId, hash, filename, category, txId, timestamp },
  });

  // Step 4 — Chunk the document
  const chunks = chunkDocument(content.toString('utf-8'), { filename, category });
  logger.info({ documentId, chunkCount: chunks.length }, 'Document chunked');

  // Step 5 — Embed each chunk and upsert into Qdrant
  const collection = await ensureCollection(walletAddress);
  const points = [];

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i].text);
    points.push({
      id: uuidv4(),
      vector: embedding,
      payload: {
        documentId,
        walletAddress,
        chunkIndex: i,
        text: chunks[i].text,
        filename,
        category,
        hash,
        txId,
        timestamp,
      },
    });
  }

  await qdrant.upsert(collection, { points });
  logger.info({ documentId, chunkCount: points.length }, 'Embeddings stored in Qdrant');

  return { documentId, txId, chunkCount: points.length, hash };
}

// ─── Document removal (right to forget) ──────────────────────────────────────

export async function removeDocument({ sessionToken, walletAddress, documentId }) {
  const collection = collectionName(walletAddress);

  // Delete all chunks for this document from Qdrant
  await qdrant.delete(collection, {
    filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
  });

  // Delete from Vault
  await core.vaultDelete({ sessionToken, key: `twin/documents/${documentId}` });

  // Log removal to audit chain
  const { txId } = await core.auditLog({
    sessionToken,
    action: 'twin.document.remove',
    payload: { documentId, walletAddress },
  });

  logger.info({ documentId, txId }, 'Document removed (right to forget exercised)');
  return { documentId, txId };
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Search the knowledge base for relevant context.
 * Returns results with relevance scores for boundary enforcement.
 */
export async function retrieve({ walletAddress, query, limit = 5 }) {
  const collection = collectionName(walletAddress);
  const queryVector = await embed(query);

  const results = await qdrant.search(collection, {
    vector: queryVector,
    limit,
    with_payload: true,
    score_threshold: parseFloat(process.env.BOUNDARY_WEAK || '0.40'),
  });

  return results.map(r => ({
    text: r.payload.text,
    score: r.score,
    documentId: r.payload.documentId,
    category: r.payload.category,
    filename: r.payload.filename,
  }));
}

// ─── Domain ontology generation ───────────────────────────────────────────────

/**
 * Analyse all embeddings in the collection to auto-derive the domain map.
 * Returns a hierarchical JSON that the owner reviews during onboarding.
 */
export async function generateDomainOntology({ walletAddress }) {
  const collection = collectionName(walletAddress);

  // Scroll all payloads (no vector needed, just text + category)
  const { points } = await qdrant.scroll(collection, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  });

  if (!points.length) return { domains: [] };

  // Group by category
  const byCategory = {};
  for (const p of points) {
    const cat = p.payload.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p.payload.text);
  }

  // Use Ollama to derive domain summary from each category corpus
  const domains = [];
  for (const [category, texts] of Object.entries(byCategory)) {
    const sample = texts.slice(0, 10).join('\n\n').slice(0, 3000);
    const summary = await inferDomains(sample, category);
    domains.push({ category, ...summary });
  }

  return { domains, generatedAt: new Date().toISOString() };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function chunkDocument(text, { category } = {}) {
  // Target ~512 tokens (~400 words) per chunk with 50-word overlap
  const words = text.split(/\s+/);
  const chunkSize = 400;
  const overlap = 50;
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const slice = words.slice(i, i + chunkSize).join(' ');
    if (slice.trim().length > 50) {
      chunks.push({ text: slice, startWord: i });
    }
  }

  return chunks.length ? chunks : [{ text: text.slice(0, 2000), startWord: 0 }];
}

async function embed(text) {
  const { data } = await axios.post(
    `${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/embeddings`,
    { model: process.env.EMBEDDING_MODEL || 'nomic-embed-text', prompt: text }
  );
  return data.embedding;
}

async function inferDomains(text, category) {
  try {
    const { data } = await axios.post(
      `${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/generate`,
      {
        model: process.env.INFERENCE_MODEL || 'nous-hermes2',
        prompt: `Analyse this text and identify the top 3-5 knowledge domains it covers. Return JSON only: {"primary": "domain name", "sub_domains": ["...", "..."], "confidence": 0.0-1.0}\n\nText (category: ${category}):\n${text}`,
        stream: false,
        format: 'json',
      }
    );
    return JSON.parse(data.response);
  } catch {
    return { primary: category, sub_domains: [], confidence: 0.5 };
  }
}
