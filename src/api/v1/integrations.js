/**
 * Integrations API — v1
 *
 * Gmail, Outlook, and Calendar endpoints.
 * All routes require X-Session-Token + X-Twin-Id headers.
 *
 * ── OAuth ──────────────────────────────────────────────────────────────
 * GET  /api/v1/integrations/status                    — which providers are connected
 * GET  /api/v1/integrations/gmail/auth                — start Gmail OAuth flow
 * GET  /api/v1/integrations/gmail/callback            — OAuth callback (redirect from Google)
 * DELETE /api/v1/integrations/gmail                   — disconnect Gmail
 * GET  /api/v1/integrations/outlook/auth              — start Outlook OAuth flow
 * GET  /api/v1/integrations/outlook/callback          — OAuth callback (redirect from Microsoft)
 * DELETE /api/v1/integrations/outlook                 — disconnect Outlook
 *
 * ── Email ──────────────────────────────────────────────────────────────
 * GET  /api/v1/integrations/gmail/inbox               — read inbox
 * GET  /api/v1/integrations/gmail/thread/:threadId    — full thread
 * POST /api/v1/integrations/gmail/draft/reply         — draft a reply
 * POST /api/v1/integrations/gmail/draft/new           — draft a new email
 * GET  /api/v1/integrations/outlook/inbox
 * GET  /api/v1/integrations/outlook/thread/:threadId
 * POST /api/v1/integrations/outlook/draft/reply
 * POST /api/v1/integrations/outlook/draft/new
 *
 * ── Calendar ───────────────────────────────────────────────────────────
 * GET  /api/v1/integrations/calendar/events           — upcoming events (gmail or outlook)
 * GET  /api/v1/integrations/calendar/availability     — free/busy check
 * POST /api/v1/integrations/calendar/briefing         — pre-meeting briefing
 * POST /api/v1/integrations/calendar/followup         — post-meeting follow-up drafts
 *
 * ── Draft review queue ─────────────────────────────────────────────────
 * GET  /api/v1/integrations/drafts                    — list all drafts
 * GET  /api/v1/integrations/drafts/:draftId           — single draft
 * POST /api/v1/integrations/drafts/:draftId/approve   — approve (with optional edit)
 * POST /api/v1/integrations/drafts/:draftId/reject    — reject
 * DELETE /api/v1/integrations/drafts/:draftId         — delete
 */

import express from 'express';
import { buildAuthUrl, exchangeCode, disconnect, getIntegrationStatus } from '../../integrations/oauth.js';
import * as gmail   from '../../integrations/gmail.js';
import * as outlook from '../../integrations/outlook.js';
import { createDraft, listDrafts, getDraft, approveDraft, rejectDraft, deleteDraft } from '../../integrations/drafts.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireSession(req, res, next) {
  const sessionToken = req.headers['x-session-token'];
  const twinId       = req.headers['x-twin-id'] || req.query.twinId;
  const twinOwner    = req.headers['x-wallet-address'];

  if (!sessionToken) return res.status(401).json({ error: 'Missing X-Session-Token' });
  if (!twinId)       return res.status(400).json({ error: 'Missing X-Twin-Id header' });

  req.sessionToken = sessionToken;
  req.twinId       = twinId;
  req.twinOwner    = twinOwner;
  next();
}

router.use(requireSession);

