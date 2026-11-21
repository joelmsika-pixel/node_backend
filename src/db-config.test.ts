import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDatabaseUrl } from './db-config.js'

const connectionUrl = 'postgresql://user:password@db.example/app?application_name=api'

test('upgrades legacy SSL modes to hostname-verified TLS', () => {
  for (const sslmode of ['prefer', 'require', 'verify-ca']) {
    const result = normalizeDatabaseUrl(
      `${connectionUrl}&sslmode=${sslmode}`,
      { vercel: false, requireSsl: false },
    )
    assert.equal(new URL(result).searchParams.get('sslmode'), 'verify-full')
  }
})

test('requires verified TLS for Vercel URLs without an SSL mode', () => {
  const result = normalizeDatabaseUrl(connectionUrl, { vercel: true, requireSsl: false })
  assert.equal(new URL(result).searchParams.get('sslmode'), 'verify-full')
})

test('rejects disabled SSL when required and rejects no-verify in every environment', () => {
  for (const sslmode of ['disable', 'no-verify']) {
    assert.throws(
      () => normalizeDatabaseUrl(
        `${connectionUrl}&sslmode=${sslmode}`,
        { vercel: sslmode === 'disable', requireSsl: false },
      ),
      /certificate-verified TLS/,
    )
  }
})

test('preserves local non-TLS URLs when SSL is not requested', () => {
  assert.equal(
    normalizeDatabaseUrl(connectionUrl, { vercel: false, requireSsl: false }),
    connectionUrl,
  )
})
