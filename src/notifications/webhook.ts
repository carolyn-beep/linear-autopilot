// Shared webhook request utility for notification providers

import { logger } from '../logger';

// Hostnames we explicitly trust for outbound notification webhooks.
const ALLOWED_HOSTS = new Set([
  'hooks.slack.com',
  'discord.com',
  'discordapp.com',
  'chat.googleapis.com',
]);

// The cloud metadata service address (commonly abused via SSRF).
const METADATA_IP = '169.254.169.254';

// Determine whether a hostname points at a private, loopback, or link-local address.
// NOTE: This is a hostname/scheme check only. It does NOT resolve DNS, so full
// DNS-rebinding protection is out of scope here; a scheme + host check is sufficient
// for the tenant-configured URLs this utility handles.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Strip IPv6 brackets if present.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::).
  if (bare === '::1') return true;
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // fc00::/7
  if (bare.startsWith('fe80:')) return true;

  // Explicit metadata IP.
  if (bare === METADATA_IP) return true;

  // IPv4 private / loopback / link-local ranges.
  if (bare === '0.0.0.0') return true;
  if (bare.startsWith('127.')) return true; // loopback
  if (bare.startsWith('10.')) return true; // private
  if (bare.startsWith('192.168.')) return true; // private
  if (bare.startsWith('169.254.')) return true; // link-local (includes metadata IP)

  // 172.16.0.0 - 172.31.255.255 private range.
  const match = bare.match(/^172\.(\d+)\./);
  if (match) {
    const second = parseInt(match[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

// Validate a webhook URL before making an outbound request (SSRF protection).
// Throws if the URL is not an allowed https public endpoint.
function validateWebhookUrl(url: string, serviceName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.error('Invalid webhook URL', { service: serviceName });
    throw new Error(`${serviceName} webhook rejected: invalid URL`);
  }

  if (parsed.protocol !== 'https:') {
    logger.error('Blocked non-https webhook URL', {
      service: serviceName,
      protocol: parsed.protocol,
    });
    throw new Error(`${serviceName} webhook rejected: only https URLs are allowed`);
  }

  // Allowlisted hosts are trusted directly.
  if (ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return parsed;
  }

  // Otherwise allow public https hosts but block private/loopback/link-local targets.
  if (isBlockedHost(parsed.hostname)) {
    logger.error('Blocked webhook URL targeting private/loopback address', {
      service: serviceName,
      hostname: parsed.hostname,
    });
    throw new Error(`${serviceName} webhook rejected: host is not allowed`);
  }

  return parsed;
}

export async function sendWebhook(
  url: string,
  payload: object,
  serviceName: string
): Promise<void> {
  validateWebhookUrl(url, serviceName);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`${serviceName} webhook failed: ${response.status} ${text}`);
  }
}
