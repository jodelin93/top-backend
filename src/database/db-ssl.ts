import type { TlsOptions } from 'node:tls';

/**
 * TLS to the database. DB_SSL=true encrypts the connection; the server's
 * certificate is checked against DB_SSL_CA (PEM; "\n" for line breaks in one
 * variable), or against the system's authorities with
 * DB_SSL_REJECT_UNAUTHORIZED=true. Without either, the connection is encrypted
 * but the certificate is not checked (Railway's public proxy uses a
 * self-signed one): prefer the private network or a CA in production.
 */
export function dbSsl(
  env: Record<string, string | undefined>,
): false | TlsOptions {
  if (env.DB_SSL !== 'true') return false;
  const ca = env.DB_SSL_CA?.replace(/\\n/g, '\n').trim();
  if (ca) return { ca, rejectUnauthorized: true };
  return { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED === 'true' };
}
