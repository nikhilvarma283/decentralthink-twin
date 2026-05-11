/**
 * Content Extractor Router
 *
 * Detects the content type from source metadata and routes to the
 * appropriate extractor. Every extractor returns the same shape:
 *
 *   { text: string, metadata: object, contentType: string }
 *
 * Supported sources:
 *   - Text files (.txt, .md, .csv)
 *   - PDF documents (.pdf)
 *   - Word documents (.docx)
 *   - PowerPoint presentations (.pptx)
 *   - Web URLs (articles, blog posts, documentation)
 *   - YouTube URLs (transcript or audio transcription)
 *   - Audio files (.mp3, .wav, .m4a, .ogg) → Whisper
 *   - Video files (.mp4, .mov, .webm) → Whisper
 *   - LinkedIn export (PDF or JSON)
 *   - Twitter/X archive (JSON)
 *   - Email files (.eml, .mbox)
 *   - Slack/Teams chat export (JSON)
 *   - GitHub repository URL
 *   - Raw text / bio paste
 */

import { extractText }          from './text.js';
import { extractPdf }           from './pdf.js';
import { extractDocx }          from './docx.js';
import { extractPptx }          from './pptx.js';
import { extractUrl }           from './url.js';
import { extractYoutube }       from './youtube.js';
import { extractAudioVideo }    from './audioVideo.js';
import { extractLinkedIn }      from './profile.js';
import { extractTwitter }       from './profile.js';
import { extractEmail }         from './email.js';
import { extractChat }          from './chat.js';
import { extractGithub }        from './github.js';
import { logger }               from '../../lib/logger.js';

// ─── Type detection ───────────────────────────────────────────────────────────

export function detectType(source) {
  const { url, filename, mimeType, category } = source;

  // URL-based detection
  if (url) {
    if (isYouTube(url))  return 'youtube';
    if (isGitHub(url))   return 'github';
    return 'url';
  }

  // Category-based overrides
  if (category === 'linkedin_export') return 'linkedin';
  if (category === 'twitter_archive') return 'twitter';
  if (category === 'slack_export')    return 'slack';
  if (category === 'teams_export')    return 'teams';
  if (category === 'email_export')    return 'email';

  // MIME type detection
  const mime = mimeType || '';
  if (mime === 'application/pdf')                                                  return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (mime.startsWith('audio/'))                                                   return 'audio';
  if (mime.startsWith('video/'))                                                   return 'video';
  if (mime === 'application/json')                                                 return 'json';
  if (mime === 'message/rfc822')                                                   return 'email';

  // Filename extension fallback
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  const extMap = {
    txt: 'text', md: 'text', markdown: 'text', csv: 'text',
    pdf: 'pdf',
    docx: 'docx', doc: 'docx',
    pptx: 'pptx', ppt: 'pptx',
    mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
    mp4: 'video', mov: 'video', webm: 'video', avi: 'video',
    eml: 'email', mbox: 'email',
    json: 'json',
  };
  return extMap[ext] || 'text';
}

// ─── Main extractor ───────────────────────────────────────────────────────────

/**
 * @param {object} source
 * @param {string}  [source.url]       - URL to fetch (web page, YouTube, GitHub)
 * @param {Buffer}  [source.buffer]    - Raw file bytes (for uploaded files)
 * @param {string}  [source.filename]  - Original filename
 * @param {string}  [source.mimeType]  - MIME type
 * @param {string}  [source.category]  - User-specified category
 * @param {string}  [source.rawText]   - Inline pasted text / bio
 * @returns {Promise<{ text, metadata, contentType }>}
 */
export async function extract(source) {
  const type = detectType(source);
  logger.debug({ type, filename: source.filename, url: source.url }, 'Extracting content');

  try {
    switch (type) {
      case 'text':    return await extractText(source);
      case 'pdf':     return await extractPdf(source);
      case 'docx':    return await extractDocx(source);
      case 'pptx':    return await extractPptx(source);
      case 'url':     return await extractUrl(source);
      case 'youtube': return await extractYoutube(source);
      case 'audio':
      case 'video':   return await extractAudioVideo(source, type);
      case 'linkedin':return await extractLinkedIn(source);
      case 'twitter': return await extractTwitter(source);
      case 'email':   return await extractEmail(source);
      case 'slack':
      case 'teams':   return await extractChat(source, type);
      case 'github':  return await extractGithub(source);
      case 'json':    return handleJson(source);
      default:        return extractText(source); // graceful fallback
    }
  } catch (err) {
    logger.error({ err, type, filename: source.filename }, 'Extraction failed');
    throw new Error(`Extraction failed for type ${type}: ${err.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isYouTube(url) {
  return /youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts/.test(url);
}

function isGitHub(url) {
  return /github\.com\/[^/]+\/[^/]+/.test(url);
}

function handleJson(source) {
  try {
    const obj = JSON.parse(source.buffer?.toString('utf-8') || source.rawText || '{}');
    return {
      text: JSON.stringify(obj, null, 2),
      metadata: { format: 'json', filename: source.filename },
      contentType: 'json',
    };
  } catch {
    return { text: source.rawText || '', metadata: {}, contentType: 'json' };
  }
}
