---
name: add-voice-transcription
description: Add voice-note transcription to NanoClaw. Channel-agnostic — any adapter that tags an audio attachment with `isVoiceNote: true` gets transcription for free. Uses any OpenAI-compatible /v1/audio/transcriptions endpoint (Parakeet, Whisper, Canary, self-hosted Speaches, OpenAI itself, etc.). Native fetch — no SDK dependency.
---

# Add Voice Transcription

Adds a host-side transcription module to NanoClaw. Voice notes arrive as attachments tagged `isVoiceNote: true`; a router preprocessor scans every inbound message, runs flagged attachments through `ffmpeg` → an OpenAI-compatible transcription endpoint, and prepends `[Voice: <transcript>]` to the message text before the agent sees it.

The module ships with a WhatsApp opt-in (PTT messages auto-tagged). Other channels opt in by setting the same flag on their audio attachments — no transcription code per channel.

## Prerequisites

- `ffmpeg` installed on the host. Audio is normalized to 16 kHz mono WAV before upload, which works with every OpenAI-compatible endpoint regardless of input codec.
- A reachable OpenAI-compatible `/v1/audio/transcriptions` endpoint. Self-hosted (Parakeet via Speaches, faster-whisper-server, Canary), or hosted (OpenAI itself).

```bash
# Linux
sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
```

Verify: `ffmpeg -version >/dev/null 2>&1 && echo OK || echo MISSING`

## Phase 1: Pre-flight (idempotent)

Skip to Phase 3 (Configure) if all of these are already in place:

- `src/modules/transcription/transcribe.ts` exists
- `src/modules/transcription/index.ts` exists
- `src/modules/index.ts` contains `import './transcription/index.js';`
- `src/router.ts` contains `MODULE-HOOK:preprocessor`
- `src/channels/whatsapp.ts` (if installed) tags `audioMessage` with `ptt === true` as `isVoiceNote: true` inside `downloadInboundMedia`

Otherwise continue. Every step below is safe to re-run.

## Phase 2: Apply Code Changes

### 1. Drop in the module files

The skill ships the source under `files/`. Copy both files into `src/modules/transcription/`:

```bash
mkdir -p src/modules/transcription
cp .claude/skills/add-voice-transcription/files/transcribe.ts src/modules/transcription/transcribe.ts
cp .claude/skills/add-voice-transcription/files/index.ts      src/modules/transcription/index.ts
```

### 2. Patch `src/router.ts` — add preprocessor hook

If `src/router.ts` does not contain `MODULE-HOOK:preprocessor`, use Edit to add the hook:

**Add right after the `setMessageInterceptor` definition** (search for `export function setMessageInterceptor`):

```typescript
/**
 * Pre-route preprocessor hook. Runs after the interceptor and before agent
 * resolution. Allowed to mutate `event.message.content` in place — used by
 * modules that enrich the payload (e.g. transcription expanding a voice-note
 * attachment into text). Errors are swallowed so a failing preprocessor
 * never blocks routing.
 */
export type MessagePreprocessorFn = (event: InboundEvent) => Promise<void>;

let messagePreprocessor: MessagePreprocessorFn | null = null;

export function setMessagePreprocessor(fn: MessagePreprocessorFn): void {
  if (messagePreprocessor) {
    log.warn('Message preprocessor overwritten');
  }
  messagePreprocessor = fn;
}
```

**And inside `routeInbound`, right after the existing `messageInterceptor` call**, add:

```typescript
  // MODULE-HOOK:preprocessor — mutate event.message.content (e.g. transcription).
  if (messagePreprocessor) {
    try {
      await messagePreprocessor(event);
    } catch (err) {
      log.warn('Message preprocessor threw', { err });
    }
  }
```

### 3. Wire into the modules barrel

Append to `src/modules/index.ts` (skip if already present):

```typescript
import './transcription/index.js';
```

### 4. Tag voice notes in installed channel adapters

Each channel adapter that supports audio must mark voice notes. The WhatsApp adapter ships with this opt-in already if you re-run `/add-whatsapp` from the latest `channels` branch. Otherwise patch `src/channels/whatsapp.ts:downloadInboundMedia` so the `audioMessage` push (`{ type, name, localPath }`) gets an `isVoiceNote: true` field when `normalized.audioMessage.ptt === true`.

For other adapters, follow the same pattern — at the point where you push an audio attachment into the result array, set `isVoiceNote: true` if and only if the platform's data model says it's a push-to-talk / voice-note (not a generic audio file upload):

