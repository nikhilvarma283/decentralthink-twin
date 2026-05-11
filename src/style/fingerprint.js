/**
 * Style Fingerprint
 *
 * Extracts HOW a person communicates — separate from WHAT they know.
 * The fingerprint drives the system prompt for every twin response.
 */

import axios from 'axios';
import { logger } from '../lib/logger.js';

// ─── Default fingerprint (used before calibration) ────────────────────────────

export const DEFAULT_FINGERPRINT = {
  identity: { name: 'the person', pronouns: 'they/them' },
  voice: {
    formality_baseline: 0.6,
    directness: 0.7,
    humor_frequency: 'rare',
    typical_greeting_email: 'Hi,',
    typical_signoff: 'Best,',
    disagreement_style: 'acknowledges first, then redirects',
  },
  writing_patterns: {
    avg_sentence_length: 18,
    uses_em_dashes: false,
    uses_parentheticals: false,
    uses_rhetorical_questions: 'occasionally',
    list_style: 'bullet points',
    paragraph_length: 'medium',
  },
  explanation_style: {
    approach: 'context first, then conclusion',
    analogy_frequency: 'moderate',
    favorite_analogies: [],
    technical_depth_default: 'assumes competence',
  },
  deferral_patterns: {
    out_of_scope: "That's outside my area — I focus on [domains]. You'd want someone who specialises in that.",
    uncertain: "I've come across this but I wouldn't call myself an expert. Here's my rough take, worth verifying...",
    decline_to_speculate: "I don't have enough context to give you a good answer on that.",
  },
  few_shot_exemplars: [],
  domains: [],
};

// ─── Style prompt builder ─────────────────────────────────────────────────────

/**
 * Builds the personality/style section of the system prompt.
 * @param {object} fp - Style fingerprint
 * @param {string} context - 'email' | 'chat' | 'document' | 'qa'
 */
export function buildStylePrompt(fp = DEFAULT_FINGERPRINT, context = 'qa') {
  if (!fp) fp = DEFAULT_FINGERPRINT;

  const name = fp.identity?.name || 'this person';
  const toneNote = getToneNote(fp, context);
  const exemplars = formatExemplars(fp.few_shot_exemplars || [], context);
  const antiPatterns = getAntiPatterns();
  const quirks = getQuirks(fp);

  return `You are the digital twin of ${name}. You respond exactly as they would — using their vocabulary, sentence structure, level of formality, and communication quirks.

IDENTITY:
- Name: ${name}
- Pronouns: ${fp.identity?.pronouns || 'they/them'}

VOICE & TONE (current context: ${context}):
${toneNote}
- Directness: ${Math.round((fp.voice?.directness || 0.7) * 10)}/10
- Formality: ${Math.round((fp.voice?.formality_baseline || 0.6) * 10)}/10
- Humor: ${fp.voice?.humor_frequency || 'rare'}
- Disagreement style: ${fp.voice?.disagreement_style || 'acknowledges first, then redirects'}

WRITING PATTERNS:
- Sentence length: avg ${fp.writing_patterns?.avg_sentence_length || 18} words
- Uses em-dashes: ${fp.writing_patterns?.uses_em_dashes ? 'yes' : 'no'}
- Uses parentheticals: ${fp.writing_patterns?.uses_parentheticals ? 'yes' : 'no'}
- Rhetorical questions: ${fp.writing_patterns?.uses_rhetorical_questions || 'occasionally'}
- Lists: ${fp.writing_patterns?.list_style || 'bullet points'}
${quirks}

EXPLANATION STYLE:
- Approach: ${fp.explanation_style?.approach || 'context first'}
- Analogy usage: ${fp.explanation_style?.analogy_frequency || 'moderate'}
${fp.explanation_style?.favorite_analogies?.length ? `- Favourite analogies: ${fp.explanation_style.favorite_analogies.join(', ')}` : ''}
- Technical depth: ${fp.explanation_style?.technical_depth_default || 'assumes competence'}

${exemplars}

${antiPatterns}`;
}

// ─── Deferral phrases ─────────────────────────────────────────────────────────

export function getDeferralPhrase(fp, type = 'out_of_scope', query = '') {
  const patterns = fp?.deferral_patterns || DEFAULT_FINGERPRINT.deferral_patterns;
  const domains = fp?.domains?.map(d => d.primary || d).join(', ') || 'my core areas';
  const phrase = patterns[type] || patterns.out_of_scope;
  return phrase.replace('[domains]', domains).replace('[topic]', extractTopic(query));
}

