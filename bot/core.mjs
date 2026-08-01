// ─── SRS core for the Telegram bot (mirrors the web app's engine) ──────────
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')

export const FLUENT_LEVEL = 7
export const LEVEL_NAMES = ['New', 'Seen', 'Learning', 'Familiar', 'Known', 'Strong', 'Mastered', 'Fluent']
const LEVEL_INTERVALS_MIN = [10, 240, 1440, 3600, 8640, 20160, 50400, 129600]
const MIN = 60_000

export const intervalForLevel = (l) => LEVEL_INTERVALS_MIN[Math.max(0, Math.min(FLUENT_LEVEL, l))] * MIN

export function formatInterval(ms) {
  const min = ms / MIN
  if (min < 60) return `${Math.round(min)}m`
  const h = min / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return d % 1 === 0 ? `${d}d` : `${d.toFixed(1)}d`
  return `${Math.round(d / 30)}mo`
}

// ─── deck (reuse the web app's generated source) ────────────────────────────

function extractArray(file, name) {
  const src = readFileSync(join(__dirname, '..', 'src', 'data', file), 'utf8')
  const m = src.match(new RegExp(`export const ${name}[^=]*= (\\[[\\s\\S]*?\\])\\n`))
  if (!m) throw new Error(`cannot parse ${name} from ${file}`)
  return JSON.parse(m[1])
}

let seedRows = null
function deckRows() {
  if (seedRows) return seedRows
  const words = extractArray('ruDeck.ts', 'RU_WORDS')
  const conjs = extractArray('ruDeck.ts', 'RU_CONJUGATIONS')
  const rows = []
  let ci = 0
  words.forEach((w, i) => {
    rows.push({ f: w.f, b: w.b, kind: 'word' })
    if ((i + 1) % 40 === 0 && ci < conjs.length) {
      for (const c of conjs.slice(ci, ci + 9)) rows.push({ f: c.f, b: c.b, kind: 'conjugation', base: c.base })
      ci += 9
    }
  })
  for (const c of conjs.slice(ci)) rows.push({ f: c.f, b: c.b, kind: 'conjugation', base: c.base })
  seedRows = rows
  return rows
}

// ─── per-user state (chat_id = the account) ─────────────────────────────────

function statePath(chatId) {
  return join(DATA_DIR, `${chatId}.json`)
}

export function loadUser(chatId) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  try {
    const s = JSON.parse(readFileSync(statePath(chatId), 'utf8'))
    if (Array.isArray(s.cards)) return s
  } catch { /* first run or corrupt → seed */ }
  const now = Date.now()
  const rows = deckRows()
  const s = {
    cards: rows.map((r, i) => ({
      id: `s${i}`,
      front: r.f,
      back: r.b,
      kind: r.kind,
      base: r.base,
      level: 0,
      due: now,
      introduced: false,
      createdAt: now - (rows.length - i) * 1000,
      reviews: 0,
      lapses: 0,
    })),
    history: {},
    introLog: {},
    newPerDay: 20,
  }
  saveUser(chatId, s)
  return s
}

export function saveUser(chatId, s) {
  writeFileSync(statePath(chatId), JSON.stringify(s))
}

// ─── scheduling ─────────────────────────────────────────────────────────────

export const todayKey = (t = Date.now()) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

export function dueCards(cards, now) {
  return cards.filter((c) => c.introduced && c.due <= now).sort((a, b) => a.due - b.due || a.createdAt - b.createdAt)
}

export function reviewQueue(s, now = Date.now()) {
  const due = dueCards(s.cards, now)
  const introducedToday = s.introLog[todayKey(now)] ?? 0
  const quotaLeft = Math.max(0, s.newPerDay - introducedToday)
  const fresh = s.cards.filter((c) => !c.introduced).sort((a, b) => a.createdAt - b.createdAt).slice(0, quotaLeft)
  return [...due, ...fresh]
}

/** +1 level on correct, −1 and back in 10 min on wrong (mirrors the web app). */
export function gradeSimple(card, correct, now) {
  if (correct) {
    const level = Math.min(FLUENT_LEVEL, card.level + 1)
    return { ...card, level, introduced: true, due: now + intervalForLevel(level), reviews: card.reviews + 1 }
  }
  return {
    ...card,
    level: Math.max(0, card.level - 1),
    introduced: true,
    due: now + 10 * MIN,
    reviews: card.reviews + 1,
    lapses: card.lapses + 1,
  }
}

export function wordGroups(cards) {
  const m = new Map()
  for (const c of cards) {
    const k = c.base ?? c.front
    if (m.has(k)) m.get(k).push(c)
    else m.set(k, [c])
  }
  return m
}

export function groupMastery(group) {
  const intro = group.filter((c) => c.introduced)
  if (!intro.length) return 0
  return intro.reduce((s, c) => s + c.level, 0) / intro.length
}

export function fluencyPercent(cards) {
  const groups = wordGroups(cards)
  if (!groups.size) return 0
  let sum = 0
  for (const g of groups.values()) sum += groupMastery(g)
  return Math.round((sum / (groups.size * FLUENT_LEVEL)) * 100)
}

export function streakDays(history, now = Date.now()) {
  let streak = 0
  const d = new Date(now)
  if (!history[todayKey(d.getTime())]) d.setDate(d.getDate() - 1)
  while (history[todayKey(d.getTime())]) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}
