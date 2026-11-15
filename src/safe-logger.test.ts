import assert from 'node:assert/strict'
import { test } from 'node:test'
import { logError } from './safe-logger.js'

test('logs full error stacks while redacting credentials and bearer tokens', () => {
  const previousPassword = process.env.DB_PASSWORD
  process.env.DB_PASSWORD = 'test-database-secret'
  const originalError = console.error
  const lines: string[] = []
  console.error = (...values: unknown[]) => lines.push(values.join(' '))

  try {
    const error = new Error(
      'connection failed for password=test-database-secret; Authorization: Bearer abc.def.ghi at postgres://user:db-secret@db.example/app',
    )
    error.stack = `${error.name}: ${error.message}\n    at productsRoute (server.ts:10:5)`
    logError('api.unhandled GET /api/businesses/:business/products', error)
  } finally {
    console.error = originalError
    if (previousPassword === undefined) delete process.env.DB_PASSWORD
    else process.env.DB_PASSWORD = previousPassword
  }

  assert.equal(lines.length, 1)
  const [loggedLine] = lines
  assert.ok(loggedLine)
  assert.match(loggedLine, /productsRoute \(server\.ts:10:5\)/)
  assert.match(loggedLine, /api\.unhandled GET/)
  assert.doesNotMatch(loggedLine, /test-database-secret|abc\.def\.ghi|db-secret/)
  assert.match(loggedLine, /\[REDACTED\]/)
})
