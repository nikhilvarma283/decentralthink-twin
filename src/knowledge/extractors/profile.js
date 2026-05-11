import { extractPdf } from './pdf.js';
import { logger } from '../../lib/logger.js';

/**
 * Profile extractors — LinkedIn and Twitter/X
 *
 * LinkedIn:
 *   - Accepts the PDF export (Profile → More → Save to PDF)
 *   - Or the ZIP data export (Settings → Data Export → Request archive)
 *
 * Twitter/X:
 *   - Accepts the data archive ZIP or the tweets.js file from the export
 */

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export async function extractLinkedIn(source) {
  // LinkedIn PDF export
  if (source.mimeType === 'application/pdf' || source.filename?.endsWith('.pdf')) {
    const extracted = await extractPdf(source);
    return {
      ...extracted,
      metadata: { ...extracted.metadata, format: 'linkedin', source: 'linkedin_pdf_export' },
      contentType: 'linkedin',
    };
  }

  // LinkedIn JSON/CSV data archive
  if (source.buffer) {
    const raw = source.buffer.toString('utf-8');

    // Handle individual CSV files from the archive
    if (source.filename?.endsWith('.csv')) {
      const text = parseCsvToText(raw, source.filename);
      return { text, metadata: { format: 'linkedin_csv', filename: source.filename }, contentType: 'linkedin' };
    }

    // Profile.json from data export
    if (source.filename === 'Profile.json') {
      const profile = JSON.parse(raw);
      const text = formatLinkedInProfile(profile);
      return { text, metadata: { format: 'linkedin_json' }, contentType: 'linkedin' };
    }

    // Recommendations.json
    if (source.filename?.includes('Recommendation')) {
      const recs = JSON.parse(raw);
      const text = formatRecommendations(recs);
      return { text, metadata: { format: 'linkedin_recommendations' }, contentType: 'linkedin' };
    }

    // Articles.json — published articles
    if (source.filename?.includes('Article')) {
      const articles = JSON.parse(raw);
      const text = formatArticles(articles);
      return { text, metadata: { format: 'linkedin_articles' }, contentType: 'linkedin' };
    }

    // Fallback: treat as text
    return { text: raw, metadata: { format: 'linkedin_raw', filename: source.filename }, contentType: 'linkedin' };
  }

  throw new Error('LinkedIn extractor: provide a PDF export or data archive file');
}

// ─── Twitter/X ────────────────────────────────────────────────────────────────

export async function extractTwitter(source) {
  if (!source.buffer) throw new Error('Twitter extractor requires a file buffer');

  const raw = source.buffer.toString('utf-8');

  // tweets.js from data archive — window.YTD.tweets.part0 = [...]
  let tweets = [];
  try {
    const jsonStr = raw.replace(/^window\.YTD\.\w+\.part\d+\s*=\s*/, '');
    const data = JSON.parse(jsonStr);
    tweets = Array.isArray(data) ? data : data.tweets || [];
  } catch {
    // Try plain JSON
    try { tweets = JSON.parse(raw); } catch { tweets = []; }
  }

  if (!tweets.length) {
    return { text: raw, metadata: { format: 'twitter_raw' }, contentType: 'twitter' };
  }

  // Extract the person's own text — skip retweets, keep replies and original tweets
  const ownTweets = tweets
    .filter(t => {
      const tweet = t.tweet || t;
      const text = tweet.full_text || tweet.text || '';
      return !text.startsWith('RT @');
    })
    .map(t => {
      const tweet = t.tweet || t;
      return (tweet.full_text || tweet.text || '').trim();
    })
    .filter(t => t.length > 20); // skip very short tweets

  const text = ownTweets.join('\n\n');
  logger.info({ tweetCount: ownTweets.length }, 'Twitter archive extracted');

  return {
    text,
    metadata: { format: 'twitter', tweetCount: ownTweets.length },
    contentType: 'twitter',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatLinkedInProfile(profile) {
  const sections = [];
  if (profile.firstName || profile.lastName) {
    sections.push(`# ${profile.firstName || ''} ${profile.lastName || ''}`.trim());
  }
  if (profile.headline) sections.push(`**${profile.headline}**`);
  if (profile.summary)  sections.push(`\n## Summary\n${profile.summary}`);
  if (profile.industry) sections.push(`Industry: ${profile.industry}`);
  return sections.join('\n');
}

function formatRecommendations(recs) {
  const list = Array.isArray(recs) ? recs : recs.Recommendation || [];
  return list.map(r => {
    const rec = r.recommendation || r;
    return `**From ${rec.recommenderFirstName || ''} ${rec.recommenderLastName || ''}** (${rec.recommendationType || ''}):\n${rec.recommendationBody || rec.text || ''}`;
  }).join('\n\n---\n\n');
}

function formatArticles(articles) {
  const list = Array.isArray(articles) ? articles : articles.Article || [];
  return list.map(a => {
    const art = a.article || a;
    return `# ${art.title || 'Article'}\n\n${art.content || art.description || ''}`;
  }).join('\n\n---\n\n');
}

function parseCsvToText(csv, filename) {
  const lines = csv.split('\n').filter(l => l.trim());
  return `## ${filename.replace('.csv', '')}\n\n${lines.join('\n')}`;
}
