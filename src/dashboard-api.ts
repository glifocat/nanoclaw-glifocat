import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Router, Request, Response } from 'express';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDb,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

// Injected references — set by orchestrator after startup
let queueRef: GroupQueue | null = null;
let channelsRef: Channel[] = [];

/**
 * Called by the orchestrator after startup to inject runtime references.
 * channelsRef is stored as a direct reference (not a copy) so reads are lazy.
 */
export function setDashboardDeps(queue: GroupQueue, channels: Channel[]): void {
  queueRef = queue;
  channelsRef = channels;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryExecFileSync(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function safeJson(res: Response, data: unknown): void {
  res.json(data);
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

/** GET /api/stats */
function handleStats(_req: Request, res: Response): void {
  try {
    const groups = getAllRegisteredGroups();
    const tasks = getAllTasks();
    const chats = getAllChats();
    const sessions = getAllSessions();

    const groupCount = Object.keys(groups).length;
    const activeTasks = tasks.filter((t) => t.status === 'active').length;
    const totalMessages = getDb()
      .prepare('SELECT COUNT(*) as count FROM messages')
      .get() as { count: number };

    // docker ps — count running containers
    let runningContainers = 0;
    try {
      const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
        encoding: 'utf-8',
      });
      runningContainers = out
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0).length;
    } catch {
      // docker not available
    }

    // uptime in seconds
    let uptimeSeconds: number | null = null;
    try {
      const out = execFileSync('sh', ['-c', 'cat /proc/uptime'], {
        encoding: 'utf-8',
      });
      uptimeSeconds = parseFloat(out.trim().split(' ')[0]);
    } catch {
      // /proc/uptime not available (macOS)
      uptimeSeconds = null;
    }

    safeJson(res, {
      groups: groupCount,
      activeTasks,
      totalMessages: totalMessages?.count ?? 0,
      chats: chats.length,
      sessions: Object.keys(sessions).length,
      runningContainers,
      uptimeSeconds,
      queueStatus: queueRef ? queueRef.getStatus() : [],
    });
  } catch (err) {
    logger.error({ err }, 'dashboard /api/stats error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/groups */
function handleGroups(_req: Request, res: Response): void {
  try {
    const groups = getAllRegisteredGroups();
    const chats = getAllChats();
    const sessions = getAllSessions();

    const chatMap = new Map(chats.map((c) => [c.jid, c]));
    const queueStatus = queueRef ? queueRef.getStatus() : [];
    const queueMap = new Map(queueStatus.map((s) => [s.jid, s]));

    const result = Object.entries(groups).map(([jid, group]) => {
      const chat = chatMap.get(jid);
      const queue = queueMap.get(jid);
      return {
        jid,
        name: group.name,
        folder: group.folder,
        trigger: group.trigger,
        added_at: group.added_at,
        requiresTrigger: group.requiresTrigger,
        isMain: group.isMain,
        channel: chat?.channel ?? null,
        lastMessageTime: chat?.last_message_time ?? null,
        sessionId: sessions[group.folder] ?? null,
        active: queue?.active ?? false,
        containerName: queue?.containerName ?? null,
        pendingMessages: queue?.pendingMessages ?? false,
        pendingTasks: queue?.pendingTasks ?? 0,
      };
    });

    safeJson(res, result);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/groups error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/messages?chat_jid=X&limit=50&offset=0 */
function handleMessages(req: Request, res: Response): void {
  try {
    const chatJid = req.query['chat_jid'] as string | undefined;
    const limit = Math.min(
      parseInt((req.query['limit'] as string) || '50', 10),
      500,
    );
    const offset = parseInt((req.query['offset'] as string) || '0', 10);

    let rows: unknown[];
    if (chatJid) {
      rows = getDb()
        .prepare(
          `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
           FROM messages WHERE chat_jid = ?
           ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        )
        .all(chatJid, limit, offset);
    } else {
      rows = getDb()
        .prepare(
          `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
           FROM messages
           ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
    }

    safeJson(res, rows);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/messages error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/tasks */
function handleTasks(_req: Request, res: Response): void {
  try {
    const tasks = getAllTasks();

    const result = tasks.map((task) => {
      const logs = getDb()
        .prepare(
          `SELECT task_id, run_at, duration_ms, status, result, error
           FROM task_run_logs WHERE task_id = ?
           ORDER BY run_at DESC LIMIT 5`,
        )
        .all(task.id);
      return { ...task, recentRuns: logs };
    });

    safeJson(res, result);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/tasks error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/containers */
function handleContainers(_req: Request, res: Response): void {
  try {
    // docker ps with tabular output
    let containers: Array<{
      id: string;
      name: string;
      image: string;
      status: string;
      cpu?: string;
      mem?: string;
    }> = [];

    try {
      const psOut = execFileSync(
        'docker',
        [
          'ps',
          '--format',
          '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}',
        ],
        { encoding: 'utf-8' },
      );

      const lines = psOut.trim().split('\n').filter((l) => l.trim().length > 0);
      containers = lines.map((line) => {
        const [id, name, image, status] = line.split('\t');
        return { id: id ?? '', name: name ?? '', image: image ?? '', status: status ?? '' };
      });

      // docker stats (no-stream) for CPU/mem — best-effort
      if (containers.length > 0) {
        try {
          const statsOut = execFileSync(
            'docker',
            [
              'stats',
              '--no-stream',
              '--format',
              '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
            ],
            { encoding: 'utf-8' },
          );
          const statsMap = new Map<string, { cpu: string; mem: string }>();
          for (const line of statsOut.trim().split('\n')) {
            const [name, cpu, mem] = line.split('\t');
            if (name) statsMap.set(name, { cpu: cpu ?? '', mem: mem ?? '' });
          }
          for (const c of containers) {
            const s = statsMap.get(c.name);
            if (s) {
              c.cpu = s.cpu;
              c.mem = s.mem;
            }
          }
        } catch {
          // stats unavailable — continue without
        }
      }
    } catch {
      // docker not available
    }

    safeJson(res, containers);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/containers error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/channels */
function handleChannels(_req: Request, res: Response): void {
  try {
    const result = channelsRef.map((ch) => ({
      name: ch.name,
      isConnected: ch.isConnected(),
    }));
    safeJson(res, result);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/channels error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/skills */
function handleSkills(_req: Request, res: Response): void {
  try {
    let local: string[] = [];
    let remote: string[] = [];

    try {
      // local branches that start with "skill/"
      const localOut = tryExecFileSync('git', [
        'branch',
        '--list',
        'skill/*',
        '--format',
        '%(refname:short)',
      ]);
      local = localOut
        .trim()
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

      // remote branches that start with "skill/"
      const remoteOut = tryExecFileSync('git', [
        'branch',
        '-r',
        '--list',
        '*/skill/*',
        '--format',
        '%(refname:short)',
      ]);
      remote = remoteOut
        .trim()
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
    } catch {
      // .git directory doesn't exist (tarball/Docker deployment)
    }

    safeJson(res, { local, remote });
  } catch (err) {
    logger.error({ err }, 'dashboard /api/skills error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/activity */
function handleActivity(req: Request, res: Response): void {
  try {
    const limit = Math.min(
      parseInt((req.query['limit'] as string) || '100', 10),
      500,
    );
    const logFile = path.join(process.cwd(), 'logs', 'nanoclaw.log');

    if (!fs.existsSync(logFile)) {
      safeJson(res, []);
      return;
    }

    // Read last N lines from the log file
    let lines: string[] = [];
    try {
      const tailOut = execFileSync('tail', ['-n', String(limit), logFile], {
        encoding: 'utf-8',
      });
      lines = tailOut
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0);
    } catch {
      safeJson(res, []);
      return;
    }

    // Parse pino JSON lines — skip malformed lines
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);

    safeJson(res, events);
  } catch (err) {
    logger.error({ err }, 'dashboard /api/activity error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/config */
function handleConfig(_req: Request, res: Response): void {
  try {
    safeJson(res, {
      assistantName: ASSISTANT_NAME,
      containerTimeout: CONTAINER_TIMEOUT,
      idleTimeout: IDLE_TIMEOUT,
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
      timezone: TIMEZONE,
      storeDir: STORE_DIR,
      credentialProxyPort: CREDENTIAL_PROXY_PORT,
    });
  } catch (err) {
    logger.error({ err }, 'dashboard /api/config error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createDashboardRouter(): Router {
  const router = Router();

  router.get('/api/stats', handleStats);
  router.get('/api/groups', handleGroups);
  router.get('/api/messages', handleMessages);
  router.get('/api/tasks', handleTasks);
  router.get('/api/containers', handleContainers);
  router.get('/api/channels', handleChannels);
  router.get('/api/skills', handleSkills);
  router.get('/api/activity', handleActivity);
  router.get('/api/config', handleConfig);

  return router;
}
