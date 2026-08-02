// Govoru server: static web app + auth API + progress sync + password recovery.
// Zero-dependency (Node 20+). Passwords: scrypt. Sessions/reset: random tokens.
// Storage: server/data/auth.json + server/data/states/<hash>.json
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dist')
const DATA = join(HERE, 'data')
const STATES = join(DATA, 'states')
const AUTH_FILE = join(DATA, 'auth.json')
const PORT = parseInt(process.env.PORT ?? '80', 10)
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// ─── auth store ─────────────────────────────────────────────────────────────

async function loadAuth() {
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  } catch {
    return { users: [], sessions: {}, resets: {} }
  }
}

async function saveAuth(a) {
  await mkdir(DATA, { recursive: true })
  await writeFile(AUTH_FILE, JSON.stringify(a))
}

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex')
const token = () => randomBytes(32).toString('hex')
const stateFile = (email) => join(STATES, createHash('sha256').update(email.toLowerCase()).digest('hex') + '.json')

function sessionEmail(auth, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  const s = m && auth.sessions[m[1]]
  return s && s.exp > Date.now() ? s.email : null
}

async function sendResetEmail(email, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Govoru <onboarding@resend.dev>',
      to: [email],
      subject: 'Reset your Govoru password',
      html: `<p>You asked to reset your Govoru password.</p><p><a href="${link}">${link}</a></p><p>This link works for 1 hour. If you didn't ask for it, ignore this email.</p>`,
    }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.message ?? `resend ${r.status}`)
}

// ─── API ────────────────────────────────────────────────────────────────────

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 5_000_000) reject(new Error('too big'))
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        reject(new Error('bad json'))
      }
    })
  })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function handleApi(req, res, path) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {}
  const auth = await loadAuth()

  if (path === '/api/register' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    const password = body.password ?? ''
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Invalid email' })
    if (password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' })
    if (auth.users.some((u) => u.email === email)) return json(res, 409, { error: 'Account already exists — sign in instead' })
    const salt = randomBytes(16).toString('hex')
    auth.users.push({ email, salt, pass: hashPassword(password, salt), createdAt: Date.now() })
    const t = token()
    auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
    await saveAuth(auth)
    return json(res, 200, { token: t, email })
  }

  if (path === '/api/login' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    const u = auth.users.find((x) => x.email === email)
    const ok =
      u &&
      timingSafeEqual(
        Buffer.from(u.pass, 'hex'),
        Buffer.from(hashPassword(body.password ?? '', u.salt), 'hex'),
      )
    if (!ok) return json(res, 401, { error: 'Wrong email or password' })
    const t = token()
    auth.sessions[t] = { email, exp: Date.now() + 90 * 24 * 3600 * 1000 }
    await saveAuth(auth)
    return json(res, 200, { token: t, email })
  }

  if (path === '/api/logout' && req.method === 'POST') {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (m) delete auth.sessions[m[1]]
    await saveAuth(auth)
    return json(res, 200, { ok: true })
  }

  if (path === '/api/forgot' && req.method === 'POST') {
    const email = (body.email ?? '').trim().toLowerCase()
    // always answer ok — don't leak which emails exist
    const u = auth.users.find((x) => x.email === email)
    if (u && RESEND_API_KEY) {
      const t = token()
      auth.resets[t] = { email, exp: Date.now() + 3600 * 1000 }
      await saveAuth(auth)
      const link = `http://${req.headers.host}/#reset=${t}`
      try {
        await sendResetEmail(email, link)
      } catch (e) {
        console.error('resend failed:', e.message)
        return json(res, 502, { error: 'Could not send email — try again later' })
      }
    }
    return json(res, 200, { ok: true })
  }

  if (path === '/api/reset' && req.method === 'POST') {
    const r = auth.resets[body.token ?? '']
    if (!r || r.exp < Date.now()) return json(res, 400, { error: 'Reset link is invalid or expired' })
    const password = body.password ?? ''
    if (password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' })
    const u = auth.users.find((x) => x.email === r.email)
    if (!u) return json(res, 400, { error: 'Account not found' })
    u.salt = randomBytes(16).toString('hex')
    u.pass = hashPassword(password, u.salt)
    delete auth.resets[body.token]
    await saveAuth(auth)
    return json(res, 200, { ok: true })
  }

  if (path === '/api/state' && req.method === 'GET') {
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'Not signed in' })
    try {
      const raw = await readFile(stateFile(email), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(raw)
    } catch {
      return json(res, 200, { state: null })
    }
  }

  if (path === '/api/state' && req.method === 'PUT') {
    const email = sessionEmail(auth, req)
    if (!email) return json(res, 401, { error: 'Not signed in' })
    if (!body.state || !Array.isArray(body.state.cards)) return json(res, 400, { error: 'Bad state' })
    await mkdir(STATES, { recursive: true })
    await writeFile(stateFile(email), JSON.stringify(body.state))
    return json(res, 200, { ok: true })
  }

  return json(res, 404, { error: 'Not found' })
}

// ─── server ─────────────────────────────────────────────────────────────────

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    if (path.startsWith('/api/')) return await handleApi(req, res, path)

    let p = path === '/' ? '/index.html' : decodeURIComponent(path)
    const file = normalize(join(ROOT, p))
    if (!file.startsWith(ROOT)) throw new Error('bad path')
    let data
    try {
      data = await readFile(file)
    } catch {
      data = await readFile(join(ROOT, 'index.html')) // SPA fallback
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(data)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: 'server error' })
    else res.end()
  }
}).listen(PORT, () => console.log(`govoru serving on :${PORT}`))
