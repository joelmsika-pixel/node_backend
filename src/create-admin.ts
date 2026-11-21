import 'dotenv/config'
import { createInterface } from 'node:readline'
import bcrypt from 'bcryptjs'
import { row, closeDatabase } from './db.js'

function question(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => reader.question(prompt, (answer) => {
    reader.close()
    resolve(answer.trim())
  }))
}

function hiddenQuestion(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return question(`${prompt} (input will be visible): `)
  }
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let answer = ''
    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('Cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(answer)
          return
        }
        if (character === '\b' || character === '\u007f') answer = answer.slice(0, -1)
        else answer += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  const name = await question('Platform Admin name: ')
  const email = (await question('Platform Admin email: ')).toLowerCase()
  const password = await hiddenQuestion('Password (minimum 12 characters): ')
  const confirmation = await hiddenQuestion('Confirm password: ')
  if (!name || name.length > 150) throw new Error('Enter a name of 1 to 150 characters.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) throw new Error('Enter a valid email address.')
  if (password.length < 12 || password !== confirmation) throw new Error('Passwords must match and be at least 12 characters.')
  const existing = await row<{ id: number }>('SELECT id FROM users WHERE lower(email)=$1', [email])
  if (existing) throw new Error('An account already uses this email. Existing accounts must be managed by a Platform Admin.')
  const admin = await row<{ id: number; name: string; email: string }>(
    `INSERT INTO users(name,email,password,is_active,is_platform_admin,created_at,updated_at)
     VALUES($1,$2,$3,true,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id,name,email`,
    [name, email, await bcrypt.hash(password, 12)],
  )
  console.log(`Created Platform Admin ${admin!.email} (id ${admin!.id}).`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Could not create the Platform Admin.')
    process.exitCode = 1
  })
  .finally(closeDatabase)
