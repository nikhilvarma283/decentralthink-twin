/**
 * Draft Review Queue
 *
 * All AI-generated emails pass through here before the owner can act on them.
 * The twin NEVER sends email autonomously — this is a hard invariant.
 *
 * Draft lifecycle:
 *   pending_review → approved | rejected | edited
 *   approved       → ready to copy-paste or send via provider API
 *
 * Drafts are stored encrypted in Core Sovereign Vault.
 * Each draft carries a provenance record (which RAG sources influenced it).
 */

import { v4 as uuidv4 } from 'uuid';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const DRAFT_KEY      = (twinId, draftId) => `twin/drafts/${twinId}/${draftId}`;
const DRAFT_LIST_KEY = (twinId) => `twin/drafts/${twinId}/_index`;

// ─── Create draft ─────────────────────────────────────────────────────────────

/**
 * Store a generated email draft in the review queue.
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken
 * @param {string}   opts.twinId
 * @param {object}   opts.draft         - { to, subject, body, source, threadId?, ragUsed }
 * @param {object}   [opts.metadata]    - Extra context (event info, meeting notes ref, etc.)
 * @returns {{ draftId, draft }}
 */
export async function createDraft({ sessionToken, twinId, draft, metadata = {} }) {
  const draftId = `draft_${uuidv4().slice(0, 12)}`;
  const record = {
    draftId,
    twinId,
    status:      'pending_review',
    to:          draft.to,
    subject:     draft.subject,
    body:        draft.body,
    source:      draft.source || 'unknown',
    threadId:    draft.threadId || null,
    ragUsed:     draft.ragUsed || false,
    generatedAt: draft.generatedAt || new Date().toISOString(),
    createdAt:   new Date().toISOString(),
    metadata,
  };

  await core.vaultStore({
    sessionToken,
    key:        DRAFT_KEY(twinId, draftId),
    ciphertext: Buffer.from(JSON.stringify(record)).toString('base64'),
    metadata:   { type: 'email_draft', twinId, draftId, status: 'pending_review' },
  });

  // Update index
  await updateDraftIndex({ sessionToken, twinId, draftId, op: 'add' });

  await core.auditLog({
    sessionToken,
    action:  'twin.email_draft.created',
    payload: { twinId, draftId, source: draft.source, ragUsed: draft.ragUsed },
  });

  logger.info({ twinId, draftId, source: draft.source }, 'Email draft created');
  return { draftId, draft: record };
}

// ─── List drafts ──────────────────────────────────────────────────────────────

/**
 * Get all drafts in the review queue.
 * Optionally filter by status.
 */
export async function listDrafts({ sessionToken, twinId, status = null }) {
  const index = await getDraftIndex({ sessionToken, twinId });

  const drafts = await Promise.all(
    index.map(draftId => getDraft({ sessionToken, twinId, draftId }).catch(() => null))
  );

  const valid = drafts.filter(Boolean);
  return status ? valid.filter(d => d.status === status) : valid;
}

// ─── Get single draft ─────────────────────────────────────────────────────────

export async function getDraft({ sessionToken, twinId, draftId }) {
  const { ciphertext } = await core.vaultRead({ sessionToken, key: DRAFT_KEY(twinId, draftId) });
  return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
}

// ─── Approve draft ────────────────────────────────────────────────────────────

/**
 * Approve a draft. Marks it ready — owner copy-pastes or triggers send via provider.
 * Optionally allow edits to the body before approving.
 */
export async function approveDraft({ sessionToken, twinId, draftId, editedBody = null }) {
  const draft = await getDraft({ sessionToken, twinId, draftId });

  const updated = {
    ...draft,
    status:     'approved',
    body:       editedBody || draft.body,
    approvedAt: new Date().toISOString(),
    wasEdited:  editedBody !== null && editedBody !== draft.body,
  };

  await core.vaultStore({
    sessionToken,
    key:        DRAFT_KEY(twinId, draftId),
    ciphertext: Buffer.from(JSON.stringify(updated)).toString('base64'),
    metadata:   { type: 'email_draft', twinId, draftId, status: 'approved' },
  });

  await core.auditLog({
    sessionToken,
    action:  'twin.email_draft.approved',
    payload: { twinId, draftId, wasEdited: updated.wasEdited },
  });

  logger.info({ twinId, draftId, wasEdited: updated.wasEdited }, 'Draft approved');
  return updated;
}

// ─── Reject draft ─────────────────────────────────────────────────────────────

export async function rejectDraft({ sessionToken, twinId, draftId, reason = '' }) {
  const draft = await getDraft({ sessionToken, twinId, draftId });

  const updated = {
    ...draft,
    status:     'rejected',
    rejectedAt: new Date().toISOString(),
    rejectReason: reason,
  };

  await core.vaultStore({
    sessionToken,
    key:        DRAFT_KEY(twinId, draftId),
    ciphertext: Buffer.from(JSON.stringify(updated)).toString('base64'),
    metadata:   { type: 'email_draft', twinId, draftId, status: 'rejected' },
  });

  await core.auditLog({
    sessionToken,
    action:  'twin.email_draft.rejected',
    payload: { twinId, draftId, reason },
  });

  logger.info({ twinId, draftId }, 'Draft rejected');
  return updated;
}

// ─── Delete draft ─────────────────────────────────────────────────────────────

export async function deleteDraft({ sessionToken, twinId, draftId }) {
  await core.vaultDelete({ sessionToken, key: DRAFT_KEY(twinId, draftId) });
  await updateDraftIndex({ sessionToken, twinId, draftId, op: 'remove' });
  logger.info({ twinId, draftId }, 'Draft deleted');
  return { deleted: true };
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function getDraftIndex({ sessionToken, twinId }) {
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: DRAFT_LIST_KEY(twinId) });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch {
    return [];
  }
}

async function updateDraftIndex({ sessionToken, twinId, draftId, op }) {
  const index = await getDraftIndex({ sessionToken, twinId });
  const updated = op === 'add'
    ? [...new Set([...index, draftId])]
    : index.filter(id => id !== draftId);

  await core.vaultStore({
    sessionToken,
    key:        DRAFT_LIST_KEY(twinId),
    ciphertext: Buffer.from(JSON.stringify(updated)).toString('base64'),
    metadata:   { type: 'draft_index', twinId },
  });
}
