import axios from 'axios';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

// Tags to remove before text extraction (nav, ads, footers, scripts etc.)
const NOISE_SELECTORS = [
  'script', 'style', 'nav', 'header', 'footer', 'aside',
  '.sidebar', '.advertisement', '.ad', '.cookie-banner',
  '.newsletter-signup', '[role="banner"]', '[role="navigation"]',
];

export async function extractUrl(source) {
  const { url } = source;
  if (!url) throw new Error('URL extractor requires a url');

  const { data: html, headers } = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DecentralThinkBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    maxContentLength: 10 * 1024 * 1024, // 10MB max
  });

  const $ = cheerio.load(html);

  // Extract metadata
  const title       = $('title').text().trim() || $('h1').first().text().trim();
  const description = $('meta[name="description"]').attr('content') || '';
  const author      = $('meta[name="author"]').attr('content') || '';
  const published   = $('meta[property="article:published_time"]').attr('content') || '';

  // Remove noise
  NOISE_SELECTORS.forEach(sel => $(sel).remove());

  // Try to find the main content area
  const mainSelectors = ['article', 'main', '[role="main"]', '.post-content',
                          '.article-body', '.entry-content', '#content', 'body'];
  let contentHtml = '';
  for (const sel of mainSelectors) {
    if ($(sel).length) { contentHtml = $(sel).html(); break; }
  }

  // Convert to clean markdown
  const markdown = td.turndown(contentHtml || $.html());
  const text = markdown.replace(/\n{3,}/g, '\n\n').trim();

  return {
    text,
    metadata: { url, title, description, author, published, format: 'url' },
    contentType: 'url',
  };
}
