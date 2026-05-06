import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const execFileAsync = promisify(execFile);

async function convertToWav(srcPath: string): Promise<Buffer> {
  const tmpWav = path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}-${process.pid}.wav`);
  try {
    await execFileAsync(
      'ffmpeg',
      ['-i', srcPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );
    return fs.readFileSync(tmpWav);
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* best effort */
    }
  }
}

export async function transcribeAudioFile(srcPath: string): Promise<string | null> {
  const env = readEnvFile(['TRANSCRIPTION_API_KEY', 'TRANSCRIPTION_BASE_URL', 'TRANSCRIPTION_MODEL']);
  const apiKey = env.TRANSCRIPTION_API_KEY;
  const baseURL = env.TRANSCRIPTION_BASE_URL;
  const model = env.TRANSCRIPTION_MODEL || 'whisper-1';

  if (!baseURL) {
    log.warn('TRANSCRIPTION_BASE_URL not set in .env — skipping transcription');
    return null;
  }

  let wavBuffer: Buffer;
  try {
    wavBuffer = await convertToWav(srcPath);
  } catch (err) {
    log.error('ffmpeg conversion failed', { err, srcPath });
    return null;
  }

  const url = `${baseURL.replace(/\/$/, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', model);
  form.append('response_format', 'text');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error('Transcription endpoint returned error', { status: res.status, detail: detail.slice(0, 500) });
      return null;
    }

    // response_format=text → plain string body, not JSON.
    const text = (await res.text()).trim();
    return text || null;
  } catch (err) {
    log.error('Transcription request failed', { err, url });
    return null;
  }
}
