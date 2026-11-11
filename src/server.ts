import 'dotenv/config'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import cors from 'cors'
import * as helmetModule from 'helmet'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import nodemailer from 'nodemailer'
import { row, rows, transaction } from './db.js'

type User = {
  id: number
  name: string
  email: string
  phone: string | null
  password: string
  is_active: boolean
  is_platform_admin: boolean
  removed_email: string | null
}
type Business = {
  id: number
  name: string
  business_type: string | null
  phone: string | null
  email: string | null
  address: string | null
  currency: string
  status: string
  created_by: number
  created_at: string
  deleted_at: string | null
}
type Membership = { role: string; permissions: string[] | null; is_active: boolean }
type ApiRequest = Request & { user?: User; membership?: Membership; business?: Business }
type Handler = (req: ApiRequest, res: Response, next: NextFunction) => unknown

const app = express()
const accessMinutes = Number(process.env.ACCESS_TOKEN_EXPIRATION_MINUTES || 15)
const refreshDays = Number(process.env.REFRESH_TOKEN_EXPIRATION_DAYS || 7)
const currencies = new Set((process.env.BUSINESS_CURRENCIES || 'TZS,KES,UGX,USD').split(','))
const frontendUrls = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map((url) => url.trim()).filter(Boolean)

app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
const helmetMiddleware = (helmetModule.default as unknown as
  (options?: helmetModule.HelmetOptions) => RequestHandler)()
app.use(helmetMiddleware)
app.use(cors({
  origin(origin, callback) {
    if (!origin || frontendUrls.includes(origin)) return callback(null, true)
    return callback(Object.assign(new Error('Origin is not allowed by CORS.'), { status: 403 }))
  },
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))
app.use(express.json({ limit: '1mb' }))
app.use((req, _res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {}
  next()
})
app.get('/', (_req, res) => {
  res.json({
    name: 'Biashara Manager Node Backend',
    status: 'ok',
    frontend_url: frontendUrls[0],
    api_base: '/api',
    health_check: '/api/health',
  })
})
app.get('/api/health', asyncRoute(async (_req, res) => {
  await row('SELECT 1')
  res.json({ status: 'ok', database: 'connected' })
}))
app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
}))

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function fail(res: Response, status: number, message: string, errors?: Record<string, string[]>): void {
  res.status(status).json({ message, ...(errors ? { errors } : {}) })
}

function validate(
  res: Response,
  body: Record<string, unknown>,
  fields: Record<string, { required?: boolean; max?: number; email?: boolean; min?: number; number?: boolean }>,
): boolean {
  const errors: Record<string, string[]> = {}
  for (const [key, rules] of Object.entries(fields)) {
    const value = body[key]
    const normalized = text(value)
    if (rules.required && (value === undefined || value === null || normalized === '')) {
      errors[key] = [`The ${key.replaceAll('_', ' ')} field is required.`]
    } else if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') {
      errors[key] = [`The ${key.replaceAll('_', ' ')} field must be a string.`]
    } else if (normalized && rules.max && normalized.length > rules.max) {
      errors[key] = [`The ${key.replaceAll('_', ' ')} field must not be greater than ${rules.max} characters.`]
    } else if (normalized && rules.min && normalized.length < rules.min) {
      errors[key] = [`The ${key.replaceAll('_', ' ')} field must be at least ${rules.min} characters.`]
    } else if (normalized && rules.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      errors[key] = ['The email must be a valid email address.']
    } else if (normalized && rules.number && !Number.isFinite(Number(normalized))) {
      errors[key] = [`The ${key.replaceAll('_', ' ')} must be a number.`]
    }
  }
  if (Object.keys(errors).length) {
    fail(res, 422, 'The given data was invalid.', errors)
    return false
  }
  return true
}

function asyncRoute(handler: Handler): Handler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

async function audit(
  businessId: number,
  userId: number | null,
  action: string,
  type: string,
  recordId: number | null,
  oldValues: unknown = null,
  newValues: unknown = null,
  client?: Parameters<typeof rows>[2],
): Promise<void> {
  await rows(
    'INSERT INTO audit_logs (business_id,user_id,action,record_type,record_id,old_values,new_values,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)',
    [businessId, userId, action, type, recordId, oldValues, newValues],
    client,
  )
}

async function userPayload(user: User): Promise<Record<string, unknown>> {
  const businesses = await rows(
    `SELECT b.*, json_build_object(
       'role',m.role,'permissions',COALESCE(m.permissions,'[]'::json),'is_active',m.is_active
     ) AS pivot
     FROM businesses b JOIN business_user m ON m.business_id=b.id
     WHERE m.user_id=$1 AND m.is_active=true AND b.status='active' AND b.deleted_at IS NULL
     ORDER BY b.created_at DESC`,
    [user.id],
  )
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone,
    is_active: user.is_active, is_platform_admin: user.is_platform_admin, businesses,
  }
}

async function issuePair(user: User, deviceName: string): Promise<Record<string, unknown>> {
  const accessToken = randomBytes(48).toString('base64url')
  const refreshToken = randomBytes(60).toString('base64url')
  const accessId = randomUUID()
  const expiresAt = new Date(Date.now() + accessMinutes * 60_000)
  const refreshExpiresAt = new Date(Date.now() + refreshDays * 86_400_000)
  await transaction(async (client) => {
    await client.query('DELETE FROM api_access_tokens WHERE user_id=$1 AND device_name=$2', [user.id, deviceName])
    await client.query(
      'INSERT INTO api_access_tokens (id,user_id,token_hash,device_name,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [accessId, user.id, hash(accessToken), deviceName, expiresAt],
    )
    await client.query(
      'INSERT INTO api_refresh_tokens (access_token_id,user_id,token_hash,device_name,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [accessId, user.id, hash(refreshToken), deviceName, refreshExpiresAt],
    )
  })
  return {
    token: accessToken, token_type: 'Bearer', expires_at: expiresAt.toISOString(),
    refresh_token: refreshToken, refresh_expires_at: refreshExpiresAt.toISOString(),
  }
}

const authenticate: Handler = asyncRoute(async (req, res, next) => {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return fail(res, 401, 'Unauthenticated.')
  const user = await row<User & { token_id: string }>(
    `SELECT u.*, t.id AS token_id FROM api_access_tokens t JOIN users u ON u.id=t.user_id
     WHERE t.token_hash=$1 AND t.expires_at>CURRENT_TIMESTAMP AND u.is_active=true`,
    [hash(token)],
  )
  if (!user) return fail(res, 401, 'Unauthenticated.')
  req.user = user
  res.locals.tokenId = user.token_id
  return next()
})

const requireAdmin: Handler = (req, res, next) => {
  if (!req.user?.is_platform_admin) return fail(res, 403, 'You do not have permission to perform this action.')
  return next()
}

