/**
 * Anti-Enhancement Validator
 *
 * Prevents artificial inflation of a twin's capabilities by detecting:
 *   1. AI-generated content  — synthetic text masquerading as personal work
 *   2. Generic reference material — textbooks, Wikipedia, web articles not authored by the person
 *   3. Suspicious bulk uploads  — large corpora with low personal signal
 *
 * The spec's Iron Rule: "Every piece of data that trains the twin must be
 * explicitly uploaded or approved by the person. No exceptions."
 */

import axios from 'axios';
import { logger } from '../../lib/logger.js';

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.text        - Extracted text to validate
 * @param {string} opts.category    - Content category
 * @param {string} opts.filename    - Original filename / URL
 * @param {string} opts.contentType - Detected content type
 * @returns {{ valid: boolean, warnings: string[], flags: object }}
 */
export async function validateContent({ text, category, filename, contentType }) {
  const flags = {};
  const warnings = [];

  if (!text || text.length < 50) {
    return { valid: false, warnings: ['Content too short to validate'], flags };
  }

  // ── Check 1: AI-generated content detection ─────────────────────────────────
  const aiScore = detectAIPatterns(text);
  flags.aiScore = aiScore;
  if (aiScore > 0.7) {
    warnings.push(`High AI-generated content signal (score: ${aiScore.toFixed(2)}). This content may not represent the person's own writing.`);
  }

  // ── Check 2: Generic reference material detection ───────────────────────────
  const genericScore = detectGenericReference(text);
  flags.genericScore = genericScore;
  if (genericScore > 0.6) {
    warnings.push(`Content appears to be generic reference material rather than personal work product (score: ${genericScore.toFixed(2)}). Consider uploading your own annotations instead.`);
  }

  // ── Check 3: Personal signal check ──────────────────────────────────────────
  const personalScore = measurePersonalSignal(text);
  flags.personalScore = personalScore;
  if (personalScore < 0.2 && category !== 'annotated_references') {
    warnings.push(`Low personal signal detected (score: ${personalScore.toFixed(2)}). Content doesn't appear to contain first-person perspective or personal analysis.`);
  }

  // ── Check 4: Content-category mismatch ──────────────────────────────────────
  const categoryMismatch = detectCategoryMismatch(text, category, contentType);
  if (categoryMismatch) {
    flags.categoryMismatch = categoryMismatch;
    warnings.push(`Content may not match category "${category}": ${categoryMismatch}`);
  }

  // ── Check 5: Suspicious bulk — very long with no personal markers ────────────
  if (text.length > 50000 && personalScore < 0.15) {
    warnings.push('Very large document with very low personal signal. Consider splitting into annotated sections.');
    flags.bulkSuspicious = true;
  }

  // Determine validity — block only clear AI generation + no personal signal
  const blocked = aiScore > 0.85 && personalScore < 0.1;
  const valid = !blocked;

  if (blocked) {
    logger.warn({ filename, aiScore, personalScore }, 'Content blocked by anti-enhancement validator');
  } else if (warnings.length) {
    logger.info({ filename, warnings: warnings.length }, 'Content passed with warnings');
  }

  return { valid, warnings, flags, blocked };
}

// ─── AI-generated content detection ──────────────────────────────────────────
// Heuristic: AI text has characteristic patterns — overly uniform sentence
// lengths, specific phrase patterns, absence of personal markers, etc.

