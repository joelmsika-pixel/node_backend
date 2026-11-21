import { closeDatabase, initializeDatabase } from './db.js'

try {
  await initializeDatabase()
  console.log('Database initialization completed.')
} catch (error) {
  console.error('Database initialization failed:', error)
  process.exitCode = 1
} finally {
  await closeDatabase()
}