| Channel | Voice-note signal |
|---------|-------------------|
| WhatsApp (Baileys) | `audioMessage.ptt === true` |
| Telegram | event has a `voice` field (vs `audio`) |
| Signal | `attachment.voiceNote === true` |
| Discord | flags include `IS_VOICE_MESSAGE` (1 << 13) |
| Matrix | `m.audio` event with `org.matrix.msc3245.voice` content key |
| iMessage | not exposed as a separate kind — usually fine to skip |

Adapters that don't tag are simply not transcribed. Nothing else has to change.

### 5. Build

```bash
pnpm run build
```

Expect zero compile errors. The module uses only Node-native `fetch` / `FormData` / `Blob` — no new npm dependency.

## Phase 3: Configure

### Collect endpoint details

Use `AskUserQuestion` to ask:
- **Base URL** — including `/v1`. Examples: `http://192.168.8.151:8301/v1` (self-hosted Parakeet), `https://api.openai.com/v1` (OpenAI).
- **Model name** — what the endpoint expects. Examples: `parakeet-tdt-0.6b-v3`, `Systran/faster-whisper-base`, `whisper-1`.
- **API key** — only if the endpoint requires one. Most self-hosted setups don't.

### Append to `.env`

```bash
# Voice transcription
TRANSCRIPTION_BASE_URL=<from-user>
TRANSCRIPTION_MODEL=<from-user>
# Optional — only if the endpoint authenticates:
# TRANSCRIPTION_API_KEY=<from-user>
```

These are read at request time by `readEnvFile` from the project's `.env` — there is no `data/env/env` sync in v2.

### Restart the host

```bash
# Linux
systemctl --user restart nanoclaw-v2-*
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Send a voice note in any wired chat. The agent should receive a message whose text starts with `[Voice: <transcript>]`. The original `.ogg` attachment is still passed through, so a future audio tool could re-listen if needed.

### Logs

```bash
tail -f logs/nanoclaw.log | grep -i 'voice\|transcrib\|TRANSCRIPTION'
```

Look for:
- `Transcribed voice note` — success, with character count.
- `TRANSCRIPTION_BASE_URL not set` — env var missing.
- `Transcription endpoint returned error` — endpoint reachable but rejected the request (wrong model, etc.). The `detail` field has the body.
- `Transcription request failed` — network/connect failure.
- `ffmpeg conversion failed` — codec or path issue.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSCRIPTION_BASE_URL` | *(required)* | Base URL of the transcription endpoint, including `/v1` |
| `TRANSCRIPTION_MODEL` | `whisper-1` | Model name the endpoint expects |
| `TRANSCRIPTION_API_KEY` | *(unset → no auth header sent)* | Bearer token, if the endpoint requires it |

### Example configurations

**Parakeet TDT (self-hosted via Speaches, recommended for Spanish):**
```
TRANSCRIPTION_BASE_URL=http://192.168.8.151:8301/v1
TRANSCRIPTION_MODEL=parakeet-tdt-0.6b-v3
```

**Whisper via faster-whisper-server / Speaches:**
```
TRANSCRIPTION_BASE_URL=http://192.168.8.151:8300/v1
TRANSCRIPTION_MODEL=Systran/faster-whisper-base
```

**OpenAI Whisper:**
```
TRANSCRIPTION_BASE_URL=https://api.openai.com/v1
TRANSCRIPTION_MODEL=whisper-1
TRANSCRIPTION_API_KEY=sk-...
```

## Troubleshooting

### Voice notes are not transcribed

1. Check `TRANSCRIPTION_BASE_URL` is set in `.env`.
2. Verify the endpoint is reachable from the host: `curl -fsS "$TRANSCRIPTION_BASE_URL/models"` (self-hosted) — most expose a model list.
3. Confirm the channel adapter is tagging the attachment. Search the inbound logs for the audio attachment line and check whether `isVoiceNote` is logged.

### `[Voice Message - transcription failed]` appears

The audio download succeeded but the endpoint rejected it. Check `logs/nanoclaw.log` for the `status` and `detail` fields. Most common: model name typo, ffmpeg producing an unsupported sample rate (the module forces 16 kHz mono so this is rare), or a stale endpoint.

### Transcription works but the agent ignores the text

`[Voice: …]` is plain text — the agent treats it like any other message. If the agent isn't responding, the issue is upstream of transcription (trigger rules, agent wiring, isolation level). Use `/debug`.