// ─── Fingerprint extraction from communication samples ────────────────────────

/**
 * Extract a style fingerprint from a batch of text samples.
 * Runs inside TEE — communication data never leaves.
 *
 * @param {string[]} samples - Array of text samples (emails, chat, etc.)
 * @param {string} name      - Person's name
 * @returns {object}         - Style fingerprint JSON
 */
export async function extractFingerprint(samples, name) {
  if (!samples?.length) return { ...DEFAULT_FINGERPRINT, identity: { name } };

  const corpus = samples.slice(0, 20).join('\n\n---\n\n').slice(0, 8000);

  try {
    const prompt = `Analyse these communication samples from ${name} and extract their style fingerprint.

Return ONLY valid JSON matching this exact structure:
{
  "identity": { "name": "${name}", "pronouns": "he/him|she/her|they/them" },
  "voice": {
    "formality_baseline": 0.0-1.0,
    "directness": 0.0-1.0,
    "humor_frequency": "rare|occasional|frequent",
    "typical_greeting_email": "string",
    "typical_signoff": "string",
    "disagreement_style": "string"
  },
  "writing_patterns": {
    "avg_sentence_length": number,
    "uses_em_dashes": boolean,
    "uses_parentheticals": boolean,
    "uses_rhetorical_questions": "rarely|occasionally|frequently",
    "list_style": "bullet points|inline|numbered",
    "paragraph_length": "short|medium|long"
  },
  "explanation_style": {
    "approach": "string",
    "analogy_frequency": "low|moderate|high",
    "favorite_analogies": ["string"],
    "technical_depth_default": "string"
  },
  "deferral_patterns": {
    "out_of_scope": "string in their voice",
    "uncertain": "string in their voice",
    "decline_to_speculate": "string in their voice"
  },
  "few_shot_exemplars": [
    { "context": "string", "text": "actual excerpt 100-200 words" }
  ]
}

Communication samples:
${corpus}`;

    const { data } = await axios.post(
      `${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/generate`,
      {
        model: process.env.INFERENCE_MODEL || 'nous-hermes2',
        prompt,
        stream: false,
        format: 'json',
      }
    );

    const parsed = JSON.parse(data.response);
    logger.info({ name }, 'Style fingerprint extracted');
    return { ...DEFAULT_FINGERPRINT, ...parsed };
  } catch (err) {
    logger.error({ err }, 'Fingerprint extraction failed, using defaults');
    return { ...DEFAULT_FINGERPRINT, identity: { name } };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToneNote(fp, context) {
  const toneMap = {
    email:    `Use ${fp.voice?.typical_greeting_email || 'Hi,'} as greeting. Sign off with "${fp.voice?.typical_signoff || 'Best,'}". More formal than casual.`,
    chat:     'Casual tone. Fragments are fine. Skip formal greetings unless the person normally uses them.',
    document: 'Precise and structured. Use domain terminology. Assume a technical audience.',
    qa:       'Conversational but substantive. Match the formality level of the question.',
  };
  return toneMap[context] || toneMap.qa;
}

function formatExemplars(exemplars, context) {
  if (!exemplars?.length) return '';
  const relevant = exemplars.filter(e => !context || e.context?.includes(context) || true).slice(0, 3);
  if (!relevant.length) return '';
  return `ACTUAL WRITING EXAMPLES (match this style):\n${relevant.map(e => `[${e.context}]\n${e.text}`).join('\n\n')}`;
}

function getAntiPatterns() {
  return `NEVER SAY (these make you sound like a generic AI, not this person):
- "Great question!" / "Excellent question!"
- "It's important to note that..."
- "I'd be happy to help!"
- "Here are some key considerations:"
- "Let me break this down for you"
- "In conclusion..." / "To summarize..."
- Starting with "Absolutely!" / "Certainly!" / "Of course!"
- "As an AI language model..."`;
}

function getQuirks(fp) {
  const quirks = [];
  if (fp.writing_patterns?.uses_em_dashes) quirks.push('- Uses em-dashes for parenthetical emphasis — like this');
  if (fp.writing_patterns?.uses_rhetorical_questions === 'frequently') quirks.push('- Uses rhetorical questions to make points');
  if (fp.explanation_style?.approach?.includes('conclusion')) quirks.push('- Leads with the conclusion, then supports it');
  return quirks.length ? quirks.join('\n') : '';
}

function extractTopic(query) {
  const words = query.split(' ').slice(0, 5).join(' ');
  return words || 'that topic';
}
