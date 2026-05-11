import { logger } from '../../lib/logger.js';

/**
 * Chat export extractor — Slack and Microsoft Teams
 *
 * Extracts only the OWNER's messages. Other people's messages
 * are used for context but are clearly labelled so the style
 * fingerprint doesn't pick up other people's writing patterns.
 */
export async function extractChat(source, platform = 'slack') {
  if (!source.buffer) throw new Error('Chat extractor requires a file buffer');

  const raw = source.buffer.toString('utf-8');
  let data;
  try { data = JSON.parse(raw); } catch {
    return { text: raw, metadata: { format: platform, filename: source.filename }, contentType: 'chat' };
  }

  const ownerUserId = source.ownerUserId || null; // optional hint

  if (platform === 'slack') return extractSlack(data, ownerUserId, source.filename);
  if (platform === 'teams') return extractTeams(data, ownerUserId, source.filename);
  return { text: raw, metadata: { format: platform }, contentType: 'chat' };
}

// ─── Slack JSON export ────────────────────────────────────────────────────────

function extractSlack(data, ownerUserId, filename) {
  // Slack export is an array of message objects per channel
  const messages = Array.isArray(data) ? data : [];
  logger.info({ count: messages.length, filename }, 'Parsing Slack export');

  // Group: owner messages vs context
  const ownerMessages = [];
  const contextBlocks = [];
  let currentContext = [];

  for (const msg of messages) {
    if (!msg.text || msg.subtype === 'channel_join') continue;

    const isOwner = ownerUserId ? msg.user === ownerUserId : true;
    const text = stripSlackMarkup(msg.text);
    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().split('T')[0] : '';

    if (isOwner) {
      if (currentContext.length) {
        contextBlocks.push(currentContext.join('\n'));
        currentContext = [];
      }
      ownerMessages.push(`[${ts}] ${text}`);
    } else {
      currentContext.push(`> ${text}`);
    }
  }

  const text = ownerMessages.join('\n\n');
  return {
    text,
    metadata: { format: 'slack', filename, messageCount: ownerMessages.length },
    contentType: 'chat',
  };
}

// ─── Microsoft Teams export ───────────────────────────────────────────────────

function extractTeams(data, ownerUserId, filename) {
  // Teams export format: { messages: [...] } or array
  const messages = data.messages || data.value || (Array.isArray(data) ? data : []);

  const ownerMessages = messages
    .filter(m => {
      if (!m.body?.content) return false;
      if (ownerUserId) return m.from?.user?.id === ownerUserId;
      return true;
    })
    .map(m => {
      const text = m.body.content
        .replace(/<[^>]+>/g, '')    // strip HTML
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      const date = m.createdDateTime?.split('T')[0] || '';
      return `[${date}] ${text}`;
    })
    .filter(t => t.length > 10);

  return {
    text: ownerMessages.join('\n\n'),
    metadata: { format: 'teams', filename, messageCount: ownerMessages.length },
    contentType: 'chat',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripSlackMarkup(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, '@user')    // user mentions
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1') // channel mentions
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1') // links with labels
    .replace(/<https?:\/\/[^>]+>/g, '[link]')         // bare links
    .replace(/:[a-z_]+:/g, '')                         // emoji codes
    .replace(/\*([^*]+)\*/g, '$1')                    // bold
    .replace(/_([^_]+)_/g, '$1')                      // italic
    .trim();
}