const businessAccess: Handler = asyncRoute(async (req, res, next) => {
  const business = await row<Business>(
    "SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL",
    [Number(req.params.business)],
  )
  if (!business) return fail(res, 404, 'Business not found.')
  if (business.status !== 'active') return fail(res, 403, 'This business is inactive.')
  const membership = await row<Membership>(
    'SELECT role,permissions,is_active FROM business_user WHERE business_id=$1 AND user_id=$2',
    [business.id, req.user?.id],
  )
  if (!membership?.is_active) return fail(res, 403, 'You do not belong to this business.')
  const ownerExists = await row<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM business_user m JOIN users u ON u.id=m.user_id
      WHERE m.business_id=$1 AND m.role='owner' AND m.is_active=true AND u.is_active=true) AS ok`,
    [business.id],
  )
  if (!ownerExists?.ok) return fail(res, 403, 'The business owner is inactive.')
  req.business = business
  req.membership = membership
  return next()
})

function permission(name: string): Handler {
  return (req, res, next) => {
    if (req.membership?.role !== 'owner' && !req.membership?.permissions?.includes(name)) {
      return fail(res, 403, 'You do not have permission to perform this action.')
    }
    return next()
  }
}

function activeBusinessUsers(business: Business): Promise<number[]> {
  return rows<{ user_id: number }>('SELECT user_id FROM business_user WHERE business_id=$1', [business.id])
    .then((items) => items.map((item) => item.user_id))
}

const writeLimiter = rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: Request) => `${ipKeyGenerator(req.ip || '127.0.0.1')}:${req.header('authorization') || 'guest'}`,
})

const loginLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false })
const refreshLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false })
const loginFailures = new Map<string, { count: number; lockedUntil: number }>()

app.post('/api/login', loginLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { email: { required: true, max: 150, email: true }, password: { required: true, max: 200 } })) return
  const email = text(body.email).toLowerCase()
  const attemptKey = hash(`${email}|${req.ip}`)
  const locked = loginFailures.get(attemptKey)
  if (locked && locked.lockedUntil > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((locked.lockedUntil - Date.now()) / 1000))
    res.setHeader('Retry-After', retryAfter)
    return res.status(429).json({ message: 'Too many failed sign-in attempts. Try again after the countdown.', retry_after: retryAfter })
  }
  if (locked && locked.lockedUntil <= Date.now()) loginFailures.delete(attemptKey)
  const removed = await row('SELECT id FROM users WHERE lower(removed_email)=$1 AND is_active=false', [email])
  if (removed) return fail(res, 403, 'You have been blocked from signing in. Contact your business owner.')
  const user = await row<User>('SELECT * FROM users WHERE lower(email)=$1', [email])
  if (!user || !user.is_active || !await bcrypt.compare(text(body.password), user.password)) {
    const attempts = loginFailures.get(attemptKey) || { count: 0, lockedUntil: 0 }
    attempts.count += 1
    if (attempts.count >= 5) {
      attempts.count = 0
      attempts.lockedUntil = Date.now() + 120_000
      loginFailures.set(attemptKey, attempts)
      res.setHeader('Retry-After', '120')
      return res.status(429).json({ message: 'Too many failed sign-in attempts. Try again after the countdown.', retry_after: 120 })
    }
    loginFailures.set(attemptKey, attempts)
    return fail(res, 422, 'The given data was invalid.', { email: ['The provided credentials are incorrect.'] })
  }
  loginFailures.delete(attemptKey)
  if (!user.is_platform_admin) {
    const access = await row<{ ok: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM business_user m JOIN businesses b ON b.id=m.business_id
        WHERE m.user_id=$1 AND m.is_active=true AND b.status='active' AND b.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM business_user o JOIN users u ON u.id=o.user_id
            WHERE o.business_id=b.id AND o.role='owner' AND o.is_active=true AND u.is_active=true)
      ) AS ok`,
      [user.id],
    )
    const hasMembership = await row<{ ok: boolean }>('SELECT EXISTS(SELECT 1 FROM business_user WHERE user_id=$1) AS ok', [user.id])
    if (hasMembership?.ok && !access?.ok) {
      return fail(res, 403, 'This business or its owner has been suspended. Contact the platform administrator.')
    }
  }
  const pair = await issuePair(user, text(body.device_name) || 'biashara-web')
  return res.json({ ...pair, user: await userPayload(user) })
}))

app.post('/api/token/refresh', refreshLimiter, asyncRoute(async (req, res) => {
  const refreshToken = text(req.body?.refresh_token)
  if (!refreshToken || refreshToken.length > 200) return fail(res, 422, 'The refresh token is required.')
  const result = await transaction(async (client) => {
    const saved = await row<{ id: number; access_token_id: string; user_id: number; device_name: string; expires_at: Date }>(
      'SELECT * FROM api_refresh_tokens WHERE token_hash=$1 FOR UPDATE', [hash(refreshToken)], client,
    )
    if (!saved || new Date(saved.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('The refresh token is invalid or expired.'), { status: 401 })
    }
    const user = await row<User>('SELECT * FROM users WHERE id=$1', [saved.user_id], client)
    if (!user?.is_active) throw Object.assign(new Error('The account is inactive.'), { status: 401 })
    await client.query('DELETE FROM api_refresh_tokens WHERE id=$1', [saved.id])
    await client.query('DELETE FROM api_access_tokens WHERE id=$1', [saved.access_token_id])
    return { user, name: saved.device_name }
  })
  return res.json(await issuePair(result.user, result.name))
}))

app.post('/api/forgot-password', rateLimit({ windowMs: 3_600_000, limit: 3, standardHeaders: true, legacyHeaders: false }), asyncRoute(async (req, res) => {
  const email = text(req.body?.email).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) return fail(res, 422, 'The email must be a valid email address.')
  const smtpHost = process.env.SMTP_HOST || process.env.MAIL_HOST
  const smtpFrom = process.env.SMTP_FROM || process.env.MAIL_FROM_ADDRESS
  if (!smtpHost || !smtpFrom) {
    console.error('Password reset requested but SMTP_HOST and SMTP_FROM are not configured.')
    return fail(res, 503, 'Password reset email is not configured. Contact the platform administrator.')
  }
  const user = await row<User>('SELECT * FROM users WHERE lower(email)=$1 AND is_active=true', [email])
  if (user) {
    const token = randomBytes(32).toString('hex')
    await rows(
      `INSERT INTO api_password_resets(email,token_hash,expires_at)
       VALUES($1,$2,CURRENT_TIMESTAMP + INTERVAL '60 minutes')
       ON CONFLICT(email) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,created_at=CURRENT_TIMESTAMP`,
      [email, hash(token)],
    )
    const url = new URL('/reset-password', frontendUrls[0])
    url.searchParams.set('token', token)
    url.searchParams.set('email', email)
    const smtpUser = process.env.SMTP_USER || process.env.MAIL_USERNAME
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true' || process.env.MAIL_SCHEME === 'smtps',
      auth: smtpUser
        ? { user: smtpUser, pass: process.env.SMTP_PASSWORD || process.env.MAIL_PASSWORD || '' }
        : undefined,
    })
    await transporter.sendMail({
      from: smtpFrom, to: email, subject: 'Reset your Biashara Manager password',
      text: `Hello ${user.name},\n\nUse this link to reset your password. It expires in 60 minutes:\n${url}`,
    })
  }
  return res.json({ message: 'If the account exists, a password reset link has been sent.' })
}))

app.post('/api/reset-password', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), asyncRoute(async (req, res) => {
  const { token, email, password, password_confirmation: confirmation } = req.body as Record<string, unknown>
  if (!validate(res, { token, email, password }, {
    token: { required: true }, email: { required: true, max: 150, email: true }, password: { required: true, min: 12 },
  })) return
  if (password !== confirmation) return fail(res, 422, 'The password confirmation does not match.', { password: ['The password confirmation does not match.'] })
  await transaction(async (client) => {
    const saved = await row<{ token_hash: string; expires_at: Date }>(
      'SELECT * FROM api_password_resets WHERE email=$1 FOR UPDATE', [text(email).toLowerCase()], client,
    )
    if (!saved || saved.token_hash !== hash(text(token)) || new Date(saved.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('This password reset link is invalid or has expired.'), { status: 422 })
    }
    const user = await row<User>('SELECT * FROM users WHERE lower(email)=$1', [text(email).toLowerCase()], client)
    if (!user) throw Object.assign(new Error('This password reset link is invalid or has expired.'), { status: 422 })
    await client.query('UPDATE users SET password=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [await bcrypt.hash(text(password), 12), user.id])
    await client.query('DELETE FROM api_access_tokens WHERE user_id=$1', [user.id])
    await client.query('DELETE FROM api_password_resets WHERE email=$1', [text(email).toLowerCase()])
  })
  return res.json({ message: 'Your password was reset. You can now sign in.' })
}))

app.get('/api/me', authenticate, asyncRoute(async (req, res) => res.json(await userPayload(req.user!))))
app.post('/api/logout', authenticate, asyncRoute(async (_req, res) => {
  await rows('DELETE FROM api_access_tokens WHERE id=$1', [res.locals.tokenId])
  return res.json({ message: 'Signed out successfully.' })
}))

