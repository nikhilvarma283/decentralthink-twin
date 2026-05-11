import axios from 'axios';
import { logger } from '../../lib/logger.js';

/**
 * GitHub extractor
 *
 * Extracts knowledge from a GitHub repository:
 *   - README files (primary source)
 *   - Code comments (captures the person's technical reasoning)
 *   - Commit messages (captures decision history)
 *   - Wiki pages (if public)
 *   - Issue/PR descriptions authored by the owner
 *
 * Does NOT extract raw code as training data — code without context
 * doesn't represent the person's knowledge the way comments and docs do.
 */
export async function extractGithub(source) {
  const { url } = source;
  if (!url) throw new Error('GitHub extractor requires a url');

  const match = url.match(/github\.com\/([^/]+)\/([^/?\s]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);

  const [, owner, repo] = match;
  const headers = {};
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const sections = [];
  const metadata = { owner, repo, url, format: 'github' };

  // ── README ──────────────────────────────────────────────────────────────────
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      { headers, timeout: 10000 }
    );
    const readme = Buffer.from(data.content, 'base64').toString('utf-8');
    sections.push(`# README — ${repo}\n\n${readme}`);
    logger.info({ owner, repo }, 'GitHub README extracted');
  } catch (e) {
    logger.warn({ owner, repo, err: e.message }, 'No README found');
  }

  // ── Recent commit messages ───────────────────────────────────────────────────
  try {
    const { data: commits } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=50`,
      { headers, timeout: 10000 }
    );
    const messages = commits
      .map(c => c.commit?.message?.trim())
      .filter(m => m && m.length > 20 && !m.startsWith('Merge'));

    if (messages.length) {
      sections.push(`# Commit History — ${repo}\n\n${messages.map(m => `- ${m}`).join('\n')}`);
      metadata.commitCount = messages.length;
    }
  } catch (e) {
    logger.warn({ owner, repo, err: e.message }, 'Could not fetch commits');
  }

  // ── Issues and PRs authored by owner ─────────────────────────────────────────
  try {
    const { data: issues } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues?creator=${owner}&state=all&per_page=30`,
      { headers, timeout: 10000 }
    );
    const issueTexts = issues
      .map(i => `## ${i.title}\n${i.body || ''}`)
      .filter(t => t.length > 50);

    if (issueTexts.length) {
      sections.push(`# Issues & PRs — ${repo}\n\n${issueTexts.join('\n\n---\n\n')}`);
      metadata.issueCount = issueTexts.length;
    }
  } catch (e) {
    logger.warn({ owner, repo, err: e.message }, 'Could not fetch issues');
  }

  // ── Docs folder (if present) ──────────────────────────────────────────────
  try {
    const { data: tree } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      { headers, timeout: 10000 }
    );
    const docFiles = tree.tree?.filter(f =>
      f.type === 'blob' &&
      (f.path.startsWith('docs/') || f.path.startsWith('wiki/')) &&
      (f.path.endsWith('.md') || f.path.endsWith('.txt'))
    ).slice(0, 10) || [];

    for (const file of docFiles) {
      try {
        const { data: content } = await axios.get(
          `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file.path}`,
          { headers, timeout: 5000 }
        );
        sections.push(`# ${file.path}\n\n${content}`);
      } catch {}
    }
    metadata.docFileCount = docFiles.length;
  } catch {}

  const text = sections.join('\n\n===\n\n');
  return { text, metadata, contentType: 'github' };
}
