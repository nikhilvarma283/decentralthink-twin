import axios from 'axios';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import FormData from 'form-data';
import { logger } from '../../lib/logger.js';

/**
 * Audio/Video extractor → Whisper transcription
 *
 * Supports: .mp3 .wav .m4a .ogg .flac .mp4 .mov .webm .avi
 * For video files, audio is extracted via ffmpeg before transcription.
 */
export async function extractAudioVideo(source, type = 'audio') {
  if (!source.buffer) throw new Error('Audio/Video extractor requires a file buffer');

  let audioBuffer = source.buffer;

  // For video files, extract audio track via ffmpeg
  if (type === 'video') {
    audioBuffer = await extractAudioTrack(source.buffer, source.filename);
  }

  const text = await transcribeWithWhisper(audioBuffer, source.filename);

  return {
    text,
    metadata: {
      filename: source.filename,
      format: type,
      method: 'whisper',
      durationEstimate: `~${Math.round(audioBuffer.length / (16000 * 2))}s`,
    },
    contentType: type,
  };
}

// ─── FFmpeg audio extraction from video ───────────────────────────────────────

async function extractAudioTrack(videoBuffer, filename = 'video.mp4') {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const exec = promisify(execFile);

  const tmpIn  = join(tmpdir(), `${uuidv4()}_in.mp4`);
  const tmpOut = join(tmpdir(), `${uuidv4()}_out.mp3`);

  try {
    await writeFile(tmpIn, videoBuffer);
    await exec('ffmpeg', [
      '-i', tmpIn,
      '-vn',                    // no video
      '-acodec', 'libmp3lame',
      '-ar', '16000',           // 16kHz sample rate (Whisper optimal)
      '-ac', '1',               // mono
      '-b:a', '64k',
      tmpOut, '-y',
    ]);
    const { readFile } = await import('fs/promises');
    return await readFile(tmpOut);
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

// ─── Whisper transcription ────────────────────────────────────────────────────

async function transcribeWithWhisper(audioBuffer, filename = 'audio.mp3') {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama:11434';

  try {
    // Try Ollama Whisper
    const form = new FormData();
    form.append('file', audioBuffer, { filename, contentType: 'audio/mpeg' });
    form.append('model', 'whisper');

    const { data } = await axios.post(`${ollamaUrl}/api/whisper`, form, {
      headers: form.getHeaders(),
      timeout: 600000, // 10 min for long recordings
    });
    logger.info({ filename }, 'Transcribed via Ollama Whisper');
    return data.text || data.transcript || '';
  } catch (ollamaErr) {
    logger.warn({ err: ollamaErr.message }, 'Ollama Whisper unavailable, trying OpenAI');

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('No transcription service available. Add OPENAI_API_KEY to .env or run Ollama with whisper model.');
    }

    const form = new FormData();
    form.append('file', audioBuffer, { filename, contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const { data } = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 600000,
    });
    logger.info({ filename }, 'Transcribed via OpenAI Whisper');
    return typeof data === 'string' ? data : data.text || '';
  }
}