const admin = express.Router()
admin.use(authenticate, requireAdmin)
admin.get('/businesses', asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const perPage = Math.max(1, Math.min(100, Number(req.query.per_page) || 20))
  const search = text(req.query.search)
  const deletedFilter = req.query.include_deleted === 'true'
  const result = await rows<Business>(
    `SELECT b.*,COALESCE(json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email))
       FILTER (WHERE u.id IS NOT NULL),'[]'::json) AS users
     FROM businesses b LEFT JOIN business_user m ON m.business_id=b.id AND m.role='owner'
     LEFT JOIN users u ON u.id=m.user_id WHERE ($1::boolean OR b.deleted_at IS NULL) AND ($2='' OR b.name ILIKE '%'||$2||'%')
     GROUP BY b.id ORDER BY b.created_at DESC LIMIT $3 OFFSET $4`,
    [deletedFilter, search, perPage, (page - 1) * perPage],
  )
  const count = await row<{ count: number }>(
    "SELECT count(*)::int AS count FROM businesses WHERE ($1::boolean OR deleted_at IS NULL) AND ($2='' OR name ILIKE '%'||$2||'%')",
    [deletedFilter, search],
  )
  return res.json({ data: result, current_page: page, per_page: perPage, total: count?.count || 0, last_page: Math.max(1, Math.ceil((count?.count || 0) / perPage)) })
}))
admin.get('/businesses/:id', asyncRoute(async (req, res) => {
  const business = await row<Business>('SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id)])
  if (!business) return fail(res, 404, 'Business not found.')
  const owner = await row('SELECT u.id,u.name,u.email FROM users u JOIN business_user m ON m.user_id=u.id WHERE m.business_id=$1 AND m.role=$2', [business.id, 'owner'])
  return res.json({ ...business, users: owner ? [owner] : [] })
}))
admin.post('/businesses', writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, {
    name: { required: true, max: 150 }, owner_name: { required: true, max: 150 },
    owner_email: { required: true, email: true, max: 150 }, business_type: { max: 100 },
    email: { email: true, max: 150 }, phone: { max: 30 }, address: { max: 1000 },
  })) return
  const currency = text(body.currency) || 'TZS'
  if (!currencies.has(currency)) return fail(res, 422, 'The selected currency is invalid.')
  const ownerEmail = text(body.owner_email).toLowerCase()
  const output = await transaction(async (client) => {
    let owner = await row<User>('SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE', [ownerEmail], client)
    let created = false
    if (!owner) {
      if (text(body.owner_password).length < 12) throw Object.assign(new Error('A password of at least 12 characters is required for a new owner account.'), { status: 422 })
      owner = await row<User>(
        `INSERT INTO users (name,email,phone,password,is_platform_admin,is_active,created_at,updated_at)
         VALUES($1,$2,$3,$4,false,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
        [text(body.owner_name), ownerEmail, text(body.owner_phone) || null, await bcrypt.hash(text(body.owner_password), 12)], client,
      )
      created = true
    }
    if (!owner?.is_active) throw Object.assign(new Error('The selected owner account is inactive.'), { status: 422 })
    const business = await row<Business>(
      `INSERT INTO businesses(name,business_type,phone,email,address,currency,status,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'active',$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
      [text(body.name), text(body.business_type) || null, text(body.phone) || null, text(body.email) || null, text(body.address) || null, currency, req.user!.id], client,
    )
    if (!business) throw new Error('Business creation returned no record.')
    await client.query('INSERT INTO business_user(business_id,user_id,role,permissions,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)', [business.id, owner.id, 'owner', JSON.stringify([])])
    await client.query(
      `INSERT INTO categories(business_id,name,type,is_active,created_at,updated_at) VALUES
       ($1,'Other income','income',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
       ($1,'Other expense','expense',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [business.id],
    )
    await client.query("INSERT INTO payment_methods(business_id,name,is_active,created_at,updated_at) VALUES($1,'Cash',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [business.id])
    await audit(business.id, req.user!.id, 'business.created', 'App\\Models\\Business', business.id, null, { name: business.name, owner_id: owner.id }, client)
    return { business, owner, created }
  })
  return res.status(201).json({
    message: 'Business registered successfully.', business: output.business,
    owner: { id: output.owner.id, name: output.owner.name, email: output.owner.email }, owner_account_created: output.created,
  })
}))
admin.put('/businesses/:id', writeLimiter, asyncRoute(async (req, res) => {
  await updateBusiness(req, res, true)
}))
admin.patch('/businesses/:id/status', writeLimiter, asyncRoute(async (req, res) => {
  const status = text(req.body?.status)
  if (!['active', 'suspended'].includes(status)) return fail(res, 422, 'Status must be active or suspended.')
  const business = await row<Business>('SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id)])
  if (!business) return fail(res, 404, 'Business not found.')
  await rows('UPDATE businesses SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [status, business.id])
  if (status === 'suspended') {
    const userIds = await activeBusinessUsers(business)
    if (userIds.length) await rows('DELETE FROM api_access_tokens WHERE user_id=ANY($1::bigint[])', [userIds])
  }
  await audit(business.id, req.user!.id, 'business.status_changed', 'App\\Models\\Business', business.id, { status: business.status }, { status })
  return res.json({ message: 'Business status updated.', business: { ...business, status } })
}))
admin.delete('/businesses/:id', writeLimiter, asyncRoute(async (req, res) => {
  const business = await row<Business>('SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id)])
  if (!business) return fail(res, 404, 'Business not found.')
  await rows('UPDATE businesses SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [business.id])
  const userIds = await activeBusinessUsers(business)
  if (userIds.length) await rows('DELETE FROM api_access_tokens WHERE user_id=ANY($1::bigint[])', [userIds])
  await audit(business.id, req.user!.id, 'business.deleted', 'App\\Models\\Business', business.id, { deleted_at: null }, { deleted_at: new Date().toISOString() })
  return res.json({ message: 'Business removed. Its records are preserved.' })
}))
admin.post('/businesses/:id/restore', writeLimiter, asyncRoute(async (req, res) => {
  const business = await row<Business>('SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NOT NULL', [Number(req.params.id)])
  if (!business) return fail(res, 404, 'Deleted business not found.')
  await rows('UPDATE businesses SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [business.id])
  await audit(business.id, req.user!.id, 'business.restored', 'App\\Models\\Business', business.id, { deleted_at: business.deleted_at }, { deleted_at: null })
  return res.json({ message: 'Business restored.' })
}))
app.use('/api/admin', admin)

async function updateBusiness(req: ApiRequest, res: Response, businessScoped = false): Promise<void> {
  const id = businessScoped ? req.business!.id : Number(req.params.id)
  const business = await row<Business>('SELECT * FROM businesses WHERE id=$1 AND deleted_at IS NULL', [id])
  if (!business) return fail(res, 404, 'Business not found.')
  const fields: Record<string, string> = {
    name: 'name', business_type: 'business_type', phone: 'phone', email: 'email',
    address: 'address', currency: 'currency',
  }
  const body = req.body as Record<string, unknown>
  const keys = Object.keys(body).filter((key) => key in fields)
  if (!keys.length) return fail(res, 422, 'No valid business fields were provided.')
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(body.email))) return fail(res, 422, 'The email must be a valid email address.')
  if (body.currency && !currencies.has(text(body.currency))) return fail(res, 422, 'The selected currency is invalid.')
  if (body.currency && body.currency !== business.currency) {
    const exists = await row<{ exists: boolean }>(
      `SELECT (EXISTS(SELECT 1 FROM sales WHERE business_id=$1) OR EXISTS(SELECT 1 FROM income_records WHERE business_id=$1)
       OR EXISTS(SELECT 1 FROM expenses WHERE business_id=$1)) AS exists`, [business.id],
    )
    if (exists?.exists) return fail(res, 422, 'Currency cannot be changed after financial records have been recorded.')
  }
  const values = keys.map((key) => body[key] === '' ? null : body[key])
  const sets = keys.map((key, index) => `${fields[key]}=$${index + 1}`)
  const updated = await row<Business>(
    `UPDATE businesses SET ${sets.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=$${keys.length + 1} RETURNING *`,
    [...values, business.id],
  )
  await audit(business.id, req.user?.id || null, 'business.updated', 'App\\Models\\Business', business.id, business, body)
  res.json({ message: 'Business updated successfully.', business: updated })
}

const api = express.Router()
api.use(authenticate)
api.get('/businesses/:business', businessAccess, permission('business.settings'), asyncRoute(async (req, res) => res.json(req.business)))
api.patch('/businesses/:business', businessAccess, permission('business.settings'), writeLimiter, asyncRoute(async (req, res) => updateBusiness(req, res, true)))
app.use('/api', api)

const business = express.Router({ mergeParams: true })
business.use(businessAccess)

function pageOptions(req: Request): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, Number(req.query.page) || 1)
  const perPage = Math.max(1, Math.min(100, Number(req.query.per_page) || 20))
  return { page, perPage, offset: (page - 1) * perPage }
}

async function paginated<T extends import('../node_modules/@types/pg/index.js').QueryResultRow>(
  res: Response,
  sql: string,
  params: unknown[],
  countSql: string,
  countParams: unknown[],
  page: number,
  perPage: number,
): Promise<void> {
  const data = await rows<T>(sql, params)
  const count = await row<{ count: number }>(countSql, countParams)
  const total = count?.count || 0
  res.json({ data, meta: { current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(total / perPage)), total }, current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(total / perPage)), total })
}

business.get('/dashboard', permission('dashboard.view'), asyncRoute(async (req, res) => {
  const id = req.business!.id
  const from = text(req.query.from) || '0001-01-01'
  const to = text(req.query.to) || '9999-12-31'
  const totals = await row<Record<string, string>>(
    `SELECT
      COALESCE((SELECT sum(total_amount) FROM sales WHERE business_id=$1 AND voided_at IS NULL AND sale_date BETWEEN $2 AND $3),0)::text AS sales_total,
      COALESCE((SELECT sum(amount) FROM income_records WHERE business_id=$1 AND voided_at IS NULL AND income_date BETWEEN $2 AND $3),0)::text AS income_total,
      COALESCE((SELECT sum(amount) FROM expenses WHERE business_id=$1 AND voided_at IS NULL AND expense_date BETWEEN $2 AND $3),0)::text AS expenses_total,
      COALESCE((SELECT sum(amount) FROM sale_payments WHERE business_id=$1 AND voided_at IS NULL AND payment_date BETWEEN $2 AND $3),0)::text AS payments_total,
      ((SELECT count(*) FROM sales WHERE business_id=$1 AND voided_at IS NULL AND status <> 'paid')+
       (SELECT count(*) FROM business_loans l WHERE l.business_id=$1 AND l.principal>
         COALESCE((SELECT sum(r.amount) FROM business_loan_repayments r WHERE r.business_loan_id=l.id),0)))::text AS debt_count`,
    [id, from, to],
  )
  const balances = await row<{ sales_balance: string; loan_balance: string }>(
    `SELECT
      COALESCE((SELECT sum(s.total_amount-COALESCE(p.paid,0)) FROM sales s
        LEFT JOIN (SELECT sale_id,sum(amount) AS paid FROM sale_payments WHERE voided_at IS NULL GROUP BY sale_id) p ON p.sale_id=s.id
        WHERE s.business_id=$1 AND s.voided_at IS NULL AND s.sale_date BETWEEN $2 AND $3 AND s.total_amount>COALESCE(p.paid,0)),0)::text AS sales_balance,
      COALESCE((SELECT sum(l.principal-COALESCE(r.paid,0)) FROM business_loans l
        LEFT JOIN (SELECT business_loan_id,sum(amount) AS paid FROM business_loan_repayments GROUP BY business_loan_id) r ON r.business_loan_id=l.id
        WHERE l.business_id=$1 AND l.loan_date BETWEEN $2 AND $3 AND l.principal>COALESCE(r.paid,0)),0)::text AS loan_balance`,
    [id, from, to],
  )
  const recent = await rows(
    `SELECT s.*, c.name AS customer_name,
       COALESCE((SELECT json_agg(i) FROM sale_items i WHERE i.sale_id=s.id),'[]'::json) AS items
     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
     WHERE s.business_id=$1 AND s.voided_at IS NULL ORDER BY s.sale_date DESC,s.id DESC LIMIT 8`,
    [id],
  )
  return res.json({
    sales_total: totals?.sales_total || '0.00', income_total: totals?.income_total || '0.00',
    expenses_total: totals?.expenses_total || '0.00', payments_total: totals?.payments_total || '0.00',
    outstanding_total: (Number(balances?.sales_balance || 0) + Number(balances?.loan_balance || 0)).toFixed(2),
    debt_count: Number(totals?.debt_count || 0),
    recent_activity: recent.map((sale) => ({ ...sale, customer: sale.customer_name ? { name: sale.customer_name } : null, type: 'sale' })),
  })
}))

business.get('/customers', permission('customers.view'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pageOptions(req)
  const search = text(req.query.search)
  const id = req.business!.id
  return paginated(res,
    `SELECT * FROM customers WHERE business_id=$1 AND deleted_at IS NULL
     AND ($2='' OR name ILIKE '%'||$2||'%' OR phone ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%')
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [id, search, perPage, offset],
    `SELECT count(*)::int AS count FROM customers WHERE business_id=$1 AND deleted_at IS NULL
     AND ($2='' OR name ILIKE '%'||$2||'%' OR phone ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%')`,
    [id, search], page, perPage)
}))
business.post('/customers', permission('customers.manage'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { name: { required: true, max: 150 }, phone: { max: 30 }, email: { max: 150, email: true }, address: { max: 1000 }, notes: { max: 2000 } })) return
  const customer = await row(
    `INSERT INTO customers(business_id,name,phone,email,address,notes,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
    [req.business!.id, text(body.name), text(body.phone) || null, text(body.email) || null, text(body.address) || null, text(body.notes) || null],
  )
  await audit(req.business!.id, req.user!.id, 'customer.created', 'App\\Models\\Customer', customer!.id, null, body)
  return res.status(201).json(customer)
}))

business.get('/categories', asyncRoute(async (req, res) => {
  const type = text(req.query.type)
  if (type && !['income', 'expense'].includes(type)) return fail(res, 422, 'The selected type is invalid.')
  const { page, perPage, offset } = pageOptions(req)
  const params = [req.business!.id, type || null]
  return paginated(res,
    `SELECT * FROM categories WHERE business_id=$1 AND is_active=true AND ($2::text IS NULL OR type=$2) ORDER BY name LIMIT $3 OFFSET $4`,
    [...params, perPage, offset],
    `SELECT count(*)::int AS count FROM categories WHERE business_id=$1 AND is_active=true AND ($2::text IS NULL OR type=$2)`,
    params, page, perPage)
}))
business.post('/categories', permission('business.settings'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  const type = text(body.type)
  if (!validate(res, body, { name: { required: true, max: 100 } })) return
  if (!['income', 'expense'].includes(type)) return fail(res, 422, 'The selected type is invalid.')
  const category = await row(
    'INSERT INTO categories(business_id,name,type,is_active,created_at,updated_at) VALUES($1,$2,$3,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *',
    [req.business!.id, text(body.name), type],
  )
  await audit(req.business!.id, req.user!.id, 'category.created', 'App\\Models\\Category', category!.id, null, body)
  return res.status(201).json(category)
}))
business.get('/payment-methods', asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pageOptions(req)
  return paginated(res,
    'SELECT * FROM payment_methods WHERE business_id=$1 AND is_active=true ORDER BY name LIMIT $2 OFFSET $3',
    [req.business!.id, perPage, offset],
    'SELECT count(*)::int AS count FROM payment_methods WHERE business_id=$1 AND is_active=true',
    [req.business!.id], page, perPage)
}))
business.post('/payment-methods', permission('business.settings'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { name: { required: true, max: 100 } })) return
  const method = await row(
    'INSERT INTO payment_methods(business_id,name,is_active,created_at,updated_at) VALUES($1,$2,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *',
    [req.business!.id, text(body.name)],
  )
  await audit(req.business!.id, req.user!.id, 'payment_method.created', 'payment_method', method!.id, null, body)
  return res.status(201).json(method)
}))

for (const [kind, table, dateField, permissionName] of [
  ['income', 'income_records', 'income_date', 'income'],
  ['expenses', 'expenses', 'expense_date', 'expenses'],
] as const) {
  business.get(`/${kind}`, permission(`${permissionName}.view`), asyncRoute(async (req, res) => {
    const { page, perPage, offset } = pageOptions(req)
    const search = text(req.query.search)
    const id = req.business!.id
    const filter = `r.business_id=$1 AND r.voided_at IS NULL AND ($2='' OR r.description ILIKE '%'||$2||'%' OR COALESCE(r.reference,'') ILIKE '%'||$2||'%') AND ($3::date IS NULL OR r.${dateField}>=$3) AND ($4::date IS NULL OR r.${dateField}<=$4)`
    return paginated(res,
      `SELECT r.*,json_build_object('id',c.id,'name',c.name) AS category
       FROM ${table} r LEFT JOIN categories c ON c.id=r.category_id
       WHERE ${filter} ORDER BY r.${dateField} DESC LIMIT $5 OFFSET $6`,
      [id, search, req.query.from || null, req.query.to || null, perPage, offset],
      `SELECT count(*)::int AS count FROM ${table} r WHERE ${filter}`,
      [id, search, req.query.from || null, req.query.to || null], page, perPage)
  }))
  business.post(`/${kind}`, permission(`${permissionName}.create`), writeLimiter, asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>
    const amount = Number(body.amount)
    if (!validate(res, body, {
      amount: { required: true, number: true }, [dateField]: { required: true },
      description: { required: true, max: 2000 }, source: { max: 150 }, reference: { max: 150 },
    })) return
    if (amount <= 0 || !/^\d{1,12}(\.\d{1,2})?$/.test(String(body.amount))) return fail(res, 422, 'Amount must be greater than zero and have at most two decimal places.')
    const categoryId = body.category_id ? Number(body.category_id) : null
    if (categoryId && !await row('SELECT id FROM categories WHERE id=$1 AND business_id=$2 AND type=$3 AND is_active=true', [categoryId, req.business!.id, kind === 'income' ? 'income' : 'expense'])) return fail(res, 422, 'The selected category is invalid.')
    const record = await row(
      `INSERT INTO ${table}(business_id,category_id,source,description,amount,${dateField},reference,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
      [req.business!.id, categoryId, text(body.source) || null, text(body.description), amount.toFixed(2), body[dateField], text(body.reference) || null, req.user!.id],
    )
    await audit(req.business!.id, req.user!.id, `${kind === 'income' ? 'income' : 'expense'}.created`, `App\\Models\\${kind === 'income' ? 'IncomeRecord' : 'Expense'}`, record!.id, null, body)
    return res.status(201).json(record)
  }))
}

