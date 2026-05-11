import { YoutubeTranscript } from 'youtube-transcript';
import axios from 'axios';
import { logger } from '../../lib/logger.js';

/**
 * YouTube extractor.
 *
 * Strategy:
 *   1. Try official transcript/captions via youtube-transcript (fast, free)
 *   2. If no captions, fall back to Whisper via Ollama (transcribes audio)
 *
 * The fallback requires yt-dlp installed in the container — see Dockerfile.
 */
export async function extractYoutube(source) {
  const { url } = source;
  if (!url) throw new Error('YouTube extractor requires a url');

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error(`Could not extract video ID from: ${url}`);

  // ── Strategy 1: Official transcript ────────────────────────────────────────
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    const text = transcript.map(t => t.text).join(' ').trim();

    if (text.length > 100) {
      logger.info({ videoId }, 'YouTube transcript extracted via captions');
      return {
        text,
        metadata: { url, videoId, method: 'captions', format: 'youtube' },
        contentType: 'youtube',
      };
    }
  } catch (captionErr) {
    logger.warn({ videoId, err: captionErr.message }, 'No captions — falling back to Whisper');
  }

  // ── Strategy 2: Whisper via Ollama (requires yt-dlp in container) ──────────
  try {
    const audioBuffer = await downloadYoutubeAudio(videoId);
    const text = await transcribeWithWhisper(audioBuffer);
    logger.info({ videoId }, 'YouTube audio transcribed via Whisper');
    return {
      text,
      metadata: { url, videoId, method: 'whisper', format: 'youtube' },
      contentType: 'youtube',
    };
  } catch (whisperErr) {
    throw new Error(`YouTube extraction failed for ${videoId}: ${whisperErr.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([^&#]+)/,
    /youtu\.be\/([^?&#]+)/,
    /\/shorts\/([^?&#]+)/,
    /\/embed\/([^?&#]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function downloadYoutubeAudio(videoId) {
  // Uses yt-dlp (must be installed in container)
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { readFile, unlink } = await import('fs/promises');
  const { v4: uuidv4 } = await import('uuid');

  const tmpPath = join(tmpdir(), `${uuidv4()}.mp3`);
  try {
    await exec('yt-dlp', [
      `https://www.youtube.com/watch?v=${videoId}`,
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '5',
      '-o', tmpPath,
      '--no-playlist',
    ]);
    const buffer = await readFile(tmpPath);
    return buffer;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

async function transcribeWithWhisper(audioBuffer) {
  // Whisper via Ollama if available, otherwise OpenAI Whisper API
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';

  try {
    // Try Ollama whisper endpoint
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper');

    const { data } = await axios.post(`${ollamaUrl}/api/whisper`, form, {
      headers: form.getHeaders(),
      timeout: 300000, // 5 min for long videos
    });
    return data.text || data.transcript || '';
  } catch {
    // OpenAI Whisper fallback (if OPENAI_API_KEY is set)
    if (process.env.OPENAI_API_KEY) {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      form.append('model', 'whisper-1');

      const { data } = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 300000,
      });
      return data.text || '';
    }
    throw new Error('No Whisper service available. Set OPENAI_API_KEY or run Ollama with whisper model.');
  }
}
