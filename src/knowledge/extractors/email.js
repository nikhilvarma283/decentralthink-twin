import { logger } from '../../lib/logger.js';

/**
 * Email extractor
 *
 * Supports:
 *   - .eml files (single email)
 *   - .mbox files (Gmail/Outlook export — many emails)
 *   - Gmail Takeout (mbox format)
 *
 * IMPORTANT: Strips email addresses, phone numbers, and other PII
 * from third parties before storage — we only want the person's own writing.
 */
export async function extractEmail(source) {
  if (!source.buffer) throw new Error('Email extractor requires a file buffer');

  const raw = source.buffer.toString('utf-8');
  const filename = source.filename || '';

  // Route by format
  if (filename.endsWith('.mbox') || raw.startsWith('From ')) {
    return extractMbox(raw, filename);
  }

  return extractEml(raw, filename);
}

// ─── MBOX (multiple emails) ───────────────────────────────────────────────────

function extractMbox(raw, filename) {
  // Split on mbox message boundaries
  const messages = raw.split(/^From /m).filter(m => m.trim().length > 100);
  logger.info({ count: messages.length, filename }, 'Parsing mbox file');

  const texts = messages
    .slice(0, 500) // cap at 500 emails to avoid enormous corpora
    .map(msg => parseEmailText(`From ${msg}`))
    .filter(t => t && t.length > 50);

  return {
    text: texts.join('\n\n---\n\n'),
    metadata: { format: 'mbox', filename, emailCount: texts.length },
    contentType: 'email',
  };
}

// ─── EML (single email) ───────────────────────────────────────────────────────

function extractEml(raw, filename) {
  const text = parseEmailText(raw);
  return {
    text,
    metadata: { format: 'eml', filename },
    contentType: 'email',
  };
}

// ─── Email parser (simple header + body extractor) ───────────────────────────

function parseEmailText(raw) {
  const lines = raw.split('\n');
  let inBody = false;
  let subject = '';
  const bodyLines = [];

  for (const line of lines) {
    if (!inBody) {
      if (line.toLowerCase().startsWith('subject:')) {
        subject = line.slice(8).trim();
      }
      if (line.trim() === '') {
        inBody = true; // blank line separates headers from body
      }
    } else {
      // Skip quoted replies (lines starting with >)
      if (!line.startsWith('>')) {
        bodyLines.push(line);
      }
    }
  }

  const body = bodyLines
    .join('\n')
    .replace(/--+[^\n]*/g, '')       // strip MIME boundaries
    .replace(/<[^>]+>/g, '')          // strip HTML tags
    .replace(/https?:\/\/[^\s]+/g, '') // strip URLs
    .replace(/\S+@\S+\.\S+/g, '[email]') // anonymise email addresses
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[phone]') // anonymise phones
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!body) return '';
  return subject ? `Subject: ${subject}\n\n${body}` : body;
}
