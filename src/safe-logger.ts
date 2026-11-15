const sensitiveEnvironmentKeys = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'DB_PASSWORD',
  'PGPASSWORD',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SMTP_PASSWORD',
  'SMTP_PASS',
  'MAIL_PASSWORD',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'JWT_SECRET',
]

function redactSensitiveValues(value: string): string {
  let redacted = value
  for (const key of sensitiveEnvironmentKeys) {
    const secret = process.env[key]
    if (secret) redacted = redacted.split(secret).join('[REDACTED]')
  }

  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(password|passwd|secret(?:_access_key)?|access[_-]?key(?:[_-]?id)?|token|authorization|credential|signature)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
}

export function logError(event: string, error: unknown): void {
  const candidate = error as {
    name?: unknown
    message?: unknown
    stack?: unknown
    code?: unknown
  } | null
  const message = typeof candidate?.message === 'string'
    ? candidate.message
    : typeof error === 'string'
      ? error
      : String(error)
  const name = typeof candidate?.name === 'string' ? candidate.name : 'Error'
  const stack = typeof candidate?.stack === 'string' ? candidate.stack : undefined
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined

  console.error(JSON.stringify({
    event: redactSensitiveValues(event),
    error: {
      name: redactSensitiveValues(name),
      message: redactSensitiveValues(message),
      ...(code ? { code: redactSensitiveValues(code) } : {}),
      ...(stack ? { stack: redactSensitiveValues(stack) } : {}),
    },
  }))
}