business.get('/sales', permission('sales.view'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pageOptions(req)
  const search = text(req.query.search)
  const id = req.business!.id
  const dateFilter = `AND ($3::date IS NULL OR s.sale_date >= $3) AND ($4::date IS NULL OR s.sale_date <= $4)`
  const filter = `s.business_id=$1 AND s.voided_at IS NULL AND ($2='' OR s.sale_number ILIKE '%'||$2||'%' OR COALESCE(c.name,'') ILIKE '%'||$2||'%') ${dateFilter}`
  return paginated(res,
    `SELECT s.*,json_build_object('id',c.id,'name',c.name) AS customer,
      COALESCE((SELECT json_agg(i) FROM sale_items i WHERE i.sale_id=s.id),'[]'::json) AS items
     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE ${filter}
     ORDER BY s.sale_date DESC LIMIT $5 OFFSET $6`,
    [id, search, req.query.from || null, req.query.to || null, perPage, offset],
    `SELECT count(*)::int AS count FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE ${filter}`,
    [id, search, req.query.from || null, req.query.to || null], page, perPage)
}))
business.post('/sales', permission('sales.create'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { sale_date: { required: true } })) return
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) return fail(res, 422, 'At least one sale item is required.')
  const items = body.items as Record<string, unknown>[]
  let total = 0
  const normalized: { name: string; quantity: string; price: string; line: string }[] = []
  for (const item of items) {
    const quantity = Number(item.quantity)
    const price = Number(item.unit_price)
    if (!text(item.item_name) || text(item.item_name).length > 180 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) return fail(res, 422, 'Each item needs a name, positive quantity, and non-negative unit price.')
    const line = Math.round(quantity * price * 100) / 100
    total += line
    normalized.push({ name: text(item.item_name), quantity: quantity.toFixed(3), price: price.toFixed(2), line: line.toFixed(2) })
  }
  if (total > 999999999999.99) return fail(res, 422, 'The sale total exceeds the supported amount.')
  const result = await transaction(async (client) => {
    let customerId = body.customer_id ? Number(body.customer_id) : null
    if (customerId && !await row('SELECT id FROM customers WHERE id=$1 AND business_id=$2', [customerId, req.business!.id], client)) {
      throw Object.assign(new Error('The selected customer is invalid.'), { status: 422 })
    }
    if (!customerId && text(body.customer_name)) {
      let customer = await row<{ id: number }>('SELECT id FROM customers WHERE business_id=$1 AND lower(name)=lower($2) LIMIT 1', [req.business!.id, text(body.customer_name)], client)
      if (!customer) customer = await row<{ id: number }>('INSERT INTO customers(business_id,name,created_at,updated_at) VALUES($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id', [req.business!.id, text(body.customer_name)], client)
      customerId = customer!.id
    }
    const latest = await row<{ count: number }>('SELECT count(*)::int AS count FROM sales WHERE business_id=$1', [req.business!.id], client)
    const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String((latest?.count || 0) + 1).padStart(5, '0')}`
    const completed = Boolean(body.is_completed)
    const sale = await row(
      `INSERT INTO sales(business_id,customer_id,sale_number,sale_date,due_date,total_amount,status,created_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
      [req.business!.id, customerId, saleNumber, body.sale_date, body.due_date || null, total.toFixed(2), completed ? 'paid' : 'unpaid', req.user!.id], client,
    )
    for (const item of normalized) {
      await client.query(
        'INSERT INTO sale_items(business_id,sale_id,item_name,quantity,unit_price,line_total,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        [req.business!.id, sale!.id, item.name, item.quantity, item.price, item.line],
      )
    }
    if (completed) {
      await client.query(
        `INSERT INTO sale_payments(business_id,sale_id,amount,payment_method,payment_date,received_by,created_at,updated_at)
         VALUES($1,$2,$3,'Cash sale',$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [req.business!.id, sale!.id, total.toFixed(2), body.sale_date, req.user!.id],
      )
    }
    await audit(req.business!.id, req.user!.id, 'sale.created', 'App\\Models\\Sale', sale!.id, null, { sale_number: saleNumber, total_amount: total.toFixed(2) }, client)
    return sale
  })
  const saleItems = await rows('SELECT * FROM sale_items WHERE sale_id=$1', [result!.id])
  return res.status(201).json({ ...result, items: saleItems })
}))
business.get('/sales/:sale', permission('sales.view'), asyncRoute(async (req, res) => {
  const sale = await row(
    `SELECT s.*,json_build_object('id',c.id,'name',c.name) AS customer,
      COALESCE((SELECT json_agg(i) FROM sale_items i WHERE i.sale_id=s.id),'[]'::json) AS items,
      COALESCE((SELECT json_agg(p) FROM sale_payments p WHERE p.sale_id=s.id AND p.voided_at IS NULL),'[]'::json) AS payments,
      COALESCE((SELECT sum(amount) FROM sale_payments p WHERE p.sale_id=s.id AND p.voided_at IS NULL),0)::text AS paid_amount
     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
     WHERE s.id=$1 AND s.business_id=$2 AND s.voided_at IS NULL`,
    [Number(req.params.sale), req.business!.id],
  )
  if (!sale) return fail(res, 404, 'Sale not found.')
  return res.json({ ...sale, balance: (Number(sale.total_amount) - Number(sale.paid_amount)).toFixed(2) })
}))
business.post('/sales/:sale/payments', permission('payments.create'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  const amount = Number(body.amount)
  if (!validate(res, body, { amount: { required: true, number: true }, payment_date: { required: true }, payment_method: { required: true, max: 100 }, reference: { max: 150 } })) return
  if (amount <= 0 || !/^\d{1,12}(\.\d{1,2})?$/.test(String(body.amount))) return fail(res, 422, 'Amount must be greater than zero and have at most two decimal places.')
  const result = await transaction(async (client) => {
    const sale = await row<{ id: number; total_amount: string; voided_at: string | null }>(
      'SELECT * FROM sales WHERE id=$1 AND business_id=$2 FOR UPDATE', [Number(req.params.sale), req.business!.id], client,
    )
    if (!sale) throw Object.assign(new Error('Sale not found.'), { status: 404 })
    if (sale.voided_at) throw Object.assign(new Error('Payments cannot be added to a voided sale.'), { status: 422 })
    const paid = await row<{ total: string }>("SELECT COALESCE(sum(amount),0)::text AS total FROM sale_payments WHERE sale_id=$1 AND voided_at IS NULL", [sale.id], client)
    const remaining = Number(sale.total_amount) - Number(paid?.total || 0)
    if (amount > remaining) throw Object.assign(new Error('The recorded payment exceeds the outstanding sale balance.'), { status: 422 })
    const methodId = body.payment_method_id ? Number(body.payment_method_id) : null
    if (methodId && !await row('SELECT id FROM payment_methods WHERE id=$1 AND business_id=$2 AND is_active=true', [methodId, req.business!.id], client)) {
      throw Object.assign(new Error('The selected payment method is invalid.'), { status: 422 })
    }
    const payment = await row(
      `INSERT INTO sale_payments(business_id,sale_id,amount,payment_method_id,payment_method,payment_date,reference,received_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
      [req.business!.id, sale.id, amount.toFixed(2), methodId, text(body.payment_method), body.payment_date, text(body.reference) || null, req.user!.id], client,
    )
    const newPaid = Number(paid?.total || 0) + amount
    await client.query('UPDATE sales SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [newPaid >= Number(sale.total_amount) ? 'paid' : 'partial', sale.id])
    await audit(req.business!.id, req.user!.id, 'sale_payment.created', 'App\\Models\\SalePayment', payment!.id, null, { sale_id: sale.id, amount: amount.toFixed(2) }, client)
    return payment
  })
  return res.status(201).json({ message: 'External payment record saved.', payment: result, payment_is_external: true })
}))

