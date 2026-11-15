const legacySecureSslModes = new Set(['prefer', 'require', 'verify-ca'])
const disableSslModes = new Set(['disable'])

export function normalizeDatabaseUrl(
  connectionString: string,
  options: { vercel: boolean; requireSsl: boolean },
): string {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.')
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol.')
  }

  const sslMode = url.searchParams.get('sslmode')?.toLowerCase()
  const requireVerifiedSsl = options.vercel || options.requireSsl

  if (sslMode === 'no-verify' || (requireVerifiedSsl && sslMode && disableSslModes.has(sslMode))) {
    throw new Error('DATABASE_URL must use certificate-verified TLS (sslmode=verify-full).')
  }

  if (legacySecureSslModes.has(sslMode || '') || (requireVerifiedSsl && !sslMode)) {
    url.searchParams.set('sslmode', 'verify-full')
  }

  return url.toString()
}
