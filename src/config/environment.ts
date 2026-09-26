/**
 * Environment strictness, shared by every security-relevant default.
 *
 * Only `development` and `test` are "lax" environments (dev fallback secrets,
 * raw error messages, open /metrics, Swagger on by default, default seed
 * passwords). Everything else - production, staging, or any unrecognised
 * value - is "strict": secrets are mandatory and nothing internal is exposed.
 *
 * An unset NODE_ENV counts as `development`, matching the default of the
 * NODE_ENV rule in env.validation.ts (deployments always set NODE_ENV; the
 * Dockerfile sets NODE_ENV=production).
 */
const LAX_ENVIRONMENTS = new Set(['development', 'test']);

export function isStrictEnv(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const value = nodeEnv?.trim();
  if (!value) return false;
  return !LAX_ENVIRONMENTS.has(value);
}