business.get('/payments', permission('payments.view'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pageOptions(req)
  const id = req.business!.id
  const search = text(req.query.search)
  const filter = `p.business_id=$1 AND p.voided_at IS NULL AND ($2='' OR COALESCE(p.payment_method,'') ILIKE '%'||$2||'%' OR COALESCE(p.reference,'') ILIKE '%'||$2||'%')`
  return paginated(res,
    `SELECT p.*,json_build_object('id',s.id,'sale_number',s.sale_number,'customer_id',s.customer_id) AS sale
     FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE ${filter} ORDER BY p.payment_date DESC LIMIT $3 OFFSET $4`,
    [id, search, perPage, offset],
    `SELECT count(*)::int AS count FROM sale_payments p WHERE ${filter}`,
    [id, search], page, perPage)
}))

business.get('/employees', permission('employees.view'), asyncRoute(async (req, res) => {
  if (req.membership?.role !== 'owner') return fail(res, 403, 'Only the business owner can manage employees.')
  const employees = await rows(
    `SELECT u.id,u.name,u.email,u.removed_email,u.phone,m.role,m.permissions,m.is_active
     FROM business_user m JOIN users u ON u.id=m.user_id
     WHERE m.business_id=$1 AND m.role='employee' ORDER BY u.name`,
    [req.business!.id],
  )
  return res.json(employees.map((employee) => ({
    ...employee,
    email: employee.is_active ? employee.email : null,
    restore_email: employee.is_active ? null : employee.removed_email,
    permissions: employee.permissions || [],
  })))
}))
business.post('/employees', permission('employees.manage'), writeLimiter, asyncRoute(async (req, res) => {
  if (req.membership?.role !== 'owner') return fail(res, 403, 'Only the business owner can add employees.')
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { name: { required: true, max: 150 }, email: { required: true, max: 150, email: true }, phone: { max: 30 } })) return
  const email = text(body.email).toLowerCase()
  const permissions = ['sales.view', 'sales.create', 'payments.view', 'payments.create', 'income.view', 'income.create', 'expenses.view', 'expenses.create', 'debts.view', 'debts.create']
  const employee = await transaction(async (client) => {
    const removed = await row('SELECT id FROM users WHERE lower(removed_email)=$1 AND is_active=false', [email], client)
    if (removed) throw Object.assign(new Error('This employee was removed. Restore the existing employee profile instead of adding a new account.'), { status: 422 })
    let user = await row<User>('SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE', [email], client)
    let created = false
    if (!user) {
      if (text(body.password).length < 12 || body.password !== body.password_confirmation) throw Object.assign(new Error('A confirmed password of at least 12 characters is required for a new account.'), { status: 422 })
      user = await row<User>(
        `INSERT INTO users(name,email,phone,password,is_active,is_platform_admin,created_at,updated_at)
         VALUES($1,$2,$3,$4,true,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
        [text(body.name), email, text(body.phone) || null, await bcrypt.hash(text(body.password), 12)], client,
      )
      created = true
    } else if (!user.is_active) throw Object.assign(new Error('The selected account is inactive.'), { status: 422 })
    const exists = await row('SELECT user_id FROM business_user WHERE business_id=$1 AND user_id=$2', [req.business!.id, user!.id], client)
    if (exists) throw Object.assign(new Error('This user already belongs to the business.'), { status: 422 })
    await client.query(
      'INSERT INTO business_user(business_id,user_id,role,permissions,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      [req.business!.id, user!.id, 'employee', JSON.stringify(permissions)],
    )
    await audit(req.business!.id, req.user!.id, 'employee.added', 'App\\Models\\User', user!.id, null, { role: 'employee', permissions }, client)
    return { user: user!, created }
  })
  return res.status(201).json({ message: 'Employee added successfully.', employee: { id: employee.user.id, name: employee.user.name, email: employee.user.email, role: 'employee', permissions, is_active: true }, account_created: employee.created })
}))
business.patch('/employees/:employee', permission('employees.manage'), writeLimiter, asyncRoute(async (req, res) => {
  if (req.membership?.role !== 'owner') return fail(res, 403, 'Only the business owner can manage employees.')
  const member = await row<Membership & { user_id: number; email: string; removed_email: string | null }>(
    `SELECT m.user_id,m.role,m.permissions,m.is_active,u.email,u.removed_email FROM business_user m JOIN users u ON u.id=m.user_id
     WHERE m.business_id=$1 AND m.user_id=$2 AND m.role='employee'`,
    [req.business!.id, Number(req.params.employee)],
  )
  if (!member) return fail(res, 404, 'Employee not found.')
  if (req.body?.is_active === false) {
    await transaction(async (client) => {
      await client.query('UPDATE business_user SET is_active=false,updated_at=CURRENT_TIMESTAMP WHERE business_id=$1 AND user_id=$2', [req.business!.id, member.user_id])
      await client.query(
        `UPDATE users SET removed_email=COALESCE(removed_email,email),email='removed-'||id||'@account.invalid',
         password=$1,is_active=false,remember_token=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
        [await bcrypt.hash(randomBytes(48).toString('hex'), 12), member.user_id],
      )
      await client.query('DELETE FROM api_access_tokens WHERE user_id=$1', [member.user_id])
      await client.query('DELETE FROM api_refresh_tokens WHERE user_id=$1', [member.user_id])
      await audit(req.business!.id, req.user!.id, 'employee.removed', 'App\\Models\\User', member.user_id, { is_active: true }, { is_active: false }, client)
    })
    return res.json({ message: 'Employee removed and sign-in credentials revoked. Existing records are preserved.' })
  }
  if (req.body?.is_active === true) {
    const body = req.body as Record<string, unknown>
    if (!validate(res, body, { name: { required: true, max: 150 }, email: { required: true, max: 150, email: true }, password: { required: true, min: 12 } })) return
    if (body.password !== body.password_confirmation) return fail(res, 422, 'The password confirmation does not match.')
    const email = text(body.email).toLowerCase()
    await transaction(async (client) => {
      const conflict = await row('SELECT id FROM users WHERE id<>$1 AND (lower(email)=$2 OR lower(removed_email)=$2)', [member.user_id, email], client)
      if (conflict) throw Object.assign(new Error('This email address is already in use.'), { status: 422 })
      await client.query('UPDATE business_user SET is_active=true,updated_at=CURRENT_TIMESTAMP WHERE business_id=$1 AND user_id=$2', [req.business!.id, member.user_id])
      await client.query(
        'UPDATE users SET name=$1,email=$2,removed_email=NULL,phone=$3,password=$4,is_active=true,remember_token=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$5',
        [text(body.name), email, text(body.phone) || null, await bcrypt.hash(text(body.password), 12), member.user_id],
      )
      await audit(req.business!.id, req.user!.id, 'employee.restored', 'App\\Models\\User', member.user_id, { is_active: false }, { is_active: true, credentials_restored: true }, client)
    })
    return res.json({ message: 'Employee restored.' })
  }
  return fail(res, 422, 'The is_active field must be true or false.')
}))
business.delete('/employees/:employee', permission('employees.manage'), asyncRoute(async (req, res) => {
  if (req.membership?.role !== 'owner') return fail(res, 403, 'Only the business owner can remove employees.')
  const employeeId = Number(req.params.employee)
  const result = await rows(
    `UPDATE business_user SET is_active=false,updated_at=CURRENT_TIMESTAMP
     WHERE business_id=$1 AND user_id=$2 AND role='employee' RETURNING user_id`,
    [req.business!.id, employeeId],
  )
  if (!result.length) return fail(res, 404, 'Employee not found.')
  await rows('DELETE FROM api_access_tokens WHERE user_id=$1', [employeeId])
  await rows('DELETE FROM api_refresh_tokens WHERE user_id=$1', [employeeId])
  return res.json({ message: 'Employee removed.' })
}))

