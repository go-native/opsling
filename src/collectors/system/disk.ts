import { promises as fsp } from 'node:fs';
import path from 'node:path';
import si from 'systeminformation';
import type { Config } from '../../config/types.js';
import type { Reading } from '../../types/index.js';
import type { PollCollector } from '../types.js';

const PSEUDO_FS_TYPES = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'devfs',
  'autofs',
  'procfs',
  'sysfs',
  'fusectl',
  'nullfs',
  'mqueue',
  'cgroup',
  'cgroup2',
  'squashfs',
]);

const SKIP_MOUNT_PREFIXES = [
  '/System/Volumes/', // macOS APFS firmlinks (VM, Preboot, Update, xarts, etc.)
  '/private/var/folders/', // macOS App Translocation temp mounts
  '/dev', // device filesystems
  '/proc',
  '/sys',
  '/run',
  '/snap/', // Linux snap mounts
  '/var/lib/docker/', // Docker internal mounts
];

const isInterestingMount = (mount: string): boolean => {
  if (!mount) return false;
  if (mount.includes(' ')) return false; // malformed entries from systeminformation
  return !SKIP_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(p));
};

type FsEntry = Awaited<ReturnType<typeof si.fsSize>>[number];

/**
 * On macOS, '/' is a read-only sealed system snapshot whose "Capacity" doesn't
 * reflect how full the disk actually is — it shows ~50% even when the disk is
 * near full. The writable APFS Data volume mounted at /System/Volumes/Data is
 * where user data lives and reports the real container usage. We substitute
 * its values into the '/' entry so the user sees the number that matches
 * "About This Mac > Storage".
 */
const adjustForMacOs = (filesystems: FsEntry[]): FsEntry[] => {
  if (process.platform !== 'darwin') return filesystems;
  const data = filesystems.find((fs) => fs.mount === '/System/Volumes/Data');
  if (!data || !Number.isFinite(data.use)) return filesystems;
  return filesystems.map((fs) => {
    if (fs.mount !== '/') return fs;
    return { ...fs, use: data.use, used: data.used, available: data.available, size: data.size };
  });
};

interface HostMount {
  device: string;
  mount: string;
  type: string;
}

const parseProcMounts = (content: string): HostMount[] =>
  content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [device = '', mount = '', type = ''] = line.split(/\s+/);
      return { device, mount, type };
    });

const parseMountInfo = (content: string): HostMount[] =>
  content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(' ');
      const dashIdx = parts.indexOf('-');
      if (dashIdx === -1) return null;
      return {
        mount: parts[4] ?? '',
        type: parts[dashIdx + 1] ?? '',
        device: parts[dashIdx + 2] ?? '',
      };
    })
    .filter((m): m is HostMount => m !== null && m.mount !== '');

const readHostMounts = async (hostRoot: string): Promise<HostMount[]> => {
  // Prefer /host/proc/1/mountinfo: host PID 1's view of host mounts, accessible
  // through the bind-mounted host procfs. Fall back to /host/proc/mounts.
  const candidates: Array<{ file: string; parse: (s: string) => HostMount[] }> = [
    { file: path.join(hostRoot, 'proc/1/mountinfo'), parse: parseMountInfo },
    { file: path.join(hostRoot, 'proc/mounts'), parse: parseProcMounts },
  ];
  for (const c of candidates) {
    try {
      const content = await fsp.readFile(c.file, 'utf8');
      return c.parse(content);
    } catch {
      // try next
    }
  }
  return [];
};

const collectHostDisks = async (hostRoot: string, threshold: number): Promise<Reading[]> => {
  const mounts = await readHostMounts(hostRoot);
  const seen = new Set<string>();
  const out: Reading[] = [];
  for (const m of mounts) {
    if (!m.mount || seen.has(m.mount)) continue;
    seen.add(m.mount);
    if (m.type && PSEUDO_FS_TYPES.has(m.type.toLowerCase())) continue;
    if (!isInterestingMount(m.mount)) continue;

    const probePath = m.mount === '/' ? hostRoot : path.join(hostRoot, m.mount);
    try {
      const stat = await fsp.statfs(probePath);
      const totalBytes = stat.blocks * stat.bsize;
      const availBytes = stat.bavail * stat.bsize;
      const usedBytes = totalBytes - availBytes;
      if (totalBytes <= 0) continue;
      const value = Number(((usedBytes / totalBytes) * 100).toFixed(1));
      out.push({
        key: { scope: 'system', metric: `disk:${m.mount}` },
        value,
        threshold,
        unit: '%',
        over: value >= threshold,
        severity: value >= threshold ? 'critical' : 'info',
        message: `High disk usage (${m.mount})`,
        details: {
          mount: m.mount,
          usedGB: Number((usedBytes / 1024 ** 3).toFixed(2)),
          totalGB: Number((totalBytes / 1024 ** 3).toFixed(2)),
        },
        timestamp: new Date(),
      });
    } catch {
      // path not accessible from this container — skip silently
    }
  }
  return out;
};

export const createDiskCollector = (config: Config): PollCollector => ({
  name: 'system.disk',
  intervalMs: config.intervals.diskSeconds * 1000,
  async collect(): Promise<Reading[]> {
    if (config.hostFsRoot) {
      return collectHostDisks(config.hostFsRoot, config.systemThresholds.disk);
    }

    const filesystems = adjustForMacOs(await si.fsSize());
    const threshold = config.systemThresholds.disk;
    const out: Reading[] = [];
    for (const fs of filesystems) {
      if (!fs.mount || !fs.size) continue;
      if (fs.type && PSEUDO_FS_TYPES.has(fs.type.toLowerCase())) continue;
      if (!isInterestingMount(fs.mount)) continue;
      if (!Number.isFinite(fs.use)) continue;

      const value = Number(fs.use.toFixed(1));
      out.push({
        key: { scope: 'system', metric: `disk:${fs.mount}` },
        value,
        threshold,
        unit: '%',
        over: value >= threshold,
        severity: value >= threshold ? 'critical' : 'info',
        message: `High disk usage (${fs.mount})`,
        details: {
          mount: fs.mount,
          usedGB: Number((fs.used / 1024 ** 3).toFixed(2)),
          totalGB: Number((fs.size / 1024 ** 3).toFixed(2)),
        },
        timestamp: new Date(),
      });
    }
    return out;
  },
});
