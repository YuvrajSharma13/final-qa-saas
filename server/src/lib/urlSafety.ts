import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { HttpError } from './http.js';

// SSRF guard: in multi-tenant production the QA runner must not be pointed at
// internal infrastructure. Local development can opt in with ALLOW_PRIVATE_TARGETS.
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.');
}

export function normalizeAppUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Application URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Application URL must use http or https');
  if (u.username || u.password) throw new HttpError(400, 'Do not embed credentials in the application URL');
  u.hash = '';
  return u.toString();
}

export async function assertTargetAllowed(raw: string): Promise<void> {
  if (config.allowPrivateTargets) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new HttpError(400, 'Private/internal hosts are not allowed on this server');
  }
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new HttpError(400, `Could not resolve host ${host}`);
  if (addrs.some(isPrivateIp)) throw new HttpError(400, 'Private/internal network targets are not allowed on this server');
}

export { isPrivateIp };
