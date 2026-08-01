// ─── SRS Fluency Telegram bot ──────────────────────────────────────────────
// Zero-dependency long-polling bot (Node 20+). Set TELEGRAM_BOT_TOKEN and run:
//   TELEGRAM_BOT_TOKEN=123:abc node bot/bot.mjs
import {
  FLUENT_LEVEL,
  LEVEL_NAMES,
  fluencyPercent,
  formatInterval,
  gradeSimple,
  intervalForLevel,
  loadUser,
  reviewQueue,
  saveUser,
  streakDays,
  todayKey,
  wordGroups,
  groupMastery,
} from './core.mjs'

const PREVIEW = process.argv.includes('--preview')
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN && !PREVIEW) {
  console.error('Set TELEGRAM_BOT_TOKEN first (get one from @BotFather in Telegram).')
  process.exit(1)
}
const API = `https://api.telegram.org/bot${TOKEN}`

// swappable so --preview can intercept every outgoing call
let apiImpl = async (method, payload) => {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json()
  if (!j.ok) console.error(`${method} failed:`, j.description)
  return j
}

const api = (method, payload) => apiImpl(method, payload)

const send = (chatId, text, extra = {}) =>
  api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

// per-chat pending quiz: { cardId, messageId }
const pending = new Map()

function cardLabel(card) {
  const tag = card.kind === 'conjugation' ? `conjugation of <i>${card.base}</i>` : 'word'
  const isNew = card.introduced ? '' : ' 🆕'
  return `${tag}${isNew}`
}

async function sendNextCard(chatId, s) {
  const queue = reviewQueue(s)
  if (!queue.length) {
    pending.delete(chatId)
    const next = s.cards.filter((c) => c.introduced && c.due > Date.now()).map((c) => c.due)
    const when = next.length ? ` Next review in ${formatInterval(Math.min(...next) - Date.now())}.` : ''
    const backlog = s.cards.filter((c) => !c.introduced).length
    const bl = backlog ? ` ${backlog} new words waiting for tomorrow's quota.` : ''
    await send(chatId, `✅ <b>Всё! All caught up.</b>${when}${bl}`)
    return
  }
  const card = queue[0]
  pending.set(chatId, { cardId: card.id })
  await send(chatId, `<b>${card.front}</b>\n\n<i>${cardLabel(card)} · ${queue.length} left</i>`, {
    reply_markup: { inline_keyboard: [[{ text: '👁 Reveal', callback_data: 'reveal' }]] },
  })
}

