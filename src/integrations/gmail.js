/**
 * Gmail + Google Calendar Integration
 *
 * Provides:
 *   - Inbox reading (recent threads, unread filter)
 *   - Email draft generation in the twin owner's voice
 *   - Google Calendar: upcoming events, availability check
 *   - Pre-meeting briefing document generation
 *   - Post-meeting follow-up email drafting from notes
 *
 * The twin NEVER sends email autonomously.
 * All drafted emails go into the review queue (drafts.js).
 * The owner must approve before anything is sent.
 *
 * Gmail API reference: https://developers.google.com/gmail/api
 * Calendar API reference: https://developers.google.com/calendar/api
 */

import axios from 'axios';
import { getAccessToken } from './oauth.js';
import { retrieve } from '../knowledge/ingest.js';
import { buildStylePrompt } from '../style/fingerprint.js';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const GMAIL_BASE  = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GCAL_BASE   = 'https://www.googleapis.com/calendar/v3';
const OLLAMA_URL  = () => process.env.OLLAMA_URL || 'http://ollama:11434';
const MODEL       = () => process.env.INFERENCE_MODEL || 'nous-hermes2';

// ─── Inbox ────────────────────────────────────────────────────────────────────

/**
 * Fetch recent email threads from Gmail inbox.
 *
 * @param {object} opts
 * @param {string}  opts.sessionToken
 * @param {string}  opts.twinId
 * @param {number}  [opts.maxResults=20]
 * @param {boolean} [opts.unreadOnly=false]
 * @param {string}  [opts.query]          - Gmail search query (e.g. "from:boss@co.com")
 */
export async function getInbox({ sessionToken, twinId, maxResults = 20, unreadOnly = false, query = '' }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'google' });

  const q = [unreadOnly ? 'is:unread' : '', query].filter(Boolean).join(' ');

  const { data: listData } = await axios.get(`${GMAIL_BASE}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { maxResults, q: q || 'in:inbox' },
  });

  if (!listData.messages?.length) return [];

  // Fetch message details in parallel (batched to avoid rate limits)
  const messages = await batchFetch(
    listData.messages.slice(0, maxResults),
    async (msg) => {
      const { data } = await axios.get(`${GMAIL_BASE}/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
      });
      return parseMessageMetadata(data);
    },
    5 // concurrency
  );

  return messages.filter(Boolean);
}

/**
 * Fetch a single email thread with full body text.
 */
export async function getThread({ sessionToken, twinId, threadId }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'google' });

  const { data } = await axios.get(`${GMAIL_BASE}/threads/${threadId}`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { format: 'full' },
  });

  return {
    threadId,
    messages: data.messages.map(m => ({
      id:      m.id,
      from:    getHeader(m, 'From'),
      to:      getHeader(m, 'To'),
      subject: getHeader(m, 'Subject'),
      date:    getHeader(m, 'Date'),
      body:    extractBody(m),
      snippet: m.snippet,
    })),
  };
}

// ─── Draft email generation ───────────────────────────────────────────────────

/**
 * Draft a reply to an email thread in the twin owner's voice.
 * Uses RAG to find relevant context from the owner's knowledge base.
 * Goes into the review queue — NOT sent automatically.
 *
 * @param {object} opts
 * @param {string}   opts.sessionToken
 * @param {string}   opts.twinId
 * @param {string}   opts.twinOwner       - wallet address (for RAG + style)
 * @param {string}   opts.threadId        - Gmail thread ID to reply to
 * @param {string}   [opts.instructions]  - Optional extra instructions for the draft
 */
