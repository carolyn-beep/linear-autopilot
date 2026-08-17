// Security helpers: keep secrets out of spawned subprocesses and out of any
// text that gets persisted or echoed (Linear comments, PR bodies, memory.json).

// Keys that always identify a secret, regardless of the generic pattern below.
const EXPLICIT_SECRET_KEYS = ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET', 'GITHUB_TOKEN'];

// Any env key matching this is treated as a secret and scrubbed / redacted.
const SECRET_KEY_PATTERN =
  /TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK_URL|TWILIO|RESEND|SENDGRID|SLACK|DISCORD|GCHAT|ANTHROPIC/i;

function isSecretKey(key: string): boolean {
  return EXPLICIT_SECRET_KEYS.includes(key) || SECRET_KEY_PATTERN.test(key);
}

/**
 * Return a COPY of `base` with known secret keys removed. Safe, non-secret keys
 * (PATH, HOME, USER, SHELL, LANG, TERM, NODE_*, CI, TMPDIR, and anything not
 * matching the secret patterns) are preserved. Use this for the env of any
 * subprocess that runs code the agent may have written.
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isSecretKey(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Replace any secret VALUES pulled from `process.env` (secret-keyed values of
 * length >= 8) with `[REDACTED]`, and mask obvious token / webhook patterns.
 * Apply to any text before it is persisted or echoed to Linear / PRs / memory.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let result = text;

  // Redact actual secret values from the environment.
  const values: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (isSecretKey(key)) {
      values.push(value);
    }
  }
  // Longest first so a value that is a substring of another doesn't leak a tail.
  values.sort((a, b) => b.length - a.length);
  for (const value of values) {
    result = result.split(value).join('[REDACTED]');
  }

  // Mask obvious token / webhook patterns even if not present in env.
  result = result
    .replace(/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
    .replace(/lin_api_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9-]{20,}/g, '[REDACTED]')
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, '[REDACTED]')
    .replace(
      /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]+/g,
      '[REDACTED]'
    );

  return result;
}