// ─── GET /status ──────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const status = await getIntegrationStatus({ sessionToken: req.sessionToken, twinId: req.twinId });
    res.json({ twinId: req.twinId, integrations: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OAuth — Gmail ────────────────────────────────────────────────────────────

router.get('/gmail/auth', async (req, res) => {
  try {
    const { authUrl, state } = await buildAuthUrl({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      provider:     'google',
    });
    res.json({ authUrl, state, message: 'Redirect the user to authUrl to complete Gmail authorization.' });
  } catch (err) {
    logger.error({ err }, 'Gmail auth URL failed');
    const status = err.message.includes('not set') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/gmail/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) return res.status(400).json({ error: `Google OAuth error: ${error}` });
    if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

    const result = await exchangeCode({ sessionToken: req.sessionToken, code, state, provider: 'google' });

    // In production: redirect to frontend with success indicator
    res.json({ connected: true, provider: 'google', email: result.email, twinId: result.twinId });
  } catch (err) {
    logger.error({ err }, 'Gmail OAuth callback failed');
    res.status(400).json({ error: err.message });
  }
});

router.delete('/gmail', async (req, res) => {
  try {
    const result = await disconnect({ sessionToken: req.sessionToken, twinId: req.twinId, provider: 'google' });
    res.json({ ...result, provider: 'google' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OAuth — Outlook ──────────────────────────────────────────────────────────

router.get('/outlook/auth', async (req, res) => {
  try {
    const { authUrl, state } = await buildAuthUrl({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      provider:     'microsoft',
    });
    res.json({ authUrl, state, message: 'Redirect the user to authUrl to complete Outlook authorization.' });
  } catch (err) {
    const status = err.message.includes('not set') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/outlook/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).json({ error: `Microsoft OAuth error: ${error}` });
    if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

    const result = await exchangeCode({ sessionToken: req.sessionToken, code, state, provider: 'microsoft' });
    res.json({ connected: true, provider: 'microsoft', email: result.email, twinId: result.twinId });
  } catch (err) {
    logger.error({ err }, 'Outlook OAuth callback failed');
    res.status(400).json({ error: err.message });
  }
});

router.delete('/outlook', async (req, res) => {
  try {
    const result = await disconnect({ sessionToken: req.sessionToken, twinId: req.twinId, provider: 'microsoft' });
    res.json({ ...result, provider: 'microsoft' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail — Inbox + Threads ──────────────────────────────────────────────────

router.get('/gmail/inbox', async (req, res) => {
  try {
    const { maxResults = 20, unreadOnly = false, q } = req.query;
    const messages = await gmail.getInbox({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      maxResults:   parseInt(maxResults),
      unreadOnly:   unreadOnly === 'true',
      query:        q,
    });
    res.json({ messages, count: messages.length });
  } catch (err) {
    handleIntegrationError(res, err, 'gmail');
  }
});

router.get('/gmail/thread/:threadId', async (req, res) => {
  try {
    const thread = await gmail.getThread({ sessionToken: req.sessionToken, twinId: req.twinId, threadId: req.params.threadId });
    res.json(thread);
  } catch (err) {
    handleIntegrationError(res, err, 'gmail');
  }
});

// ─── Gmail — Draft generation ─────────────────────────────────────────────────

/**
 * POST /api/v1/integrations/gmail/draft/reply
 * Body: { threadId, instructions? }
 * Drafts a reply and adds it to the review queue.
 */
router.post('/gmail/draft/reply', async (req, res) => {
  try {
    const { threadId, instructions } = req.body;
    if (!threadId)      return res.status(400).json({ error: 'threadId required' });
    if (!req.twinOwner) return res.status(400).json({ error: 'X-Wallet-Address header required' });

    const draft = await gmail.draftReply({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      twinOwner:    req.twinOwner,
      threadId,
      instructions,
    });

    const { draftId, draft: stored } = await createDraft({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      draft,
    });

    res.status(201).json({
      draftId,
      draft: stored,
      message: 'Draft created. Review at GET /api/v1/integrations/drafts and approve before sending.',
    });
  } catch (err) {
    handleIntegrationError(res, err, 'gmail');
  }
});

/**
 * POST /api/v1/integrations/gmail/draft/new
 * Body: { to, subject, brief, instructions? }
 */
router.post('/gmail/draft/new', async (req, res) => {
  try {
    const { to, subject, brief, instructions } = req.body;
    if (!to || !subject || !brief) return res.status(400).json({ error: 'to, subject, and brief are required' });
    if (!req.twinOwner)            return res.status(400).json({ error: 'X-Wallet-Address header required' });

    const draft = await gmail.draftNewEmail({
      sessionToken: req.sessionToken, twinId: req.twinId, twinOwner: req.twinOwner, to, subject, brief, instructions,
    });

    const { draftId, draft: stored } = await createDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draft });
    res.status(201).json({ draftId, draft: stored });
  } catch (err) {
    handleIntegrationError(res, err, 'gmail');
  }
});

// ─── Outlook — Inbox + Threads ────────────────────────────────────────────────

router.get('/outlook/inbox', async (req, res) => {
  try {
    const { maxResults = 20, unreadOnly = false, q } = req.query;
    const messages = await outlook.getInbox({
      sessionToken: req.sessionToken, twinId: req.twinId,
      maxResults: parseInt(maxResults), unreadOnly: unreadOnly === 'true', query: q,
    });
    res.json({ messages, count: messages.length });
  } catch (err) {
    handleIntegrationError(res, err, 'outlook');
  }
});

router.get('/outlook/thread/:threadId', async (req, res) => {
  try {
    const thread = await outlook.getThread({ sessionToken: req.sessionToken, twinId: req.twinId, threadId: req.params.threadId });
    res.json(thread);
  } catch (err) {
    handleIntegrationError(res, err, 'outlook');
  }
});

router.post('/outlook/draft/reply', async (req, res) => {
  try {
    const { threadId, instructions } = req.body;
    if (!threadId)      return res.status(400).json({ error: 'threadId required' });
    if (!req.twinOwner) return res.status(400).json({ error: 'X-Wallet-Address required' });

    const draft = await outlook.draftReply({
      sessionToken: req.sessionToken, twinId: req.twinId, twinOwner: req.twinOwner, threadId, instructions,
    });
    const { draftId, draft: stored } = await createDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draft });
    res.status(201).json({ draftId, draft: stored });
  } catch (err) {
    handleIntegrationError(res, err, 'outlook');
  }
});

router.post('/outlook/draft/new', async (req, res) => {
  try {
    const { to, subject, brief, instructions } = req.body;
    if (!to || !subject || !brief) return res.status(400).json({ error: 'to, subject, brief required' });
    if (!req.twinOwner)            return res.status(400).json({ error: 'X-Wallet-Address required' });

    const draft = await outlook.draftNewEmail({
      sessionToken: req.sessionToken, twinId: req.twinId, twinOwner: req.twinOwner, to, subject, brief, instructions,
    });
    const { draftId, draft: stored } = await createDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draft });
    res.status(201).json({ draftId, draft: stored });
  } catch (err) {
    handleIntegrationError(res, err, 'outlook');
  }
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/integrations/calendar/events?provider=google|microsoft&days=7
 */
router.get('/calendar/events', async (req, res) => {
  try {
    const { provider = 'google', days = 7, maxResults = 20 } = req.query;
    const fn = provider === 'microsoft' ? outlook.getUpcomingEvents : gmail.getUpcomingEvents;
    const events = await fn({ sessionToken: req.sessionToken, twinId: req.twinId, days: parseInt(days), maxResults: parseInt(maxResults) });
    res.json({ events, count: events.length, provider });
  } catch (err) {
    handleIntegrationError(res, err, req.query.provider || 'google');
  }
});

/**
 * GET /api/v1/integrations/calendar/availability?provider=google|microsoft&start=ISO&end=ISO
 */
router.get('/calendar/availability', async (req, res) => {
  try {
    const { provider = 'google', start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end (ISO timestamps) required' });

    const fn = provider === 'microsoft' ? outlook.checkAvailability : gmail.checkAvailability;
    const result = await fn({ sessionToken: req.sessionToken, twinId: req.twinId, timeMin: start, timeMax: end });
    res.json(result);
  } catch (err) {
    handleIntegrationError(res, err, req.query.provider || 'google');
  }
});

/**
 * POST /api/v1/integrations/calendar/briefing
 * Body: { eventId, provider? }
 * Generates a pre-meeting briefing using RAG over the owner's knowledge base.
 */
router.post('/calendar/briefing', async (req, res) => {
  try {
    const { eventId, provider = 'google' } = req.body;
    if (!eventId)       return res.status(400).json({ error: 'eventId required' });
    if (!req.twinOwner) return res.status(400).json({ error: 'X-Wallet-Address required' });

    const fn = provider === 'microsoft' ? outlook.generateMeetingBriefing : gmail.generateMeetingBriefing;
    const result = await fn({
      sessionToken: req.sessionToken, twinId: req.twinId, twinOwner: req.twinOwner, eventId,
    });

    res.json(result);
  } catch (err) {
    handleIntegrationError(res, err, req.body.provider || 'google');
  }
});

/**
 * POST /api/v1/integrations/calendar/followup
 * Body: { meetingNotes, attendees[], subject, provider? }
 * Drafts follow-up emails, adds to review queue.
 */
router.post('/calendar/followup', async (req, res) => {
  try {
    const { meetingNotes, attendees = [], subject, provider = 'google' } = req.body;
    if (!meetingNotes)  return res.status(400).json({ error: 'meetingNotes required' });
    if (!req.twinOwner) return res.status(400).json({ error: 'X-Wallet-Address required' });

    const fn = provider === 'microsoft' ? outlook.draftFollowUpEmails : gmail.draftFollowUpEmails;
    const drafts = await fn({
      sessionToken: req.sessionToken, twinId: req.twinId, twinOwner: req.twinOwner,
      meetingNotes, attendees, subject,
    });

    // Add all to the review queue
    const stored = await Promise.all(
      drafts.map(d => createDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draft: d, metadata: { source: 'calendar_followup' } }))
    );

    res.status(201).json({
      draftsCreated: stored.length,
      drafts: stored.map(s => ({ draftId: s.draftId, to: s.draft.to, subject: s.draft.subject })),
      message: 'Follow-up drafts created. Review at GET /api/v1/integrations/drafts',
    });
  } catch (err) {
    handleIntegrationError(res, err, req.body.provider || 'google');
  }
});

// ─── Draft review queue ───────────────────────────────────────────────────────

router.get('/drafts', async (req, res) => {
  try {
    const { status } = req.query;
    const drafts = await listDrafts({ sessionToken: req.sessionToken, twinId: req.twinId, status });
    res.json({ drafts, count: drafts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drafts/:draftId', async (req, res) => {
  try {
    const draft = await getDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draftId: req.params.draftId });
    res.json(draft);
  } catch (err) {
    res.status(404).json({ error: `Draft ${req.params.draftId} not found` });
  }
});

/**
 * POST /api/v1/integrations/drafts/:draftId/approve
 * Body: { editedBody? } — optionally edit the body before approving
 */
router.post('/drafts/:draftId/approve', async (req, res) => {
  try {
    const { editedBody } = req.body;
    const draft = await approveDraft({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      draftId:      req.params.draftId,
      editedBody:   editedBody || null,
    });
    res.json({ approved: true, draft, message: 'Draft approved. Copy the body to send via your email client.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/integrations/drafts/:draftId/reject
 * Body: { reason? }
 */
router.post('/drafts/:draftId/reject', async (req, res) => {
  try {
    const draft = await rejectDraft({
      sessionToken: req.sessionToken,
      twinId:       req.twinId,
      draftId:      req.params.draftId,
      reason:       req.body.reason,
    });
    res.json({ rejected: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/drafts/:draftId', async (req, res) => {
  try {
    await deleteDraft({ sessionToken: req.sessionToken, twinId: req.twinId, draftId: req.params.draftId });
    res.json({ deleted: true, draftId: req.params.draftId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Error helper ─────────────────────────────────────────────────────────────

function handleIntegrationError(res, err, provider) {
  logger.error({ err, provider }, 'Integration error');
  if (err.message?.includes('No google integration') || err.message?.includes('No microsoft integration')) {
    return res.status(400).json({
      error:   `${provider} not connected`,
      hint:    `Complete OAuth flow at GET /api/v1/integrations/${provider === 'microsoft' ? 'outlook' : provider}/auth`,
    });
  }
  if (err.message?.includes('OAuth state')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message });
}

export default router;