export async function draftReply({ sessionToken, twinId, twinOwner, threadId, instructions = '' }) {
  // 1. Fetch the thread
  const thread = await getThread({ sessionToken, twinId, threadId });
  const lastMessage = thread.messages[thread.messages.length - 1];
  const emailBody   = lastMessage.body || lastMessage.snippet;
  const subject     = lastMessage.subject || '(no subject)';
  const from        = lastMessage.from;

  // 2. RAG: find relevant context from the owner's knowledge base
  const ragResults = await retrieve({
    walletAddress: twinOwner,
    query:         `${subject} ${emailBody.slice(0, 500)}`,
    limit:         4,
  });
  const ragContext = ragResults.length
    ? ragResults.map(r => r.payload?.text).join('\n\n---\n\n')
    : '';

  // 3. Load style fingerprint
  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  // 4. Generate draft
  const systemPrompt = buildEmailSystemPrompt({ styleFingerprint, ragContext, instructions });
  const userPrompt   = buildEmailUserPrompt({ from, subject, emailBody, thread });

  const draft = await generateWithOllama({ systemPrompt, userPrompt });

  logger.info({ twinId, threadId, subject }, 'Email reply drafted');
  return {
    threadId,
    subject:    subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    to:         from,
    body:       draft,
    source:     'gmail',
    ragUsed:    ragResults.length > 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Draft a new email (not a reply) in the owner's voice.
 */
export async function draftNewEmail({ sessionToken, twinId, twinOwner, to, subject, brief, instructions = '' }) {
  const ragResults = await retrieve({ walletAddress: twinOwner, query: `${subject} ${brief}`, limit: 4 });
  const ragContext = ragResults.map(r => r.payload?.text).join('\n\n---\n\n');
  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  const systemPrompt = buildEmailSystemPrompt({ styleFingerprint, ragContext, instructions });
  const userPrompt = `Draft a new email:
To: ${to}
Subject: ${subject}
Brief: ${brief}

Write the full email body only (no subject line, no "To:" header — just the body).`;

  const body = await generateWithOllama({ systemPrompt, userPrompt });

  return { to, subject, body, source: 'gmail', ragUsed: ragResults.length > 0, generatedAt: new Date().toISOString() };
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

/**
 * Fetch upcoming calendar events.
 */
export async function getUpcomingEvents({ sessionToken, twinId, days = 7, maxResults = 20 }) {
  const token     = await getAccessToken({ sessionToken, twinId, provider: 'google' });
  const timeMin   = new Date().toISOString();
  const timeMax   = new Date(Date.now() + days * 86400000).toISOString();

  const { data } = await axios.get(`${GCAL_BASE}/calendars/primary/events`, {
    headers: { Authorization: `Bearer ${token}` },
    params:  { timeMin, timeMax, maxResults, singleEvents: true, orderBy: 'startTime' },
  });

  return (data.items || []).map(e => ({
    id:          e.id,
    summary:     e.summary,
    start:       e.start?.dateTime || e.start?.date,
    end:         e.end?.dateTime   || e.end?.date,
    attendees:   (e.attendees || []).map(a => a.email),
    location:    e.location,
    description: e.description,
    meetLink:    e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri,
  }));
}

/**
 * Check availability for a given time range.
 * Returns free/busy info.
 */
export async function checkAvailability({ sessionToken, twinId, timeMin, timeMax }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'google' });

  const { data } = await axios.post(`${GCAL_BASE}/freeBusy`, {
    timeMin,
    timeMax,
    items: [{ id: 'primary' }],
  }, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const busy = data.calendars?.primary?.busy || [];
  return { timeMin, timeMax, busyPeriods: busy, available: busy.length === 0 };
}

/**
 * Generate a pre-meeting briefing document.
 * Uses RAG to surface relevant context the owner has about the attendees/topic.
 */
export async function generateMeetingBriefing({ sessionToken, twinId, twinOwner, eventId }) {
  const events = await getUpcomingEvents({ sessionToken, twinId, days: 14, maxResults: 50 });
  const event  = events.find(e => e.id === eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  // RAG search for context on meeting topic + attendees
  const attendeeContext = event.attendees.slice(0, 5).join(', ');
  const ragQuery = `${event.summary} ${attendeeContext} ${event.description || ''}`.trim();
  const ragResults = await retrieve({ walletAddress: twinOwner, query: ragQuery, limit: 6 });
  const ragContext = ragResults.map(r => r.payload?.text).join('\n\n---\n\n');

  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  const systemPrompt = `${buildStylePrompt(styleFingerprint, 'document')}

You are preparing a pre-meeting briefing for the person described above.
Write in first person as if you are briefing yourself before this meeting.
Be concise and practical — what do I need to know, remember, or prepare?`;

  const userPrompt = `Prepare a pre-meeting briefing for this event:

MEETING: ${event.summary}
TIME: ${event.start}
ATTENDEES: ${event.attendees.join(', ') || 'unknown'}
LOCATION: ${event.location || event.meetLink || 'TBD'}
DESCRIPTION: ${event.description || 'none'}

RELEVANT CONTEXT FROM MY KNOWLEDGE BASE:
${ragContext || 'No specific context found.'}

Generate a concise briefing covering:
1. What this meeting is about (in my own words)
2. Key points I want to raise or remember
3. Any relevant background on attendees (from my knowledge)
4. Action items to prepare before the meeting`;

  const briefing = await generateWithOllama({ systemPrompt, userPrompt });

  return {
    eventId,
    event: { summary: event.summary, start: event.start, attendees: event.attendees },
    briefing,
    ragSourceCount: ragResults.length,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Draft post-meeting follow-up emails from notes or a transcript.
 * Returns one draft per action item recipient.
 */
export async function draftFollowUpEmails({ sessionToken, twinId, twinOwner, meetingNotes, attendees = [], subject = '' }) {
  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  const systemPrompt = `${buildStylePrompt(styleFingerprint, 'email')}

You are drafting post-meeting follow-up emails.
Each email should be concise, personal, and in the owner's natural voice.
Reference specific action items from the meeting.
Do NOT use generic AI openers like "I hope this email finds you well."`;

  const userPrompt = `Based on these meeting notes, draft follow-up emails:

MEETING SUBJECT: ${subject || 'our meeting'}
ATTENDEES: ${attendees.join(', ') || 'meeting participants'}

MEETING NOTES / TRANSCRIPT:
${meetingNotes}

Draft a single follow-up email to the group (or the most relevant recipient).
Include:
- Brief thanks (1 line, natural, not effusive)
- Summary of key decisions / outcomes (bullet points)
- Action items with owners
- Next steps
Write only the email body.`;

  const body = await generateWithOllama({ systemPrompt, userPrompt });

  return [{
    to:          attendees[0] || '',
    subject:     `Follow-up: ${subject || 'our meeting'}`,
    body,
    source:     'calendar_followup',
    generatedAt: new Date().toISOString(),
  }];
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function loadStyleFingerprint({ sessionToken, twinOwner }) {
  try {
    const { ciphertext } = await core.vaultRead({ sessionToken, key: `twin/style/${twinOwner}` });
    return JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf-8'));
  } catch { return null; }
}

function buildEmailSystemPrompt({ styleFingerprint, ragContext, instructions }) {
  const stylePart = buildStylePrompt(styleFingerprint, 'email');
  return `${stylePart}

RELEVANT CONTEXT FROM YOUR KNOWLEDGE BASE:
${ragContext || 'No specific context retrieved.'}

EMAIL WRITING RULES — never break these:
- Write as the person, not as an AI assistant
- Never open with "I hope this email finds you well", "Great to connect", "Certainly!", "Absolutely!"
- Match their natural email tone: ${styleFingerprint?.emailTone || 'direct and professional'}
- Keep it concise — say what needs to be said, nothing more
- If you don't have enough context to answer something in the email, flag it in [brackets] for the owner to fill in
${instructions ? `\nADDITIONAL INSTRUCTIONS: ${instructions}` : ''}`;
}

function buildEmailUserPrompt({ from, subject, emailBody, thread }) {
  const context = thread.messages.length > 1
    ? `\nCONVERSATION HISTORY (${thread.messages.length} messages):\n` +
      thread.messages.slice(-3).map(m => `[${m.from}]: ${m.body?.slice(0, 300) || m.snippet}`).join('\n\n')
    : '';

  return `Draft a reply to this email:

FROM: ${from}
SUBJECT: ${subject}
${context}

LATEST MESSAGE:
${emailBody?.slice(0, 2000) || '(no body)'}

Write only the reply body (no "Subject:" or "To:" headers).`;
}

async function generateWithOllama({ systemPrompt, userPrompt }) {
  try {
    const { data } = await axios.post(`${OLLAMA_URL()}/api/chat`, {
      model:  MODEL(),
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      options: { temperature: 0.65, top_p: 0.9, num_predict: 1024 },
    });
    return data.message?.content || '[Generation failed — please draft manually]';
  } catch (err) {
    logger.error({ err }, 'Ollama generation failed in email integration');
    return '[Generation failed — please draft manually]';
  }
}

function parseMessageMetadata(msg) {
  return {
    id:       msg.id,
    threadId: msg.threadId,
    subject:  getHeader(msg, 'Subject'),
    from:     getHeader(msg, 'From'),
    to:       getHeader(msg, 'To'),
    date:     getHeader(msg, 'Date'),
    snippet:  msg.snippet,
    unread:   msg.labelIds?.includes('UNREAD'),
  };
}

function getHeader(msg, name) {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractBody(msg) {
  const part = findPart(msg.payload, 'text/plain') || findPart(msg.payload, 'text/html');
  if (!part?.body?.data) return msg.snippet || '';
  const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
  // Strip HTML if needed
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
}

function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType) return payload;
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

async function batchFetch(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : null);
    }
  }
  return results;
}