async function handleMessage(msg) {
  const chatId = msg.chat.id
  const text = (msg.text ?? '').trim()
  const s = loadUser(chatId)

  if (text.startsWith('/start') || text.startsWith('/study')) {
    await send(
      chatId,
      `🇷🇺 <b>SRS Fluency</b> — Russian from 0 to fluent.\n` +
        `Answer with ✓ Right (+1 level) or ✗ Wrong (−1 level). Conjugations count toward their word's mastery.\n\n` +
        `/study — review due cards\n/stats — your progress\n/quota 30 — new words per day\n/help — commands`,
    )
    await sendNextCard(chatId, s)
    return
  }
  if (text.startsWith('/help')) {
    await send(
      chatId,
      `/study — review due cards\n/stats — fluency, streak, due count\n/quota N — set new words per day (default 20)\n\nLevels: ${LEVEL_NAMES.map((n, i) => `L${i} ${n}`).join(' → ')}`,
    )
    return
  }
  if (text.startsWith('/stats')) {
    const groups = wordGroups(s.cards)
    const introduced = s.cards.filter((c) => c.introduced).length
    const due = reviewQueue(s).length
    let fluent = 0
    for (const g of groups.values()) if (groupMastery(g) >= FLUENT_LEVEL) fluent++
    await send(
      chatId,
      `📊 <b>Your progress</b>\n` +
        `Fluency: <b>${fluencyPercent(s.cards)}%</b> (word mastery)\n` +
        `Words: ${groups.size} · ${fluent} fluent\n` +
        `Cards in play: ${introduced}/${s.cards.length}\n` +
        `Due now: ${due}\n` +
        `Reviewed today: ${s.history[todayKey()] ?? 0}\n` +
        `Streak: 🔥 ${streakDays(s.history)}d\n` +
        `New-per-day quota: ${s.newPerDay}`,
    )
    return
  }
  if (text.startsWith('/quota')) {
    const n = parseInt(text.split(/\s+/)[1] ?? '', 10)
    if (!n || n < 1 || n > 200) {
      await send(chatId, 'Usage: /quota 30 (1–200 new words per day)')
    } else {
      s.newPerDay = n
      saveUser(chatId, s)
      await send(chatId, `✓ New words per day set to ${n}.`)
    }
    return
  }
  // any other text during a quiz = treat as a nudge to reveal
  if (pending.has(chatId)) {
    await send(chatId, 'Tap 👁 Reveal, then grade yourself ✓ / ✗.')
  } else {
    await send(chatId, 'Send /study to review, /stats for progress.')
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id
  const messageId = cb.message.message_id
  const s = loadUser(chatId)
  const p = pending.get(chatId)

  if (!p) {
    await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Nothing to grade — /study' })
    return
  }
  const card = s.cards.find((c) => c.id === p.cardId)
  if (!card) {
    pending.delete(chatId)
    await api('answerCallbackQuery', { callback_query_id: cb.id })
    return
  }

  if (cb.data === 'reveal') {
    await api('answerCallbackQuery', { callback_query_id: cb.id })
    await api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `<b>${card.front}</b>\n\n${card.back}\n\n<i>${cardLabel(card)} · L${card.level} ${LEVEL_NAMES[card.level]}</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✗ Wrong (−1)', callback_data: 'wrong' },
            { text: '✓ Right (+1)', callback_data: 'right' },
          ],
        ],
      },
    })
    return
  }

  if (cb.data === 'right' || cb.data === 'wrong') {
    const now = Date.now()
    const correct = cb.data === 'right'
    const next = gradeSimple(card, correct, now)
    const key = todayKey(now)
    s.cards = s.cards.map((c) => (c.id === card.id ? next : c))
    s.history[key] = (s.history[key] ?? 0) + 1
    if (!card.introduced) s.introLog[key] = (s.introLog[key] ?? 0) + 1
    saveUser(chatId, s)
    pending.delete(chatId)

    const delta = correct ? `+1 → L${next.level} ${LEVEL_NAMES[next.level]}` : `−1 → L${next.level} ${LEVEL_NAMES[next.level]}`
    await api('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `${correct ? '✓' : '✗'} ${delta} · next in ${formatInterval(next.due - now)}`,
    })
    await api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `<b>${card.front}</b> — ${card.back}\n\n${correct ? '✓' : '✗'} <i>${delta}, next in ${formatInterval(next.due - now)}</i>`,
      parse_mode: 'HTML',
    })
    await sendNextCard(chatId, s)
  }
}

// ─── long polling loop ──────────────────────────────────────────────────────

let offset = 0
async function poll() {
  try {
    const j = await api('getUpdates', { offset, timeout: 30 })
    for (const u of j.result ?? []) {
      offset = u.update_id + 1
      try {
        if (u.message) await handleMessage(u.message)
        else if (u.callback_query) await handleCallback(u.callback_query)
      } catch (e) {
        console.error('update failed:', e)
      }
    }
  } catch (e) {
    console.error('poll error:', e.message ?? e)
    await new Promise((r) => setTimeout(r, 3000))
  }
  setImmediate(poll)
}

// ─── offline preview: simulate a Telegram conversation in the terminal ─────

function stripHtml(html) {
  return html.replace(/<\/?b>/g, '*').replace(/<\/?i>/g, '_').replace(/<[^>]+>/g, '')
}

function printKeyboard(rm) {
  for (const row of rm?.inline_keyboard ?? []) {
    console.log('   ┌ ' + row.map((b) => `[ ${b.text} ]`).join(' '))
  }
}

async function runPreview() {
  const chatId = 'preview_user'
  apiImpl = async (method, payload) => {
    if (method === 'sendMessage' || method === 'editMessageText') {
      const tag = method === 'editMessageText' ? ' (message updated)' : ''
      console.log(`\n🤖 BOT${tag}: ${stripHtml(payload.text)}`)
      printKeyboard(payload.reply_markup)
    } else if (method === 'answerCallbackQuery' && payload.text) {
      console.log(`   🔔 toast: ${payload.text}`)
    }
    return { ok: true, result: [] }
  }
  const user = (text) => {
    console.log(`\n👤 YOU: ${text}`)
    return handleMessage({ chat: { id: chatId }, text })
  }
  const tap = (data) => {
    console.log(`\n👤 YOU tap: ${data}`)
    return handleCallback({ id: 'cb', data, message: { chat: { id: chatId }, message_id: 1 } })
  }

  await user('/start')
  await tap('reveal')
  await tap('right')
  await tap('reveal')
  await tap('wrong')
  await user('/stats')
  console.log('')
}

if (PREVIEW) {
  runPreview()
} else {
  console.log('SRS Fluency bot polling…')
  poll()
}
