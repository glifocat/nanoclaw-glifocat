/**
 * Cross-platform detection utilities for NanoClaw setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'none';
export type EncryptedHomeType = 'ecryptfs' | 'fscrypt' | 'gocryptfs';

export interface EncryptedHomeDetection {
  detected: boolean;
  type?: EncryptedHomeType;
  /** Human-readable signal that triggered detection (used in warnings/logs). */
  signal?: string;
}

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // Try xdg-open first, then wslview for WSL
      if (commandExists('xdg-open')) {
        execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      // WSL without wslview: try cmd.exe
      if (isWSL()) {
        try {
          execSync(`cmd.exe /c start "" ${JSON.stringify(url)}`, {
            stdio: 'ignore',
          });
          return true;
        } catch {
          // cmd.exe not available
        }
      }
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  return 'none';
}

export function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}

/**
 * Detect whether $HOME is on per-user-encrypted storage that only gets
 * decrypted at PAM login (ecryptfs, fscrypt, gocryptfs).
 *
 * Block-device encryption (LUKS / dm-crypt) is intentionally NOT a trigger:
 * those volumes are decrypted before userspace and don't break user systemd
 * at boot. See issue #2680 for the failure mode this detection guards.
 *
 * fscrypt is per-directory with no mount entry and no universal marker file,
 * so we rely on the `fscrypt` CLI when present. If it isn't installed, we
 * skip fscrypt detection; there is no safe lightweight probe without it.
 */
export function detectEncryptedHome(
  homeDir: string = os.homedir(),
): EncryptedHomeDetection {
  if (getPlatform() !== 'linux') return { detected: false };

  // findmnt: catches ecryptfs and fuse.gocryptfs cleanly via the mount table.
  try {
    const fstype = execSync(
      `findmnt -n -T ${JSON.stringify(homeDir)} -o FSTYPE`,
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
    if (fstype === 'ecryptfs') {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `findmnt reports FSTYPE=ecryptfs for ${homeDir}`,
      };
    }
    if (fstype === 'fuse.gocryptfs') {
      return {
        detected: true,
        type: 'gocryptfs',
        signal: `findmnt reports FSTYPE=fuse.gocryptfs for ${homeDir}`,
      };
    }
  } catch {
    // findmnt missing or no mount row; fall through to other probes.
  }

  // ecryptfs marker directories: present on the classic Ubuntu encrypted-home
  // setup even when findmnt is unavailable.
  try {
    if (fs.existsSync(path.join(homeDir, '.ecryptfs'))) {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `${homeDir}/.ecryptfs exists`,
      };
    }
    if (fs.existsSync(path.join(homeDir, '.Private'))) {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `${homeDir}/.Private exists`,
      };
    }
  } catch {
    // fs probe failed; ignore.
  }

  // fscrypt: only reliable detection is the fscrypt CLI. The issue body
  // specifically warns against marker-file heuristics, and rolling a raw
  // FS_IOC_GET_ENCRYPTION_POLICY ioctl from Node isn't trivial.
  if (commandExists('fscrypt')) {
    try {
      const out = execSync(`fscrypt status ${JSON.stringify(homeDir)}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      // `fscrypt status DIR` exits 0 on encrypted dirs and prints lines like
      // "Policy: ..." / "Unlocked: Yes". Match a couple of fscrypt-specific
      // tokens rather than the generic word "encrypted" to avoid false
      // positives on help text.
      if (/policy\s*:/i.test(out) || /unlocked\s*:/i.test(out)) {
        return {
          detected: true,
          type: 'fscrypt',
          signal: `fscrypt status reports an encryption policy on ${homeDir}`,
        };
      }
    } catch {
      // Non-zero exit means no fscrypt policy on this dir; ignore.
    }
  }

  return { detected: false };
}
