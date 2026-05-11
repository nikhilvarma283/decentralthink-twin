/**
 * Outlook Mail + Outlook Calendar Integration (Microsoft Graph API)
 *
 * Mirrors the Gmail integration but uses Microsoft Graph v1.0.
 * Same invariant: twin NEVER sends email. All drafts go to review queue.
 *
 * Microsoft Graph API reference: https://learn.microsoft.com/graph/api/overview
 */

import axios from 'axios';
import { getAccessToken } from './oauth.js';
import { retrieve } from '../knowledge/ingest.js';
import { buildStylePrompt } from '../style/fingerprint.js';
import core from '../core/client.js';
import { logger } from '../lib/logger.js';

const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0/me';
const OLLAMA_URL  = () => process.env.OLLAMA_URL || 'http://ollama:11434';
const MODEL       = () => process.env.INFERENCE_MODEL || 'nous-hermes2';

// ─── Inbox ────────────────────────────────────────────────────────────────────

/**
 * Fetch recent messages from Outlook inbox.
 */
export async function getInbox({ sessionToken, twinId, maxResults = 20, unreadOnly = false, query = '' }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'microsoft' });

  const params = {
    $top:     maxResults,
    $orderby: 'receivedDateTime desc',
    $select:  'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead',
  };

  if (unreadOnly) params.$filter = 'isRead eq false';
  if (query)      params.$search = `"${query}"`;

  const { data } = await axios.get(`${GRAPH_BASE}/mailFolders/inbox/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  return (data.value || []).map(m => ({
    id:       m.id,
    threadId: m.conversationId,
    subject:  m.subject,
    from:     m.from?.emailAddress?.address,
    to:       m.toRecipients?.map(r => r.emailAddress?.address).join(', '),
    date:     m.receivedDateTime,
    snippet:  m.bodyPreview,
    unread:   !m.isRead,
  }));
}

/**
 * Fetch a full conversation thread.
 */
export async function getThread({ sessionToken, twinId, threadId }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'microsoft' });

  const { data } = await axios.get(`${GRAPH_BASE}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      $filter:  `conversationId eq '${threadId}'`,
      $orderby: 'receivedDateTime asc',
      $select:  'id,subject,from,toRecipients,receivedDateTime,body',
    },
  });

  return {
    threadId,
    messages: (data.value || []).map(m => ({
      id:      m.id,
      from:    m.from?.emailAddress?.address,
      to:      m.toRecipients?.map(r => r.emailAddress?.address).join(', '),
      subject: m.subject,
      date:    m.receivedDateTime,
      body:    m.body?.content?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000) || '',
    })),
  };
}

// ─── Draft generation ─────────────────────────────────────────────────────────

/**
 * Draft a reply to an Outlook email thread.
 */