const AI_PATTERNS = [
  // Structural AI tells
  /\bIn (conclusion|summary|closing)\b/gi,
  /\bIt('s| is) (important|crucial|worth noting|essential) to (note|mention|highlight|understand)\b/gi,
  /\bHere are (some|the|a few) (key|main|important|top)/gi,
  /\bLet('s| us) (explore|dive into|delve into|break down|examine)/gi,
  /\bIn (today's|the modern|the current) (world|landscape|era|age|digital age)/gi,
  /\bThis (comprehensive|detailed|in-depth|thorough) (guide|overview|article|post)/gi,
  /\bFirst and foremost\b/gi,
  /\bFurthermore,?\s+(it is|we can|this)/gi,
  /\bMoreover,?\s+(it is|we can|this)/gi,
  /\bIn addition to (the above|this|that)/gi,
  /\bBy leveraging (the power of|these|this)/gi,
  /\bUnlock(ing)? (your|the) (full potential|potential of)/gi,
  /\bIn the realm of\b/gi,
  /\bNavigating the (complex|ever-changing|rapidly evolving)/gi,
  /^(Certainly|Absolutely|Of course|Sure)!/gim,
  /\bAs an AI (language model|assistant|system)\b/gi,
];

function detectAIPatterns(text) {
  let hits = 0;
  for (const pattern of AI_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) hits += matches.length;
  }

  // Sentence length uniformity (AI tends to produce very uniform lengths)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const lengths = sentences.map(s => s.trim().split(/\s+/).length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  const variance = lengths.reduce((acc, l) => acc + Math.pow(l - avgLen, 2), 0) / (lengths.length || 1);
  const uniformityPenalty = variance < 8 && sentences.length > 10 ? 0.15 : 0;

  // Normalise: more than 3 hits in 1000 words is suspicious
  const wordCount = text.split(/\s+/).length;
  const hitRate = (hits / wordCount) * 1000;
  const rawScore = Math.min(hitRate / 5, 1.0);

  return Math.min(rawScore + uniformityPenalty, 1.0);
}

// ─── Generic reference material detection ────────────────────────────────────

const REFERENCE_SIGNALS = [
  /^(Chapter|Section|Figure|Table|Appendix)\s+\d+/gim,
  /\(see (figure|table|section|chapter|appendix)\s+\d+\)/gi,
  /\bcite[ds]?\b|\bcitation\b|\bbibliograph/gi,
  /\baccording to (studies|research|researchers|experts|scientists)\b/gi,
  /\bwidely (accepted|known|recognised|understood)\b/gi,
  /\bby definition\b|\bby convention\b/gi,
  /\bthe following (table|figure|diagram|chart) (shows|illustrates|depicts)/gi,
  /\blearning objectives?\b|\bafter (completing|reading) this (chapter|section|module)\b/gi,
  /ISBN|DOI:|arXiv:/gi,
];

function detectGenericReference(text) {
  let hits = 0;
  for (const p of REFERENCE_SIGNALS) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  const wordCount = text.split(/\s+/).length;
  return Math.min((hits / wordCount) * 500, 1.0);
}

// ─── Personal signal measurement ─────────────────────────────────────────────

const PERSONAL_SIGNALS = [
  /\b(I|my|mine|myself|we|our|ours)\b/gi,
  /\bin my (experience|opinion|view|perspective|work|practice)\b/gi,
  /\bI('ve| have) (worked|built|seen|found|noticed|learned|discovered)\b/gi,
  /\bwhen I\b/gi,
  /\bmy (approach|method|take|view|perspective|experience)\b/gi,
  /\bI (think|believe|feel|argue|suggest|recommend|prefer)\b/gi,
  /\bin (my|our) (team|company|org|project|case)\b/gi,
  /\bfrom (my|our) (experience|perspective|work)\b/gi,
];

function measurePersonalSignal(text) {
  let hits = 0;
  for (const p of PERSONAL_SIGNALS) {
    const m = text.match(p);
    if (m) hits += m.length;
  }
  const wordCount = text.split(/\s+/).length;
  return Math.min((hits / wordCount) * 200, 1.0);
}

// ─── Category mismatch detection ─────────────────────────────────────────────

function detectCategoryMismatch(text, category, contentType) {
  if (category === 'emails') {
    const hasEmailStructure = /^(From|To|Subject|Date):/.test(text) ||
                               /^(Hi|Hello|Dear)\s+\w+[,.]/.test(text);
    if (!hasEmailStructure && personalSignalAbsent(text)) {
      return 'No email structure detected — ensure you are uploading your own email exports';
    }
  }

  if (category === 'transcripts' && contentType !== 'youtube' && contentType !== 'audio' && contentType !== 'video') {
    const hasTranscriptPattern = /^\[?\d{2}:\d{2}/.test(text) || /^(Speaker\s+\d|[A-Z]{2,}:)/m.test(text);
    if (!hasTranscriptPattern && text.length < 500) {
      return 'Short content categorised as transcript — provide a talk, podcast, or interview transcript';
    }
  }

  return null;
}

function personalSignalAbsent(text) {
  return measurePersonalSignal(text) < 0.05;
}