business.get('/inbox', asyncRoute(async (req, res) => {
  if (!['owner', 'employee'].includes(req.membership!.role)) return fail(res, 403, 'Only owners and employees can access the inbox.')
  const { page, perPage, offset } = pageOptions(req)
  const owner = req.membership!.role === 'owner'
  const filter = `business_id=$1 AND (recipient_id=$2 OR ($3::boolean AND sender_id=$2))`
  return paginated(res,
    `SELECT m.*,json_build_object('id',s.id,'name',s.name,'email',s.email) AS sender,
       json_build_object('id',r.id,'name',r.name,'email',r.email) AS recipient
     FROM business_messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.recipient_id
     WHERE ${filter} ORDER BY m.created_at DESC LIMIT $4 OFFSET $5`,
    [req.business!.id, req.user!.id, owner, perPage, offset],
    `SELECT count(*)::int AS count FROM business_messages WHERE ${filter}`,
    [req.business!.id, req.user!.id, owner], page, perPage)
}))
business.post('/inbox', writeLimiter, asyncRoute(async (req, res) => {
  if (req.membership!.role !== 'owner') return fail(res, 403, 'Only the business owner can send team messages.')
  const body = req.body as Record<string, unknown>
  if (!validate(res, body, { subject: { required: true, max: 150 }, body: { required: true, max: 5000 } })) return
  const recipient = await row(
    "SELECT user_id FROM business_user WHERE business_id=$1 AND user_id=$2 AND role='employee' AND is_active=true",
    [req.business!.id, Number(body.recipient_id)],
  )
  if (!recipient) return fail(res, 422, 'The selected employee is invalid.')
  const message = await row(
    `INSERT INTO business_messages(business_id,sender_id,recipient_id,subject,body,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
    [req.business!.id, req.user!.id, Number(body.recipient_id), text(body.subject), text(body.body)],
  )
  await audit(req.business!.id, req.user!.id, 'inbox.message_sent', 'App\\Models\\BusinessMessage', message!.id, null, { recipient_id: body.recipient_id, subject: body.subject })
  return res.status(201).json({ message: 'Inbox message sent.', inbox_message: message })
}))
business.patch('/inbox/:message/read', asyncRoute(async (req, res) => {
  const message = await row(
    `UPDATE business_messages SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND business_id=$2 AND recipient_id=$3 RETURNING *`,
    [Number(req.params.message), req.business!.id, req.user!.id],
  )
  if (!message) return fail(res, 404, 'Message not found.')
  return res.json({ message: 'Message marked as read.', read_at: message.read_at })
}))

business.post('/loans', permission('debts.create'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  const principal = Number(body.principal)
  if (!validate(res, body, { borrower_name: { required: true, max: 150 }, principal: { required: true, number: true }, loan_date: { required: true }, borrower_phone: { max: 30 }, notes: { max: 2000 } })) return
  if (principal <= 0 || !/^\d{1,12}(\.\d{1,2})?$/.test(String(body.principal))) return fail(res, 422, 'Principal must be greater than zero and have at most two decimal places.')
  const loan = await row(
    `INSERT INTO business_loans(business_id,borrower_name,borrower_phone,principal,loan_date,due_date,notes,created_by,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
    [req.business!.id, text(body.borrower_name), text(body.borrower_phone) || null, principal.toFixed(2), body.loan_date, body.due_date || null, text(body.notes) || null, req.user!.id],
  )
  await audit(req.business!.id, req.user!.id, 'loan.created', 'App\\Models\\BusinessLoan', loan!.id, null, body)
  return res.status(201).json({ loan, message: 'Loan recorded.' })
}))
business.get('/debts', permission('debts.view'), asyncRoute(async (req, res) => {
  const id = req.business!.id
  const loans = await rows(
    `SELECT l.*,COALESCE(sum(r.amount),0)::text AS paid_amount,
      (l.principal-COALESCE(sum(r.amount),0))::text AS balance
     FROM business_loans l LEFT JOIN business_loan_repayments r ON r.business_loan_id=l.id
     WHERE l.business_id=$1 GROUP BY l.id ORDER BY l.loan_date DESC`,
    [id],
  )
  const sales = await rows(
    `SELECT s.*,c.name AS borrower_name,c.phone AS borrower_phone,
       COALESCE(sum(p.amount),0)::text AS paid_amount,(s.total_amount-COALESCE(sum(p.amount),0))::text AS balance
     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
     LEFT JOIN sale_payments p ON p.sale_id=s.id AND p.voided_at IS NULL
     WHERE s.business_id=$1 AND s.voided_at IS NULL GROUP BY s.id,c.name,c.phone ORDER BY s.sale_date DESC`,
    [id],
  )
  const entries = [
    ...sales.filter((sale) => Number(sale.balance) > 0).map((sale) => ({
      id: `sale-${sale.id}`, loan_id: null, loan_type: 'sale', sale_number: sale.sale_number,
      description: `Mauzo ${sale.sale_number}`, borrower_name: sale.borrower_name || '—',
      borrower_phone: sale.borrower_phone, loan_date: sale.sale_date, principal: sale.total_amount,
      paid_amount: sale.paid_amount, balance: sale.balance, due_date: sale.due_date,
      status: Number(sale.paid_amount) > 0 ? 'partial' : 'unpaid',
    })),
    ...loans.map((loan) => ({
      id: `loan-${loan.id}`, loan_id: loan.id, loan_type: 'loan', sale_number: null,
      description: loan.notes, borrower_name: loan.borrower_name, borrower_phone: loan.borrower_phone,
      loan_date: loan.loan_date, principal: loan.principal, paid_amount: loan.paid_amount,
      balance: loan.balance, due_date: loan.due_date,
      status: Number(loan.balance) <= 0 ? 'paid' : Number(loan.paid_amount) > 0 ? 'partial' : 'unpaid',
    })),
  ].filter((entry) => (!req.query.status || entry.status === req.query.status) &&
    (!req.query.from || String(entry.loan_date) >= String(req.query.from)) &&
    (!req.query.to || String(entry.loan_date) <= String(req.query.to)) &&
    (!req.query.search || `${entry.borrower_name} ${entry.borrower_phone || ''} ${entry.description || ''}`.toLowerCase().includes(text(req.query.search).toLowerCase())))
  const { page, perPage, offset } = pageOptions(req)
  return res.json({ data: entries.slice(offset, offset + perPage), meta: { current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(entries.length / perPage)), total: entries.length } })
}))
business.post('/loans/:loan/repayments', permission('debts.create'), writeLimiter, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>
  const amount = Number(body.amount)
  if (!validate(res, body, { amount: { required: true, number: true }, payment_date: { required: true }, destination: { required: true }, reference: { max: 150 } })) return
  if (amount <= 0 || !/^\d{1,12}(\.\d{1,2})?$/.test(String(body.amount))) return fail(res, 422, 'Amount must be greater than zero and have at most two decimal places.')
  const destination = text(body.destination)
  if (!['income', 'expenses', 'sales'].includes(destination)) return fail(res, 422, 'The selected destination is invalid.')
  const repayment = await transaction(async (client) => {
    const loan = await row<{ id: number; principal: string; borrower_name: string }>(
      'SELECT * FROM business_loans WHERE id=$1 AND business_id=$2 FOR UPDATE',
      [Number(req.params.loan), req.business!.id], client,
    )
    if (!loan) throw Object.assign(new Error('Loan not found.'), { status: 404 })
    const paid = await row<{ total: string }>('SELECT COALESCE(sum(amount),0)::text AS total FROM business_loan_repayments WHERE business_loan_id=$1', [loan.id], client)
    if (amount > Number(loan.principal) - Number(paid?.total || 0)) throw Object.assign(new Error('Repayment cannot exceed the remaining loan balance.'), { status: 422 })
    const record = await row(
      `INSERT INTO business_loan_repayments(business_id,business_loan_id,amount,payment_date,reference,received_by,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *`,
      [req.business!.id, loan.id, amount.toFixed(2), body.payment_date, text(body.reference) || null, req.user!.id], client,
    )
    if (destination === 'income' || destination === 'expenses') {
      const table = destination === 'income' ? 'income_records' : 'expenses'
      const dateField = destination === 'income' ? 'income_date' : 'expense_date'
      await client.query(
        `INSERT INTO ${table}(business_id,source,description,amount,${dateField},created_by,created_at,updated_at)
         VALUES($1,'Loan repayment',$2,$3,$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [req.business!.id, `Loan repayment from ${loan.borrower_name}`, amount.toFixed(2), body.payment_date, req.user!.id],
      )
    } else {
      const count = await row<{ count: number }>('SELECT count(*)::int AS count FROM sales WHERE business_id=$1', [req.business!.id], client)
      const sale = await row<{ id: number }>(
        `INSERT INTO sales(business_id,sale_number,sale_date,total_amount,status,created_by,created_at,updated_at)
         VALUES($1,$2,$3,$4,'paid',$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`,
        [req.business!.id, `SALE-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String((count?.count || 0)+1).padStart(5,'0')}`, body.payment_date, amount.toFixed(2), req.user!.id], client,
      )
      await client.query(
        `INSERT INTO sale_items(business_id,sale_id,item_name,quantity,unit_price,line_total,created_at,updated_at)
         VALUES($1,$2,'Loan repayment','1.000',$3,$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [req.business!.id, sale!.id, amount.toFixed(2)],
      )
      await client.query(
        `INSERT INTO sale_payments(business_id,sale_id,amount,payment_method,payment_date,received_by,created_at,updated_at)
         VALUES($1,$2,$3,'Loan repayment',$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [req.business!.id, sale!.id, amount.toFixed(2), body.payment_date, req.user!.id],
      )
    }
    await audit(req.business!.id, req.user!.id, 'loan.repayment_recorded', 'App\\Models\\BusinessLoanRepayment', record!.id, null, body, client)
    return record
  })
  return res.status(201).json({ repayment, message: 'Loan repayment recorded.' })
}))

business.get('/activity', permission('reports.view'), asyncRoute(async (req, res) => {
  const { page, perPage, offset } = pageOptions(req)
  const search = text(req.query.search)
  return paginated(res,
    `SELECT a.*,json_build_object('id',u.id,'name',u.name) AS "user" FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.business_id=$1 AND ($2='' OR a.action ILIKE '%'||$2||'%' OR a.record_type ILIKE '%'||$2||'%')
     ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
    [req.business!.id, search, perPage, offset],
    `SELECT count(*)::int AS count FROM audit_logs WHERE business_id=$1 AND ($2='' OR action ILIKE '%'||$2||'%' OR record_type ILIKE '%'||$2||'%')`,
    [req.business!.id, search], page, perPage)
}))

business.get('/reports', permission('reports.view'), asyncRoute(async (req, res) => {
  const id = req.business!.id
  const from = text(req.query.from) || '0001-01-01'
  const to = text(req.query.to) || '9999-12-31'
  const sales = await rows(
    `SELECT s.id,s.sale_number AS description,s.sale_date AS date,s.total_amount AS amount,s.status,
       c.name AS customer,c.id AS customer_id,u.name AS employee,u.id AS employee_id,
       GREATEST(s.total_amount-COALESCE(p.paid,0),0)::text AS balance
     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=s.created_by
     LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM sale_payments WHERE sale_id=s.id AND voided_at IS NULL) p ON true
     WHERE s.business_id=$1 AND s.voided_at IS NULL AND s.sale_date BETWEEN $2 AND $3
     ORDER BY s.sale_date DESC`,
    [id, from, to],
  )
  const incomes = await rows(
    `SELECT i.id,i.description,i.income_date AS date,i.amount,'recorded' AS status,c.name AS category,
       c.id AS category_id,u.name AS employee,u.id AS employee_id
     FROM income_records i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN users u ON u.id=i.created_by
     WHERE i.business_id=$1 AND i.voided_at IS NULL AND i.income_date BETWEEN $2 AND $3 ORDER BY i.income_date DESC`,
    [id, from, to],
  )
  const expenses = await rows(
    `SELECT e.id,e.description,e.expense_date AS date,e.amount,'recorded' AS status,c.name AS category,
       c.id AS category_id,u.name AS employee,u.id AS employee_id
     FROM expenses e LEFT JOIN categories c ON c.id=e.category_id LEFT JOIN users u ON u.id=e.created_by
     WHERE e.business_id=$1 AND e.voided_at IS NULL AND e.expense_date BETWEEN $2 AND $3 ORDER BY e.expense_date DESC`,
    [id, from, to],
  )
  const loans = await rows(
    `SELECT l.id,l.borrower_name || ': ' || COALESCE(l.notes,'Business loan') AS description,
       l.loan_date AS date,l.principal,u.name AS employee,u.id AS employee_id,
       GREATEST(l.principal-COALESCE(r.paid,0),0)::text AS balance
     FROM business_loans l LEFT JOIN users u ON u.id=l.created_by
     LEFT JOIN LATERAL (SELECT sum(amount) AS paid FROM business_loan_repayments WHERE business_loan_id=l.id) r ON true
     WHERE l.business_id=$1 AND l.loan_date BETWEEN $2 AND $3 ORDER BY l.loan_date DESC`,
    [id, from, to],
  )
  const payments = await rows(
    `SELECT p.id,'Payment received externally' AS description,p.payment_date AS date,p.amount,
       p.payment_method AS category,c.name AS customer,c.id AS customer_id,u.name AS employee,u.id AS employee_id
     FROM sale_payments p JOIN sales s ON s.id=p.sale_id LEFT JOIN customers c ON c.id=s.customer_id
     LEFT JOIN users u ON u.id=p.received_by
     WHERE p.business_id=$1 AND p.voided_at IS NULL AND p.payment_date BETWEEN $2 AND $3 ORDER BY p.payment_date DESC`,
    [id, from, to],
  )
  const salesTotal = sales.reduce((sum, item) => sum + Number(item.amount), 0)
  const incomeTotal = incomes.reduce((sum, item) => sum + Number(item.amount), 0)
  const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount), 0)
  const paymentsTotal = payments.reduce((sum, item) => sum + Number(item.amount), 0)
  const debtsTotal = sales.reduce((sum, item) => sum + Number(item.balance), 0)
    + loans.reduce((sum, item) => sum + Number(item.balance), 0)
  const reportRows: Record<string, unknown>[] = [
    ...sales.map((item) => ({ ...item, id: `sale-${item.id}`, type: 'sale', category: null })),
    ...sales.filter((item) => Number(item.balance) > 0).map((item) => ({
      ...item, id: `sale-debt-${item.id}`, type: 'debt', description: `Unpaid sale ${item.description}`,
      amount: item.balance, status: 'unpaid', category: null,
    })),
    ...loans.map((item) => ({
      ...item, id: `loan-${item.id}`, type: 'debt', amount: item.balance,
      customer: item.description.split(':', 1)[0], status: Number(item.balance) > 0 ? 'unpaid' : 'paid', category: null,
    })),
    ...incomes.map((item) => ({ ...item, id: `income-${item.id}`, type: 'income', customer: null })),
    ...expenses.map((item) => ({ ...item, id: `expense-${item.id}`, type: 'expense', customer: null })),
    ...payments.map((item) => ({ ...item, id: `payment-${item.id}`, type: 'payment' })),
  ]
  const data = reportRows.filter((item) =>
    (!req.query.search || `${'description' in item ? item.description : ''} ${item.type}`.toLowerCase().includes(text(req.query.search).toLowerCase()))
    && (!req.query.customer_id || Number('customer_id' in item ? item.customer_id : null) === Number(req.query.customer_id))
    && (!req.query.category_id || Number('category_id' in item ? item.category_id : null) === Number(req.query.category_id))
    && (!req.query.employee_id || Number('employee_id' in item ? item.employee_id : null) === Number(req.query.employee_id))
    && (!req.query.status || item.status === req.query.status))
  const { page, perPage, offset } = pageOptions(req)
  const filtered = data.slice(offset, offset + perPage)
  return res.json({
    sales_total: salesTotal.toFixed(2), income_total: incomeTotal.toFixed(2),
    expenses_total: expenseTotal.toFixed(2), payments_total: paymentsTotal.toFixed(2),
    debts_total: debtsTotal.toFixed(2), general_total: (salesTotal + incomeTotal + expenseTotal - debtsTotal).toFixed(2),
    report_from: req.query.from || null, report_to: req.query.to || null,
    records: { data: filtered, current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(data.length / perPage)), total: data.length, meta: { current_page: page, per_page: perPage, last_page: Math.max(1, Math.ceil(data.length / perPage)), total: data.length } },
  })
}))