export async function draftReply({ sessionToken, twinId, twinOwner, threadId, instructions = '' }) {
  const thread      = await getThread({ sessionToken, twinId, threadId });
  const lastMessage = thread.messages[thread.messages.length - 1];
  const emailBody   = lastMessage.body;
  const subject     = lastMessage.subject || '(no subject)';
  const from        = lastMessage.from;

  const ragResults = await retrieve({
    walletAddress: twinOwner,
    query:         `${subject} ${emailBody.slice(0, 500)}`,
    limit:         4,
  });
  const ragContext = ragResults.map(r => r.payload?.text).join('\n\n---\n\n');

  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });
  const systemPrompt = buildEmailSystemPrompt({ styleFingerprint, ragContext, instructions });
  const userPrompt   = buildEmailUserPrompt({ from, subject, emailBody, thread });

  const body = await generateWithOllama({ systemPrompt, userPrompt });

  logger.info({ twinId, threadId, subject }, 'Outlook reply drafted');
  return {
    threadId,
    subject:    subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    to:         from,
    body,
    source:     'outlook',
    ragUsed:    ragResults.length > 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Draft a new Outlook email.
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

Write the full email body only.`;

  const body = await generateWithOllama({ systemPrompt, userPrompt });
  return { to, subject, body, source: 'outlook', ragUsed: ragResults.length > 0, generatedAt: new Date().toISOString() };
}

// ─── Outlook Calendar ─────────────────────────────────────────────────────────

/**
 * Fetch upcoming Outlook calendar events.
 */
export async function getUpcomingEvents({ sessionToken, twinId, days = 7, maxResults = 20 }) {
  const token   = await getAccessToken({ sessionToken, twinId, provider: 'microsoft' });
  const start   = new Date().toISOString();
  const end     = new Date(Date.now() + days * 86400000).toISOString();

  const { data } = await axios.get(`${GRAPH_BASE}/calendarView`, {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      startDateTime: start,
      endDateTime:   end,
      $top:          maxResults,
      $orderby:      'start/dateTime',
      $select:       'id,subject,start,end,attendees,location,bodyPreview,onlineMeeting',
    },
  });

  return (data.value || []).map(e => ({
    id:          e.id,
    summary:     e.subject,
    start:       e.start?.dateTime,
    end:         e.end?.dateTime,
    attendees:   (e.attendees || []).map(a => a.emailAddress?.address),
    location:    e.location?.displayName,
    description: e.bodyPreview,
    meetLink:    e.onlineMeeting?.joinUrl,
  }));
}

/**
 * Check Outlook calendar availability.
 */
export async function checkAvailability({ sessionToken, twinId, timeMin, timeMax }) {
  const token = await getAccessToken({ sessionToken, twinId, provider: 'microsoft' });

  const { data } = await axios.post(`${GRAPH_BASE}/getSchedule`, {
    schedules:      ['me'],
    startTime:      { dateTime: timeMin, timeZone: 'UTC' },
    endTime:        { dateTime: timeMax, timeZone: 'UTC' },
    availabilityViewInterval: 30,
  }, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const schedule = data.value?.[0];
  const busy = (schedule?.scheduleItems || []).map(i => ({
    start: i.start?.dateTime,
    end:   i.end?.dateTime,
  }));

  return { timeMin, timeMax, busyPeriods: busy, available: busy.length === 0 };
}

/**
 * Generate a pre-meeting briefing (same logic as Gmail integration).
 */
export async function generateMeetingBriefing({ sessionToken, twinId, twinOwner, eventId }) {
  const events = await getUpcomingEvents({ sessionToken, twinId, days: 14, maxResults: 50 });
  const event  = events.find(e => e.id === eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);

  const ragQuery  = `${event.summary} ${event.attendees.slice(0, 5).join(', ')} ${event.description || ''}`.trim();
  const ragResults = await retrieve({ walletAddress: twinOwner, query: ragQuery, limit: 6 });
  const ragContext = ragResults.map(r => r.payload?.text).join('\n\n---\n\n');

  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  const systemPrompt = `${buildStylePrompt(styleFingerprint, 'document')}
You are preparing a pre-meeting briefing for the person described above.
Write in first person as if briefing yourself. Be concise and practical.`;

  const userPrompt = `Prepare a pre-meeting briefing:

MEETING: ${event.summary}
TIME: ${event.start}
ATTENDEES: ${event.attendees.join(', ') || 'unknown'}
LOCATION: ${event.location || event.meetLink || 'TBD'}
DESCRIPTION: ${event.description || 'none'}

RELEVANT CONTEXT FROM MY KNOWLEDGE BASE:
${ragContext || 'No specific context found.'}

Cover: what this meeting is about, key points to raise, background on attendees, prep needed.`;

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
 * Draft post-meeting follow-up emails from notes.
 */
export async function draftFollowUpEmails({ sessionToken, twinId, twinOwner, meetingNotes, attendees = [], subject = '' }) {
  const styleFingerprint = await loadStyleFingerprint({ sessionToken, twinOwner });

  const systemPrompt = `${buildStylePrompt(styleFingerprint, 'email')}
Draft post-meeting follow-up emails. Be concise and in the owner's natural voice.
Do NOT use generic openers like "I hope this email finds you well."`;

  const userPrompt = `Draft a follow-up email based on these meeting notes:

MEETING: ${subject || 'our meeting'}
ATTENDEES: ${attendees.join(', ') || 'meeting participants'}

NOTES:
${meetingNotes}

Include: brief thank you (1 line), key decisions, action items with owners, next steps.
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

// ─── Shared helpers (mirrored from gmail.js) ──────────────────────────────────

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

EMAIL RULES: Write as the person. No "Great to connect", no AI hedging language.
Match their natural tone. Flag gaps with [brackets] for the owner to fill in.
${instructions ? `\nINSTRUCTIONS: ${instructions}` : ''}`;
}

function buildEmailUserPrompt({ from, subject, emailBody, thread }) {
  const history = thread.messages.length > 1
    ? `\nCONVERSATION (${thread.messages.length} messages):\n` +
      thread.messages.slice(-3).map(m => `[${m.from}]: ${m.body?.slice(0, 300)}`).join('\n\n')
    : '';

  return `Draft a reply:\n\nFROM: ${from}\nSUBJECT: ${subject}${history}\n\nLATEST:\n${emailBody?.slice(0, 2000)}\n\nWrite reply body only.`;
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
    logger.error({ err }, 'Ollama generation failed in Outlook integration');
    return '[Generation failed — please draft manually]';
  }
}
