/**
 * Transcription module — channel-agnostic voice-note → text.
 *
 * Registers a router preprocessor that scans inbound messages for
 * attachments tagged `isVoiceNote: true`, runs each through ffmpeg + an
 * OpenAI-compatible /v1/audio/transcriptions endpoint, and prepends
 * `[Voice: <transcript>]` to the message text so the agent sees it.
 *
 * Channel adapters opt in by tagging the attachment — there is no
 * channel-specific code in this module.
 *
 * `event.message.content` is a JSON string at this point in the pipeline
 * (stringified by src/index.ts before routeInbound), so the preprocessor
 * parses, mutates, and re-stringifies in place.
 */
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { setMessagePreprocessor } from '../../router.js';
import { transcribeAudioFile } from './transcribe.js';

interface Attachment {
  type?: string;
  name?: string;
  localPath?: string;
  isVoiceNote?: boolean;
  transcript?: string;
}

const FALLBACK_TEXT = '[Voice Message - transcription failed]';

setMessagePreprocessor(async (event) => {
  if (typeof event.message.content !== 'string') return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.message.content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;

  const attachments = parsed.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return;

  const voiceNotes = (attachments as Attachment[]).filter(
    (a) => a && a.isVoiceNote === true && typeof a.localPath === 'string',
  );
  if (voiceNotes.length === 0) return;

  const transcripts: string[] = [];
  for (const att of voiceNotes) {
    const abs = path.join(DATA_DIR, att.localPath as string);
    const transcript = await transcribeAudioFile(abs);
    if (transcript) {
      att.transcript = transcript;
      transcripts.push(`[Voice: ${transcript}]`);
      log.info('Transcribed voice note', { length: transcript.length, name: att.name });
    } else {
      transcripts.push(FALLBACK_TEXT);
    }
  }

  const existingText = typeof parsed.text === 'string' ? parsed.text : '';
  const joined = transcripts.join(' ');
  parsed.text = existingText ? `${joined} ${existingText}` : joined;

  // Re-serialize so downstream sees the enriched content.
  event.message.content = JSON.stringify(parsed);
});
