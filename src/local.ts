import app from './server.js'
import { closeDatabase } from './db.js'

const port = Number(process.env.PORT || 4000)
const server = app.listen(port, () => {
  console.log(`Biashara Manager Node.js API listening on http://localhost:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(async () => {
    await closeDatabase()
    process.exit(0)
  }))
}