business.post('/:type/:record/void', writeLimiter, asyncRoute(async (req, res) => {
  const type = text(req.params.type)
  const tables: Record<string, { table: string; permission: string }> = {
    sales: { table: 'sales', permission: 'sales.edit' }, income: { table: 'income_records', permission: 'income.create' },
    expenses: { table: 'expenses', permission: 'expenses.create' }, payments: { table: 'sale_payments', permission: 'payments.create' },
  }
  const target = tables[type]
  if (!target) return fail(res, 404, 'Record not found.')
  if (req.membership?.role !== 'owner' && !req.membership?.permissions?.includes(target.permission)) return fail(res, 403, 'You do not have permission to void records.')
  const reason = text(req.body?.reason)
  if (reason.length < 3 || reason.length > 1000) return fail(res, 422, 'A reason of 3 to 1000 characters is required.')
  const id = Number(req.params.record)
  const record = await row<{ id: number; voided_at: string | null; sale_id?: number }>(
    `SELECT * FROM ${target.table} WHERE id=$1 AND business_id=$2`, [id, req.business!.id],
  )
  if (!record) return fail(res, 404, 'Record not found.')
  if (record.voided_at) return fail(res, 422, 'This record is already voided.')
  if (type === 'sales') {
    const payments = await row<{ total: string }>('SELECT COALESCE(sum(amount),0)::text AS total FROM sale_payments WHERE sale_id=$1 AND voided_at IS NULL', [id])
    if (Number(payments?.total) > 0) return fail(res, 422, 'Void recorded payments before voiding this sale.')
  }
  await rows(`UPDATE ${target.table} SET void_reason=$1,voided_at=CURRENT_TIMESTAMP,voided_by=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$3`, [reason, req.user!.id, id])
  if (type === 'payments') {
    const sale = await row<{ id: number; total_amount: string }>('SELECT s.id,s.total_amount FROM sales s JOIN sale_payments p ON p.sale_id=s.id WHERE p.id=$1', [id])
    if (sale) {
      const paid = await row<{ total: string }>('SELECT COALESCE(sum(amount),0)::text AS total FROM sale_payments WHERE sale_id=$1 AND voided_at IS NULL', [sale.id])
      await rows('UPDATE sales SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [Number(paid?.total) >= Number(sale.total_amount) ? 'paid' : Number(paid?.total) > 0 ? 'partial' : 'unpaid', sale.id])
    }
  }
  await audit(req.business!.id, req.user!.id, `${type}.voided`, target.table, id, null, { reason })
  return res.json({ message: 'Record voided successfully.' })
}))

app.use('/api/businesses/:business', authenticate, business)

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const failure = error as Error & { status?: number; code?: string }
  if (res.headersSent) return
  if (failure.code === '23505') return fail(res, 422, 'A record with these details already exists.')
  if (failure.code === '23503') return fail(res, 422, 'A related record could not be found.')
  if (failure.code === '23514' || failure.code === '22P02' || failure.code === '22007' || failure.code === '22008') return fail(res, 422, 'The given data was invalid.')
  if (failure.status === 400) return fail(res, 400, 'The request body is not valid JSON.')
  if (failure.status) return fail(res, failure.status, failure.message)
  console.error(failure)
  return fail(res, 500, 'An unexpected server error occurred.')
})

export default app
