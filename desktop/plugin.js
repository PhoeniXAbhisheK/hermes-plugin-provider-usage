/**
 * Provider Usage: desktop status-bar item (right cluster).
 *
 * Data: this plugin's own backend namespace
 * (/api/plugins/provider-usage/usage, served by dashboard/plugin_api.py),
 * so provider credentials stay on the local machine.
 *
 * Each provider row carries a pin toggle; Pin all and Unpin all sit in the
 * popover toolbar. With no pins the bar follows the focused session's
 * provider, and shows plain "Usage" when that provider is not covered.
 *
 * Registered as a DATA contribution, so the app renders it with the exact
 * same chrome as the core context-usage gauge; `variant: 'menu'` opens the
 * popover: dense per-provider rows, a Used/Remaining value selector
 * (bottom-right, instant) and a refresh-interval picker (30s/1m/5m/10m).
 * Every scheduled poll refreshes the underlying values (?fresh=1).
 *
 * Near-limit tint: the backend sets `warn` on any row that is at or past its
 * own threshold; the bar and the popover rows follow that flag.
 *
 * Native notification (ctx.os.notify) fires once per warned row, deduped per
 * window cycle (keyed by the row key and reset time) and per day for money.
 *
 * Burn-rate ETA: the backend reports `actionable_eta` from observed history;
 * rows show "~2d" when it is present, and nothing otherwise.
 */
import {
  STATUSBAR_AREAS,
  ScrollArea,
  Tip,
  atom,
  host,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const USAGE_KEY = ['plugin-provider-usage', 'backend']

const INTERVALS = [
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
  { label: '10m', ms: 600000 }
]

/* Plugin-local state: poll cadence + value mode. Persisted via ctx.storage
 * (namespaced under hermes.plugin.provider-usage.*) so they survive restarts. */
const $interval = atom(300000)
const $mode = atom('used') // 'used' | 'remaining'
/* Which providers appear in the status bar. null = never touched; an array
 * of ids = the pinned providers (carried over unchanged from the old eye
 * toggles, so a saved choice still applies). */
const $barProviders = atom(null)
/* Which quota the bar shows per provider: { providerId: rowKey }. Empty means
 * the default (highest used_pct row). Persisted like the other atoms. */
const $barQuota = atom({})

const STORE_INTERVAL = 'intervalMs'
const STORE_MODE = 'valueMode'
const STORE_ALERTS = 'alerts'
const STORE_ALERT_AT = 'alertAt'
const STORE_BAR = 'barProviders'
const STORE_BAR_QUOTA = 'barQuota'

let storage = null
let osNotify = null
let rest = null

function persist(key, value) {
  if (!storage) return
  try {
    storage.set(key, value)
  } catch {
    /* storage unavailable, session-only */
  }
}

function bindStorage(s) {
  storage = s
  try {
    const ms = storage.get(STORE_INTERVAL, null)
    if (INTERVALS.some(o => o.ms === ms)) $interval.set(ms)
    const mode = storage.get(STORE_MODE, null)
    if (mode === 'used' || mode === 'remaining') $mode.set(mode)
    const bar = storage.get(STORE_BAR, null)
    if (Array.isArray(bar)) $barProviders.set(bar)
    const quota = storage.get(STORE_BAR_QUOTA, null)
    if (quota && typeof quota === 'object' && !Array.isArray(quota)) $barQuota.set(quota)
    $alertAt.set(cleanAlertMap(storage.get(STORE_ALERT_AT, null)))
  } catch {
    /* ignore malformed persisted state */
  }
  $interval.listen(v => persist(STORE_INTERVAL, v))
  $mode.listen(v => persist(STORE_MODE, v))
  $barProviders.listen(v => persist(STORE_BAR, v))
  $barQuota.listen(v => persist(STORE_BAR_QUOTA, v))
  $alertAt.listen(v => persist(STORE_ALERT_AT, v))
}

async function fetchUsage(manual) {
  if (!rest) throw new Error('plugin backend not bound')
  return rest(manual ? '/usage?fresh=1&refresh=1' : '/usage?fresh=1')
}

function useUsage() {
  const interval = useValue($interval)
  return useQuery({
    queryKey: USAGE_KEY,
    queryFn: () => fetchUsage(false),
    refetchInterval: interval,
    retry: 1,
    staleTime: 30000
  })
}

/* ---------- formatting / prediction helpers ---------- */

/* One formatter per currency: a Map lookup is cheaper than rebuilding an
 * Intl formatter on every render. The locale is fixed, so output never
 * depends on the machine's locale. An invalid code is caught once at the
 * constructor and shown verbatim rather than thrown. */
const MONEY_FORMATS = new Map()

function moneyFormatter(code) {
  let formatter = MONEY_FORMATS.get(code)
  if (formatter !== undefined) return formatter
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
  } catch {
    return null
  }
  MONEY_FORMATS.set(code, formatter)
  return formatter
}

export function money(v, cur) {
  const code = String(cur || 'USD').toUpperCase()
  const formatter = moneyFormatter(code)
  const amount = Number(v)
  if (formatter === null) return code + ' ' + amount.toFixed(2)
  return formatter.format(amount)
}

export const pct = v => Math.round(Number(v) || 0) + '%'

function rowsOf(p) {
  return (Array.isArray(p && p.windows) ? p.windows : []).concat(
    Array.isArray(p && p.money) ? p.money : []
  )
}

function nowOf(nowMs) {
  return isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Number(v) || 0))
}

export function etaText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!isFinite(ms)) return ''
  if (ms <= 0) return 'resets now'
  const mins = Math.round(ms / 60000)
  if (mins < 90) return 'resets in ' + mins + 'm'
  const hours = Math.floor(mins / 60)
  if (hours < 36) return 'resets in ' + hours + 'h ' + (mins % 60) + 'm'
  return 'resets in ' + Math.round(hours / 24) + 'd'
}

export function fmtEta(sec) {
  const s = Number(sec)
  if (!isFinite(s) || s <= 0) return ''
  const mins = Math.round(s / 60)
  if (mins < 90) return '~' + mins + 'm'
  const hours = Math.floor(mins / 60)
  if (hours < 36) return '~' + hours + 'h'
  return '~' + Math.round(hours / 24) + 'd'
}

export function usedPercentOf(w) {
  return clampPct(w && w.used_pct)
}

/* ---------- session provider (read on focus/model change only) ---------- */

const $sessionProvider = atom(null)

const $alertAt = atom({})
const ALERT_STEPS = [50, 70, 80, 90, 95]
const ALERT_OPTIONS = ALERT_STEPS.map(n => ({ id: String(n), label: String(n) })).concat([
  { id: 'off', label: 'Off' }
])

function validAlertValue(value) {
  if (value === 'off') return 'off'
  const n = Number(value)
  return ALERT_STEPS.indexOf(n) !== -1 ? n : null
}

function cleanAlertMap(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(raw)) {
    const value = validAlertValue(raw[key])
    if (value !== null) out[key] = value
  }
  return out
}

/* The saved threshold for one window row: a step, 'off', or null for the
 * default (the backend's warn flag). Money and indicative rows have no
 * threshold. */
export function alertThreshold(choice, providerId, row) {
  if (!row || row.kind === 'money' || !providerId || row.indicative === true) return null
  const map = choice && typeof choice === 'object' ? choice : {}
  const key = providerId + ':' + row.key
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null
  return validAlertValue(map[key])
}

export function setAlert(providerId, rowKey, value) {
  const clean = validAlertValue(value)
  if (!providerId || !rowKey || clean === null) return
  $alertAt.set({ ...$alertAt.get(), [providerId + ':' + rowKey]: clean })
}

/* ---------- alerts (native notification, deduped) ---------- */

/* Two polls seconds apart compute a reset time that differs by a few seconds.
 * Compare reset times within a tolerance instead of bucketing them: bucketing
 * still flips when the value crosses a bucket edge. */
export const RESET_TOLERANCE_MS = 120000

export function sameReset(seen, prefix, stamp) {
  const keys = Object.keys(seen)
  for (const key of keys) {
    if (key.indexOf(prefix) !== 0) continue
    const was = Date.parse(key.slice(prefix.length))
    if (!isFinite(was) || was <= 0) continue
    if (Math.abs(was - stamp) <= RESET_TOLERANCE_MS) return true
  }
  return false
}

export function checkAlerts(data) {
  if (!storage || !data || !Array.isArray(data.providers)) return
  if (staleBackend(data)) return
  try {
    const seen = storage.get(STORE_ALERTS, {}) || {}
    const now = Date.now()
    const day = Math.floor(now / 86400000)
    let dirty = false

    const fire = (key, title, body) => {
      if (seen[key]) return
      seen[key] = now
      dirty = true
      if (osNotify) {
        try {
          osNotify({ title: title, body: body })
        } catch {
          /* native notification unavailable */
        }
      }
    }

    for (const p of data.providers) {
      if (p.status !== 'ok') continue
      for (const w of p.windows || []) {
        if (!w || w.indicative === true) continue
        const at = alertThreshold($alertAt.get(), p.id, w)
        if (at === 'off') continue
        if (at === null) {
          if (w.warn !== true) continue
        } else if ((Number(w.used_pct) || 0) < Number(at)) {
          continue
        }
        const eta = Number(w.actionable_eta)
        const bits = []
        if (isFinite(eta) && eta > 0) bits.push('At this rate, 100% in ' + fmtEta(eta))
        const r = etaText(w.resets_at)
        if (r) bits.push(r)
        const prefix = p.id + ':' + w.key + ':'
        const stamp = Date.parse(w.resets_at) || 0
        if (stamp && sameReset(seen, prefix, stamp)) continue
        fire(
          prefix + (w.resets_at || 'no-reset'),
          p.name + ': ' + w.label + ' at ' + Math.round(Number(w.used_pct) || 0) + '% used',
          bits.join(' · ')
        )
      }
      for (const m of p.money || []) {
        if (m.warn !== true) continue
        const eta = Number(m.actionable_eta)
        const bits = []
        if (isFinite(eta) && eta > 0) bits.push('At this rate, exhausted in ' + fmtEta(eta))
        bits.push(money(m.left, m.cur) + ' of ' + money(m.total, m.cur) + ' left')
        fire(
          p.id + ':' + m.key + ':' + day,
          p.name + ': ' + m.label + ' at ' + Math.round(Number(m.used_pct) || 0) + '% used',
          bits.join(' · ')
        )
      }
    }

    if (dirty) {
      const cut = now - 30 * 86400000
      const entries = Object.entries(seen)
        .filter(e => e[1] > cut)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 80)
      storage.set(STORE_ALERTS, Object.fromEntries(entries))
    }
  } catch {
    /* never break the bar over alerts */
  }
}

/* One row as the panel renders it: the label, the value text in the current
 * mode, the bar width and the ETA the backend already judged actionable.
 * Windows and money rows answer the same shape, so the bar, the popover and
 * the detail list cannot drift apart. */
export function rowView(row, mode) {
  const used = mode !== 'remaining'
  if (row && row.kind === 'money') {
    const total = Number(row.total) || 0
    const left = Number(row.left) || 0
    const amount = total > 0 ? (used ? Math.max(0, total - left) : left) : left
    const key = String(row.key || '')
    let label = row.label
    if (used && total > 0) {
      // A used amount must not read as a balance: the row key says which
      // heading is honest, whatever the provider calls the row.
      if (key.indexOf('money:balance') === 0) label = 'Spent'
      else if (key.indexOf('money:key_cap') === 0) label = 'Cap used'
    }
    const cap = row.used_pct === null || row.used_pct === undefined ? null : Number(row.used_pct)
    const share = cap === null || !isFinite(cap) ? 0 : Math.max(0, Math.min(100, cap))
    const shown = used ? share : 100 - share
    return {
      label: label,
      value: money(amount, row.cur),
      totalText: total > 0 ? money(total, row.cur) : '',
      shown: cap === null ? 0 : shown,
      eta: Number(row.actionable_eta) || null
    }
  }
  const u = usedPercentOf(row)
  const shown = used ? u : 100 - u
  return {
    label: row ? row.label : '',
    value: pct(shown),
    totalText: '',
    shown: shown,
    eta: Number(row && row.actionable_eta) || null
  }
}

/* ---------- redesign phase 1: pins, session follow, grouping, bar layout ---------- */

/* A pin set is the same atom, and the same storage key, the eye toggles
 * wrote: null = never touched (a saved array therefore carries over
 * unchanged), an array = the pinned provider ids. */
export function pinnedIds(set, ids) {
  const pinned = Array.isArray(set) ? set : []
  if (!Array.isArray(ids)) return []
  return ids.filter(id => pinned.indexOf(id) !== -1)
}

export function togglePin(set, id) {
  const pins = Array.isArray(set) ? set.slice() : []
  return pins.indexOf(id) === -1 ? pins.concat([id]) : pins.filter(x => x !== id)
}

export function allPinned(set, ids) {
  if (!Array.isArray(ids) || !ids.length) return false
  return pinnedIds(set, ids).length === ids.length
}

/* Hermes provider aliases (hermes_cli/auth.py `_PROVIDER_ALIASES`) for the
 * ids this plugin covers, plus the regional ids that report as their own
 * provider. Anything else passes through lower-cased. */
const PROVIDER_ALIASES = {
  'minimax-cn': 'minimax',
  'kimi-coding-cn': 'kimi-coding',
  'copilot-acp': 'copilot',
  glm: 'zai',
  'z-ai': 'zai',
  'z.ai': 'zai',
  zhipu: 'zai',
  kimi: 'kimi-coding',
  'kimi-for-coding': 'kimi-coding',
  moonshot: 'kimi-coding',
  'kimi-cn': 'kimi-coding',
  'moonshot-cn': 'kimi-coding',
  'minimax-china': 'minimax',
  minimax_cn: 'minimax',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  go: 'opencode-go',
  'opencode-go-sub': 'opencode-go',
  github: 'copilot',
  'github-copilot': 'copilot',
  'github-models': 'copilot',
  'github-model': 'copilot',
  or: 'openrouter'
}

export function normaliseProvider(raw) {
  if (typeof raw !== 'string') return null
  const id = raw.trim().toLowerCase()
  if (!id) return null
  return PROVIDER_ALIASES[id] || id
}

/* Pins win. With no pins the bar follows the focused session's provider,
 * and falls back to plain "Usage" when that provider is not ours. */
export function barProviderIds(set, ids, sessionProvider) {
  const known = Array.isArray(ids) ? ids : []
  const pins = pinnedIds(set, known)
  if (pins.length) return pins
  const id = normaliseProvider(sessionProvider)
  return id !== null && known.indexOf(id) !== -1 ? [id] : []
}

const SESSION_READ_TIMEOUT_MS = 4000

/* Read the focused session's provider from `model.options` once per focus or
 * model change, never per poll. `host` needs only `request`, so a test can
 * pass a stub. A missing API, a throw, a timeout, a missing session id or a
 * non-string provider all count as null. */
export function readSessionProvider(host, sessionId, timeoutMs) {
  if (!host || typeof host.request !== 'function') return Promise.resolve(null)
  if (!sessionId) return Promise.resolve(null)
  const budget = isFinite(Number(timeoutMs)) ? Number(timeoutMs) : SESSION_READ_TIMEOUT_MS
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), budget)
    let request
    try {
      request = host.request('model.options', { session_id: sessionId })
    } catch {
      done(null)
      return
    }
    Promise.resolve(request).then(
      res => done(res && typeof res.provider === 'string' ? res.provider : null),
      () => done(null)
    )
  })
}

/* The current backend stamps every row with `key` and `used_pct`. A loaded
 * backend from before that contract has neither, so its rows would read as
 * 100% with no key. A money row may legitimately carry used_pct null (no
 * total), so presence, not value, is what counts. */
export function staleBackend(data) {
  if (!data || !Array.isArray(data.providers)) return false
  for (const p of data.providers) {
    if (!p || p.status !== 'ok') continue
    for (const row of rowsOf(p)) {
      if (!row || typeof row !== 'object') continue
      if (!('key' in row) || !('used_pct' in row)) return true
    }
  }
  return false
}

const STALE_BACKEND_TEXT = 'Restart the Hermes dashboard to finish updating.'
const WARN_COLOR = 'var(--color-amber-600, oklch(0.666 0.179 58.318))'
const ACCENT_COLOR = 'var(--ui-accent)'

/* One attention rule for the provider group, the chart colour and a quota cell. */
export function rowAttention(row, nowMs) {
  if (!row || row.indicative === true) return false
  if (row.warn === true) return true
  if (row.actionable_eta !== null && row.actionable_eta !== undefined) return true
  return projectedFull(row, nowMs) !== null
}

/* A provider needs attention when it is ok and one of its rows is warned,
 * already carries an actionable ETA, or projects to full before its reset. */
export function providerAttention(p, nowMs) {
  if (!p || p.status !== 'ok') return false
  const now = nowOf(nowMs)
  for (const row of rowsOf(p)) {
    if (rowAttention(row, now)) return true
  }
  return false
}

/* The earliest actionable ETA in the provider, worded for its kind. A window
 * also considers its derived run-out when eta_seconds is absent. */
export function attentionNote(p, nowMs) {
  if (!p || p.status !== 'ok') return ''
  const now = nowOf(nowMs)
  let best = null
  const consider = (eta, money) => {
    const value = Number(eta)
    if (!isFinite(value) || value <= 0) return
    if (best === null || value < best.value) best = { value: value, money: money }
  }
  for (const w of p.windows || []) {
    if (!w || w.indicative === true) continue
    consider(w.actionable_eta, false)
    consider(projectedFull(w, now), false)
  }
  for (const m of p.money || []) consider(m && m.actionable_eta, true)
  if (best === null) return ''
  return (best.money ? 'runs out ' : 'full ') + fmtEta(best.value)
}

/* Attention first, backend order kept inside each group. */
export function groupProviders(providers, view, set, nowMs) {
  const rows = Array.isArray(providers) ? providers : []
  const pins = pinnedIds(set, rows.map(p => p.id))
  const kept = view === 'pinned' ? rows.filter(p => pins.indexOf(p.id) !== -1) : rows.slice()
  const now = nowOf(nowMs)
  const attention = []
  const rest = []
  for (const p of kept) {
    if (providerAttention(p, now)) attention.push(p)
    else rest.push(p)
  }
  const groups = []
  if (attention.length) groups.push({ title: 'Needs attention', rows: attention })
  if (rest.length) groups.push({ title: attention.length ? 'Everything else' : 'Providers', rows: rest })
  return groups
}

/* A provider's quotas are its windows then its money rows. */
function quotaEntries(p) {
  const list = []
  for (const w of Array.isArray(p && p.windows) ? p.windows : []) {
    list.push({ row: w, money: false, index: list.length })
  }
  for (const m of Array.isArray(p && p.money) ? p.money : []) {
    list.push({ row: m, money: true, index: list.length })
  }
  return list
}

function quotaUsed(row) {
  const raw = row && row.used_pct
  if (raw === null || raw === undefined) return -Infinity
  const n = Number(raw)
  return isFinite(n) ? n : -Infinity
}

/* The quota the bar shows: the user's choice when it still names one of this
 * provider's current rows, else the highest used_pct across windows and money
 * (null lowest, ties in payload order, no usable value at all = first row).
 * Indicative rows never win the automatic pick. */
export function barQuotaKey(p, choice) {
  if (!p) return null
  const rows = rowsOf(p)
  if (!rows.length) return null
  const picked = choice && typeof choice === 'object' ? choice[p.id] : null
  if (picked && rows.some(r => r && r.key === picked)) return picked
  let best = null
  let bestUsed = -Infinity
  for (const row of rows) {
    if (!row || row.indicative === true) continue
    const score = quotaUsed(row)
    if (best === null || score > bestUsed) {
      best = row
      bestUsed = score
    }
  }
  return best ? best.key : null
}

/* Three or fewer quotas: all of them. More: the three highest by used_pct
 * (null lowest, ties in payload order) plus the bar quota, displayed as
 * windows by length ascending (unknown last), then money rows. */
export function visibleQuotas(p, barKey) {
  const all = quotaEntries(p)
  if (all.length <= 3) return { shown: all.map(e => e.row), more: 0 }
  const ranked = all.slice().sort((a, b) => {
    const diff = quotaUsed(b.row) - quotaUsed(a.row)
    return diff !== 0 ? diff : a.index - b.index
  })
  const top = ranked.slice(0, 3)
  if (barKey && !top.some(e => e.row && e.row.key === barKey)) {
    const bar = ranked.find(e => e.row && e.row.key === barKey)
    if (bar) top[top.length - 1] = bar
  }
  const windows = top.filter(e => !e.money).sort((a, b) => {
    const da = Number(a.row.duration_seconds)
    const db = Number(b.row.duration_seconds)
    const va = isFinite(da) && da > 0 ? da : Infinity
    const vb = isFinite(db) && db > 0 ? db : Infinity
    if (va !== vb) return va - vb
    return a.index - b.index
  })
  const money = top.filter(e => e.money).sort((a, b) => a.index - b.index)
  const shown = windows.concat(money).map(e => e.row)
  return { shown: shown, more: all.length - shown.length }
}

/* ---------- detail chart ---------- */

const CHART_W = 336
const CHART_HISTORY_W = 220
const CHART_H = 70
const CHART_BASE = 66
const CHART_SCALE = 0.64
const CHART_HISTORY_S = 21600

function chartY(pct) {
  const y = CHART_BASE - clampPct(pct) * CHART_SCALE
  return Math.round(y * 100) / 100
}

/* Burn rate in percentage points per second for a window, or null. */
function windowRate(row) {
  const used = Number(row.used_pct)
  const eta = Number(row.eta_seconds)
  if (!isFinite(used) || !isFinite(eta) || eta <= 0) return null
  return (100 - used) / eta
}

/* Average pace from the window itself, for rows without a measured rate:
 * elapsed = duration_seconds - seconds to resets_at. Null unless the row has
 * a duration, a reset time, an elapsed share above zero and a numeric used
 * percent. */
export function derivedRate(row, nowMs) {
  if (!row || row.kind === 'money') return null
  const duration = Number(row.duration_seconds)
  const reset = Date.parse(row.resets_at)
  const now = nowOf(nowMs)
  const used = Number(row.used_pct)
  if (!isFinite(duration) || duration <= 0 || !isFinite(reset) || !isFinite(used)) return null
  const elapsed = duration - (reset - now) / 1000
  if (!(elapsed > 0)) return null
  return { duration: duration, elapsed: elapsed, rate: used / elapsed }
}

/* Seconds until a window reaches 100% at its derived pace, when that happens
 * before the reset. Rows with eta_seconds defer to the backend's actionable_eta;
 * the first tenth of a window is too noisy to project. */
export function projectedFull(row, nowMs) {
  if (!row || row.kind === 'money') return null
  const raw = row.used_pct
  if (raw === null || raw === undefined) return null
  const used = Number(raw)
  if (!isFinite(used) || used >= 100) return null
  if (windowRate(row) !== null) return null
  const derived = derivedRate(row, nowMs)
  if (!derived || derived.elapsed < derived.duration * 0.1) return null
  if (!(derived.rate > 0)) return null
  const seconds = (100 - used) / derived.rate
  if (!(seconds > 0)) return null
  const now = nowOf(nowMs)
  const untilReset = (Date.parse(row.resets_at) - now) / 1000
  return seconds < untilReset ? seconds : null
}

/* History is [epoch seconds, value]; windows store the used percent, money
 * rows store the used amount in the row's currency (see _row_history in
 * dashboard/plugin_api.py). Money values are divided by the row total so the
 * chart stays on the same 0-100 axis. */
export function chartModel(row, nowMs, alertAt, mode) {
  if (!row) return null
  const isMoney = row.kind === 'money'
  const raw = row.used_pct
  if (raw === null || raw === undefined) return null
  const remaining = mode === 'remaining'
  const plotY = pct => chartY(remaining ? 100 - pct : pct)
  const threshold =
    row.indicative === true
      ? null
      : alertAt === 'off'
        ? null
        : alertAt === null || alertAt === undefined
          ? 80
          : Number(alertAt)
  const used = clampPct(raw)
  const now = nowOf(nowMs)
  const duration = Number(row.duration_seconds)
  const reset = Date.parse(row.resets_at)
  const windowAxis = !isMoney && row.indicative !== true && isFinite(duration) && duration > 0 && isFinite(reset)
  const durationMs = windowAxis ? duration * 1000 : 0
  const start = windowAxis ? reset - durationMs : 0
  const nowX = windowAxis
    ? Math.max(0, Math.min(1, (now - start) / durationMs)) * CHART_W
    : CHART_HISTORY_W
  const total = Number(row.total) || 0
  const history = Array.isArray(row.history) ? row.history : []
  const timed = []
  for (const sample of history) {
    if (!Array.isArray(sample) || sample.length < 2) continue
    const t = Number(sample[0])
    const v = Number(sample[1])
    if (!isFinite(t) || !isFinite(v)) continue
    if (windowAxis) {
      const tMs = t * 1000
      if (tMs < start || tMs > now) continue
    } else {
      const age = now / 1000 - t
      if (age < 0 || age > CHART_HISTORY_S) continue
    }
    const pct = isMoney ? (total > 0 ? (v / total) * 100 : v) : v
    const x = windowAxis
      ? Math.max(0, Math.min(1, (t * 1000 - start) / durationMs)) * CHART_W
      : CHART_HISTORY_W - ((now / 1000 - t) / CHART_HISTORY_S) * CHART_HISTORY_W
    timed.push({ t: t, point: [x, plotY(pct)] })
  }
  timed.sort((a, b) => a.t - b.t)
  const points = timed.map(item => item.point)
  const gap = Math.max(20 * 60, windowAxis ? duration / 50 : 0)
  const segments = []
  const bridges = []
  let segment = []
  let previous = null
  for (const item of timed) {
    if (segment.length && previous && item.t - previous.t > gap) {
      segments.push(segment)
      bridges.push([previous.point, item.point])
      segment = []
    }
    segment.push(item.point)
    previous = item
  }
  if (segment.length) segments.push(segment)
  const derived = isMoney ? null : derivedRate(row, now)
  const average = points.length < 2 && derived !== null
  const series =
    points.length >= 2
      ? points
      : average
        ? [[0, plotY(0)], [nowX, plotY(used)]]
        : [[nowX, plotY(used)]]
  const leadIn =
    windowAxis && points.length >= 1 && points[0][0] > 2
      ? [[0, plotY(0)], [points[0][0], points[0][1]]]
      : null
  const measured = isMoney ? null : windowRate(row)
  const rate = isMoney ? null : average ? derived.rate : measured !== null ? measured : derived ? derived.rate : null
  let projection = null
  let valueAtReset = null
  let overflow = false
  if (isMoney) {
    const depletes = Number(row.depletes_in_seconds)
    if (isFinite(depletes) && depletes > 0) {
      projection = { x0: nowX, y0: plotY(used), x1: CHART_W, y1: plotY(100) }
      valueAtReset = 100
      overflow = true
    }
  } else {
    if (isFinite(reset) && reset > now) {
      const seconds = (reset - now) / 1000
      valueAtReset = used + (rate === null ? 0 : rate * seconds)
      if (valueAtReset >= 100) {
        overflow = true
        const to100 = rate > 0 ? (100 - used) / rate : seconds
        const x = Math.min(CHART_W, nowX + (to100 / seconds) * (CHART_W - nowX))
        projection = { x0: nowX, y0: plotY(used), x1: x, y1: plotY(100) }
      } else {
        projection = { x0: nowX, y0: plotY(used), x1: CHART_W, y1: plotY(valueAtReset) }
      }
    }
  }
  const alert =
    threshold === null
      ? null
      : {
          value: threshold,
          y: plotY(threshold),
          label: remaining ? 'alert ' + threshold + '% used' : 'alert ' + threshold + '%'
        }
  let nowLabel = { x: CHART_HISTORY_W + 3, y: 68, anchor: 'start' }
  if (windowAxis) {
    const currentY = plotY(used)
    const anchor = nowX > CHART_W - 24 ? 'end' : 'start'
    const x = anchor === 'start' ? nowX + 3 : nowX - 3
    let y = currentY < CHART_H / 2 ? 68 : 9
    if (alert && y === 9) {
      const alertY = Math.max(9, alert.y - 3.8)
      const alertWidth = alert.label.length * 4.7
      const labelLeft = anchor === 'start' ? x : x - 15
      const labelRight = anchor === 'start' ? x + 15 : x
      if (labelLeft < alertWidth && labelRight > 0 && alertY + 10 <= 68) y = alertY + 10
    }
    if (Math.abs(y - currentY) < 6) y = currentY < CHART_H / 2 ? 68 : 9
    nowLabel = { x: x, y: y, anchor: anchor }
  }
  const amber = rowAttention(row, now)
  return {
    series: series,
    segments: segments,
    bridges: bridges,
    leadIn: leadIn,
    leadInInferred: leadIn !== null,
    current: [nowX, plotY(used)],
    nowX: nowX,
    nowLabel: nowLabel,
    projection: projection,
    valueAtReset: valueAtReset === null ? null : Math.round(valueAtReset),
    rate: rate,
    average: average,
    overflow: overflow,
    alert: alert,
    colour: amber ? 'amber' : 'accent'
  }
}

export function statsFor(row, nowMs, mode) {
  if (!row) return []
  const raw = row.used_pct
  const used = raw === null || raw === undefined ? null : clampPct(raw)
  const now = nowOf(nowMs)
  const remaining = mode === 'remaining'
  if (row.kind === 'money') {
    const left = Number(row.left)
    const depletes = Number(row.depletes_in_seconds)
    const spend =
      isFinite(left) && isFinite(depletes) && depletes > 0
        ? money((left / depletes) * 86400, row.cur) + '/d'
        : '-'
    return [
      { label: 'Spend', value: spend },
      { label: 'Lasts', value: isFinite(depletes) && depletes > 0 ? fmtEta(depletes) : '-' },
      remaining
        ? { label: 'Left', value: used === null ? '-' : pct(100 - used) }
        : { label: 'Used', value: used === null ? '-' : pct(used) }
    ]
  }
  const measured = windowRate(row)
  const derived = derivedRate(row, now)
  const rate = measured !== null ? measured : derived ? derived.rate : null
  const reset = Date.parse(row.resets_at)
  let atReset = null
  if (used !== null && rate !== null) {
    if (measured !== null) {
      if (isFinite(reset) && reset > now) atReset = used + rate * ((reset - now) / 1000)
    } else {
      atReset = (used * derived.duration) / derived.elapsed
    }
  }
  const perDay = Number(row.duration_seconds) > 7 * 86400
  const burn = rate === null ? '-' : (rate * (perDay ? 86400 : 3600)).toFixed(1) + (perDay ? '%/d' : '%/h')
  const pace = atReset === null ? null : atReset / 100
  const paceText =
    pace === null
      ? '-'
      : Number(pace.toFixed(2)) === 0
        ? '0×'
        : pace < 0.1
          ? pace.toFixed(2) + '×'
          : pace.toFixed(1) + '×'
  let atResetText = '-'
  if (atReset !== null) {
    if (atReset >= 100) {
      atResetText = 'runs out'
    } else if (remaining) {
      atResetText = '~' + Math.round(Math.max(0, 100 - atReset)) + '% left'
    } else {
      atResetText = '~' + Math.round(atReset) + '%'
    }
  }
  return [
    { label: 'Burn', value: burn },
    {
      label: 'At reset',
      value: atResetText,
      warn: atReset !== null && atReset >= 100
    },
    { label: 'Pace', value: paceText }
  ]
}

/* ---------- status-bar compaction ---------- */

const CHAR_PX = 6.5

function barOrder(entries) {
  const list = Array.isArray(entries) ? entries.slice() : []
  return list.filter(e => e && e.attention).concat(list.filter(e => !(e && e.attention)))
}

function barValue(entry, bare) {
  const value = String((entry && entry.value) || '')
  return bare ? value.replace(/%$/, '') : value
}

function barText(entries, bare) {
  return entries.map(e => (e && e.code) + ' ' + barValue(e, bare)).join(' · ')
}

/* Full (1 to 3) steps down to bare (4 to 6) and then meters (7 or more) while
 * the estimated text width exceeds availPx; null means no limit. `following`
 * is true when the bar follows the session rather than pins, so the meter
 * caption only counts pins when the bar is actually pinned. */
export function barLayout(entries, following, availPx) {
  const ordered = barOrder(entries)
  if (!ordered.length) return { mode: 'none' }
  let shape = ordered.length <= 3 ? 'full' : ordered.length <= 6 ? 'bare' : 'meters'
  const limit = availPx === null || availPx === undefined ? Infinity : Number(availPx)
  const tooWide = text => isFinite(limit) && text.length * CHAR_PX > limit
  if (shape === 'full' && tooWide(barText(ordered, false))) shape = 'bare'
  if (shape === 'bare' && tooWide(barText(ordered, true))) shape = 'meters'
  if (shape === 'meters') {
    return {
      mode: 'meters',
      meters: ordered.map(e => {
        const raw = e.used_pct
        const height = raw === null || raw === undefined ? 30 : clampPct(raw)
        return { code: e.code, height: height }
      }),
      summary: (() => {
        const urgent = ordered.find(e => e.attention)
        return urgent ? urgent.code + ' ' + urgent.value : 'all ok'
      })(),
      pinned: following ? '' : ordered.length + ' pinned'
    }
  }
  return { mode: shape, text: barText(ordered, shape === 'bare') }
}

/* What the bar tooltip lists, one line per bar provider, same order. */
export function tipEntries(entries) {
  return barOrder(entries).map(e => ({
    name: e.name,
    label: e.label,
    value: e.value,
    attention: e.attention === true
  }))
}

/* ---------- bar item (live) ---------- */

export function barModel(providers, set, sessionProvider, mode, availPx, choice) {
  const rows = Array.isArray(providers) ? providers : []
  /* Every provider id, in payload order: a pinned provider whose fetch failed
   * must stay in the bar as '-' rather than vanish. */
  const known = rows.map(p => p.id)
  const following = !(Array.isArray(set) && set.length)
  const ids = barProviderIds(set, known, sessionProvider)
  const visible = rows.filter(p => ids.indexOf(p.id) !== -1)
  const entries = visible.map(p => {
    const key = barQuotaKey(p, choice)
    const row = rowsOf(p).find(r => r && r.key === key) || null
    const value = row && p.status === 'ok' ? rowView(row, mode).value : '-'
    return {
      id: p.id,
      code: p.code || p.id,
      value: value,
      used_pct: row ? row.used_pct : null,
      attention: providerAttention(p),
      name: p.name,
      label: row ? row.label : ''
    }
  })
  return { following: following, entries: entries, layout: barLayout(entries, following, availPx) }
}

/* Wires the two host atoms to the reader. One subscription set per mount;
 * the effect in BarDetail runs once, so renders and polls never re-read. */
export function watchSessionProvider(hostApi, focusAtom, modelAtom, onValue) {
  let live = true
  let seq = 0
  const read = () => {
    const ticket = ++seq
    readSessionProvider(hostApi, focusAtom.get()).then(v => {
      /* A slow reply for the previous session must not overwrite the current
       * one: only the latest read, while live, may publish. */
      if (live && ticket === seq) onValue(v)
    })
  }
  read()
  const offFocus = focusAtom.listen(read)
  const offModel = modelAtom.listen(read)
  return () => {
    live = false
    offFocus()
    offModel()
  }
}

function useAvailPx() {
  const read = () => (typeof window === 'undefined' ? null : Math.max(120, Math.round(window.innerWidth * 0.3)))
  const [avail, setAvail] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setAvail(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return avail
}

function BarDetail() {
  const { data, isError } = useUsage()
  const mode = useValue($mode)
  const barSet = useValue($barProviders)
  const sessionProvider = useValue($sessionProvider)
  const choice = useValue($barQuota)
  const avail = useAvailPx()

  useEffect(() => {
    return watchSessionProvider(host, host.state.focusedSessionId, host.state.model, v => $sessionProvider.set(v))
  }, [])

  useEffect(() => {
    if (data) checkAlerts(data)
  }, [data])

  if (isError) return 'backend down'
  if (!data) return '…'
  if (staleBackend(data)) return 'restart dashboard'
  return barContent(barModel(data.providers || [], barSet, sessionProvider, mode, avail, choice))
}

/* Hook-free render of a bar model: tests build the model and read this. */
export function barContent(model) {
  const layout = model.layout
  if (layout.mode === 'none') return 'Usage'
  const ordered = barOrder(model.entries)
  if (layout.mode === 'meters') {
    const urgent = ordered.some(e => e.attention)
    return jsxs('span', {
      style: { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ui-text-tertiary)' },
      children: [
        ...ordered.map((e, i) => jsx('span', {
          key: e.id,
          style: {
            width: 4,
            height: Math.max(2, Math.round((layout.meters[i] ? layout.meters[i].height : 30) * 0.12)),
            borderRadius: 2,
            display: 'inline-block',
            flex: 'none',
            background: e.attention ? WARN_COLOR : ACCENT_COLOR
          }
        })),
        jsx('span', {
          key: 'summary',
          style: { marginLeft: 2, color: urgent ? WARN_COLOR : undefined },
          children: layout.summary
        }),
        layout.pinned
          ? jsx('span', { key: 'pinned', style: { opacity: 0.7 }, children: layout.pinned })
          : null
      ]
    })
  }
  const parts = []
  ordered.forEach((e, i) => {
    if (i) parts.push(' · ')
    parts.push(jsx('span', {
      key: e.id,
      style: { color: e.attention ? WARN_COLOR : undefined },
      children: e.code + ' ' + barValue(e, layout.mode === 'bare')
    }))
  })
  return jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: parts })
}

export function tipBody(lines, stamp) {
  const body = lines.length
    ? lines.map((line, i) =>
        jsxs('div', {
          key: 'q' + i,
          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
          children: [
            jsx('span', {
              style: {
                width: 4,
                height: 10,
                borderRadius: 2,
                display: 'inline-block',
                flex: 'none',
                background: line.attention ? WARN_COLOR : ACCENT_COLOR
              }
            }),
            jsx('span', { style: { fontWeight: 500, whiteSpace: 'nowrap' }, children: line.name }),
            jsx('span', { style: { opacity: 0.6, whiteSpace: 'nowrap' }, children: line.label }),
            jsx('span', {
              style: { marginLeft: 'auto', fontSize: 11, fontWeight: 500, ...MONO, whiteSpace: 'nowrap', color: line.attention ? WARN_COLOR : undefined },
              children: line.value
            })
          ]
        })
      )
    : [jsx('div', { key: 'empty', children: 'Pin a provider, or open a chat that uses one' })]
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 250, fontSize: 11, textAlign: 'left' },
    children: [
      ...body,
      jsx('div', {
        key: 'foot',
        style: {
          borderTop: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
          paddingTop: 6,
          marginTop: 2,
          fontSize: 10.5,
          opacity: 0.6
        },
        children: 'Click to open · updated ' + (stamp || '')
      })
    ]
  })
}

function BarTip() {
  const { data } = useUsage()
  const mode = useValue($mode)
  const barSet = useValue($barProviders)
  const sessionProvider = useValue($sessionProvider)
  const choice = useValue($barQuota)
  const rows = data && Array.isArray(data.providers) ? data.providers : []
  if (staleBackend(data)) return STALE_BACKEND_TEXT
  const model = barModel(rows, barSet, sessionProvider, mode, null, choice)
  return tipBody(tipEntries(model.entries), data ? clockOf(data.fetched_at) : '')
}

/* ---------- popover panel ---------- */

const MONO_FONT = 'var(--font-mono, ui-monospace, monospace)'
const MONO = { fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' }

export function miniSegments({ options, value, onChange, label, tabs = false, interval = false }) {
  const items = Array.isArray(options) ? options : []
  const selected = String(value)
  return jsx('div', {
    role: tabs ? 'tablist' : 'group',
    'aria-label': label,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 1,
      padding: 2,
      border: '1px solid var(--ui-stroke-tertiary)',
      borderRadius: 6,
      background: 'var(--ui-bg-secondary)'
    },
    children: items.map(option => {
      const isSelected = String(option.id) === selected
      return jsxs('button', {
        key: option.id,
        type: 'button',
        role: tabs ? 'tab' : undefined,
        'aria-selected': tabs ? isSelected : undefined,
        'aria-pressed': tabs ? undefined : isSelected,
        onClick: () => onChange(option.id),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: 0,
          borderRadius: 4,
          padding: interval ? '3px 7px' : '3px 8px',
          fontSize: interval ? 10.5 : 11,
          fontWeight: 500,
          fontFamily: interval ? MONO_FONT : undefined,
          fontVariantNumeric: interval ? 'tabular-nums' : undefined,
          lineHeight: 1.3,
          cursor: 'pointer',
          background: isSelected ? 'var(--ui-bg-elevated)' : 'transparent',
          color: isSelected ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
          whiteSpace: 'nowrap'
        },
        children: [
          option.dot
            ? jsx('span', {
                key: 'dot',
                style: { width: 5, height: 5, borderRadius: '50%', flex: 'none', background: ACCENT_COLOR }
              })
            : null,
          option.label
        ]
      })
    })
  })
}

function clockOf(iso) {
  const t = Date.parse(iso)
  if (!isFinite(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const PIN_PATHS = [
  'M12 17v5',
  'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
]

/* Stale providers say why their numbers are old, in the row header. */
export function staleText(p) {
  if (!p || p.stale !== true) return ''
  const hold = Date.parse(p.hold_until)
  if (isFinite(hold) && hold > Date.now()) return 'retry ' + clockOf(p.hold_until)
  return p.fetched_at ? 'last reading ' + clockOf(p.fetched_at) : ''
}

function pinButton(p, pinned, onPin) {
  const label = (pinned ? 'Unpin ' : 'Pin ') + p.name + (pinned ? ' from status bar' : ' to status bar')
  return jsx('button', {
    type: 'button',
    'aria-pressed': pinned,
    'aria-label': label,
    title: label,
    onClick: onPin,
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 24, height: 24, flex: 'none', padding: 0, borderRadius: 5, cursor: 'pointer',
      border: '1px solid ' + (pinned ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'),
      background: pinned ? 'color-mix(in srgb, var(--ui-accent) 15%, transparent)' : 'transparent',
      color: pinned ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'
    },
    children: jsx('svg', {
      viewBox: '0 0 24 24', width: 12, height: 12, fill: pinned ? 'currentColor' : 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      children: PIN_PATHS.map((d, i) => jsx('path', { key: 'pin' + i, d: d }))
    })
  })
}

function quotaCell(row, ctx) {
  const view = rowView(row, ctx.mode)
  const isMoney = row.kind === 'money'
  const warn = rowAttention(row, ctx.now)
  /* Reset text only when the provider shows one quota: at 2 or 3 columns the
   * row has no room for it, so the window keeps label and value only. */
  const extra = isMoney
    ? Number(row.total) > 0 ? '/ ' + money(row.total, row.cur) : ''
    : ctx.columns === 1 ? etaText(row.resets_at) : ''
  const dot = ctx.barHere && row.key === ctx.barKey
  const hasWidth = row.used_pct !== null && row.used_pct !== undefined
  const ellipsis = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }
  return jsxs('div', {
    key: 'q' + (row.key || row.label),
    style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 },
        children: [
          jsx('span', {
            style: {
              width: 5,
              height: 5,
              borderRadius: '50%',
              flex: 'none',
              alignSelf: 'center',
              background: dot ? ACCENT_COLOR : 'transparent'
            }
          }),
          jsx('span', {
            style: { fontSize: 10.5, color: 'var(--ui-text-secondary)', flex: '0 1 auto', ...ellipsis },
            children: row.label
          }),
          jsx('span', {
            style: { fontSize: 11, fontWeight: 500, ...MONO, marginLeft: 'auto', flex: 'none', color: warn ? WARN_COLOR : undefined },
            children: view.value
          }),
          extra
            ? jsx('span', {
                style: { fontSize: 10, color: 'var(--ui-text-tertiary)', flex: '0 1 auto', ...ellipsis },
                children: extra
              })
            : null
        ]
      }),
      jsx('span', {
        style: {
          height: 4,
          borderRadius: 2,
          overflow: 'hidden',
          background: hasWidth ? 'var(--ui-stroke-tertiary)' : 'transparent'
        },
        children: hasWidth
          ? jsx('span', {
              style: {
                display: 'block',
                height: '100%',
                width: clampPct(view.shown) + '%',
                background: warn ? WARN_COLOR : ACCENT_COLOR
              }
            })
          : null
      })
    ]
  })
}

function chartElement(p, row, model) {
  if (!model) {
    return jsx('div', {
      style: { fontSize: 10.5, color: 'var(--ui-text-tertiary)' },
      children: 'No cap, so no chart'
    })
  }
  const amber = model.colour === 'amber'
  const segments = model.segments && model.segments.length
    ? model.segments
    : model.series.length >= 2
      ? [model.series]
      : []
  const proj = model.projection
  const pointsText = points => points.map(pt => pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ')
  return jsxs('svg', {
    viewBox: '0 0 ' + CHART_W + ' ' + CHART_H,
    width: '100%',
    role: 'img',
    'aria-label':
      p.name + ' ' + row.label + ' ' + (model.overflow ? 'projected to run out before reset' : 'on track'),
    style: { color: amber ? WARN_COLOR : ACCENT_COLOR },
    children: [
      model.alert
        ? jsx('line', {
            key: 'alert',
            x1: 0,
            y1: model.alert.y,
            x2: CHART_W,
            y2: model.alert.y,
            stroke: 'currentColor',
            strokeDasharray: '3 3',
            opacity: 0.35
          })
        : null,
      model.alert
        ? jsx('text', {
            key: 'alertLabel',
            x: 0,
            y: Math.max(9, model.alert.y - 3.8),
            fontSize: 8.5,
            fill: 'currentColor',
            opacity: 0.55,
            children: model.alert.label
          })
        : null,
      model.leadIn
        ? jsx('polyline', {
            key: 'leadIn',
            points: pointsText(model.leadIn),
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
            strokeDasharray: '3 3',
            opacity: 0.35
          })
        : null,
      segments.map((part, index) =>
        part.length >= 2
          ? jsx('polyline', {
              key: index === 0 ? 'history' : 'history-' + (index + 1),
              points: pointsText(part),
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              opacity: model.average ? 0.55 : undefined
            })
          : null
      ),
      (model.bridges || []).map((bridge, index) =>
        jsx('polyline', {
          key: 'bridge-' + (index + 1),
          points: pointsText(bridge),
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          strokeDasharray: '3 3',
          opacity: 0.35
        })
      ),
      segments.some(part => part.length >= 2)
        ? null
        : jsx('circle', { key: 'current', cx: model.current[0], cy: model.current[1], r: 3, fill: 'currentColor' }),
      proj
        ? jsx('line', {
            key: 'proj',
            x1: proj.x0,
            y1: proj.y0,
            x2: proj.x1,
            y2: proj.y1,
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeDasharray: '4 3'
          })
        : null,
      proj ? jsx('circle', { key: 'end', cx: proj.x1, cy: proj.y1, r: 3, fill: 'currentColor' }) : null,
      jsx('line', {
        key: 'now',
        x1: model.nowX,
        y1: 0,
        x2: model.nowX,
        y2: CHART_H,
        stroke: 'currentColor',
        strokeDasharray: '2 3',
        opacity: 0.35
      }),
      jsx('text', {
        key: 'nowLabel',
        x: model.nowLabel.x,
        y: model.nowLabel.y,
        textAnchor: model.nowLabel.anchor,
        fontSize: 8.5,
        fill: 'currentColor',
        opacity: 0.55,
        children: 'now'
      })
    ]
  })
}

function statsElement(row, nowMs, mode) {
  const stats = statsFor(row, nowMs, mode)
  return jsx('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 },
    children: stats.map(s =>
      jsxs('div', {
        key: s.label,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          padding: '6px 8px',
          border: '1px solid var(--ui-stroke-tertiary)',
          borderRadius: 6,
          background: 'var(--ui-bg-secondary)'
        },
        children: [
          jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-secondary)' }, children: s.label }),
          jsx('span', {
            style: { fontSize: 12, fontWeight: 500, ...MONO, color: s.warn ? WARN_COLOR : undefined },
            children: s.value
          })
        ]
      })
    )
  })
}

function actionButtonStyle(active) {
  return {
    height: 26,
    padding: '0 10px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    border: '1px solid ' + (active ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'),
    background: active ? 'color-mix(in srgb, var(--ui-accent) 15%, transparent)' : 'transparent',
    color: active ? 'var(--ui-accent)' : 'var(--ui-text-secondary)'
  }
}

/* The open row's detail panel: tabs per quota, chart, three stats, and the
 * "show this quota in the status bar" action. Hook-free for tests. */
export function expandedPanel(p, ctx) {
  const quotas = rowsOf(p)
  if (!quotas.length) return null
  const barKey = barQuotaKey(p, ctx.choice)
  const picked = ctx.tab && quotas.some(q => q && q.key === ctx.tab) ? ctx.tab : barKey
  const tabRow = quotas.find(q => q && q.key === picked) || quotas[0]
  const barHere = (ctx.barIds || []).indexOf(p.id) !== -1
  const shownInBar = barHere && tabRow.key === barKey
  const extra =
    tabRow.kind === 'money'
      ? Number(tabRow.total) > 0
        ? money(tabRow.left, tabRow.cur) + ' of ' + money(tabRow.total, tabRow.cur) + ' left'
        : money(tabRow.left, tabRow.cur) + ' left'
      : etaText(tabRow.resets_at)
  const threshold = alertThreshold(ctx.alertAt, p.id, tabRow)
  const alertable = tabRow.kind !== 'money' && tabRow.indicative !== true
  const model = chartModel(tabRow, ctx.now, threshold, ctx.mode)
  const alertLabel = threshold === 'off' ? 'Alert off' : 'Alert at ' + (threshold === null ? 80 : threshold) + '%'
  return jsxs('div', {
    style: {
      margin: '10px 0 2px 16px',
      padding: 10,
      border: '1px solid var(--ui-stroke-tertiary)',
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 9
    },
    children: [
      jsxs('div', {
        key: 'top',
        style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
        children: [
          miniSegments({
            options: quotas.map(q => ({
              id: q.key,
              label: q.label,
              dot: barHere && q.key === barKey
            })),
            value: picked,
            onChange: ctx.onTab,
            label: p.name + ' quotas',
            tabs: true
          }),
          jsx('span', {
            style: {
              marginLeft: 'auto',
              fontSize: 10.5,
              color: 'var(--ui-text-secondary)',
              whiteSpace: 'nowrap'
            },
            children: extra
          })
        ]
      }),
      chartElement(p, tabRow, model),
      statsElement(tabRow, ctx.now, ctx.mode),
      jsxs('div', {
        key: 'controls',
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        children: [
          jsx('button', {
            type: 'button',
            onClick: () => ctx.onShowInBar && ctx.onShowInBar(tabRow.key),
            style: actionButtonStyle(shownInBar),
            children: shownInBar ? 'Shown in status bar' : 'Show ' + tabRow.label + ' in status bar'
          }),
          tabRow.kind === 'money'
            ? null
            : alertable
              ? jsx('button', {
                  type: 'button',
                  onClick: ctx.onAlertToggle,
                  'aria-expanded': ctx.alertOpen === true,
                  style: actionButtonStyle(false),
                  children: alertLabel
                })
              : null
        ]
      }),
      tabRow.kind === 'money'
        ? null
        : alertable
          ? ctx.alertOpen
            ? jsxs('div', {
              key: 'alert',
              style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5 },
              children: [
                miniSegments({
                  options: ALERT_OPTIONS,
                  value: threshold === null ? '80' : String(threshold),
                  onChange: id => {
                    if (ctx.onAlert) ctx.onAlert(tabRow.key, id === 'off' ? 'off' : Number(id))
                    if (ctx.onAlertClose) ctx.onAlertClose()
                  },
                  label: 'Alert threshold',
                  interval: true
                }),
                jsx('div', {
                  style: { fontSize: 10, color: 'var(--ui-text-tertiary)' },
                  children: 'Notifications appear while Hermes is in the background.'
                })
              ]
            })
          : null
        : null
    ]
  })
}

/* One provider row, hook-free so tests can build it directly. */
export function providerRowElement(p, ctx) {
  const pins = Array.isArray(ctx.pins) ? ctx.pins : []
  const pinned = pins.indexOf(p.id) !== -1
  const barKey = barQuotaKey(p, ctx.choice)
  const barHere = (ctx.barIds || []).indexOf(p.id) !== -1
  const all = rowsOf(p)
  const toggle = pinButton(p, pinned, ctx.onPin)
  const note = attentionNote(p, ctx.now)
  const stale = staleText(p)
  const open = ctx.open === true
  const quotas = visibleQuotas(p, barKey)
  const shown = quotas.shown
  const cols = Math.max(1, Math.min(3, shown.length))
  const rowStyle = opacity => ({
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '7px 14px 9px',
    borderBottom: '1px solid var(--ui-stroke-tertiary)',
    background: open ? 'var(--ui-bg-elevated)' : 'transparent',
    opacity: opacity
  })

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
    children: [
      jsxs('button', {
        type: 'button',
        'aria-expanded': open,
        onClick: ctx.onToggle,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap'
        },
        children: [
          jsx('svg', {
            viewBox: '0 0 24 24',
            width: 11,
            height: 11,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { color: 'var(--ui-text-tertiary)', transform: open ? 'rotate(90deg)' : 'none' },
            children: jsx('path', { d: 'm9 6 6 6-6 6' })
          }),
          p.name
        ]
      }),
      jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-tertiary)', whiteSpace: 'nowrap' }, children: p.tag || '' }),
      quotas.more > 0
        ? jsx('button', {
            type: 'button',
            onClick: ctx.onMore,
            style: {
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--ui-text-tertiary)',
              fontSize: 10,
              cursor: 'pointer'
            },
            children: '+' + quotas.more + ' more'
          })
        : null,
      jsx('span', {
        style: {
          marginLeft: 'auto',
          fontSize: 10,
          fontWeight: 500,
          ...MONO,
          whiteSpace: 'nowrap',
          color: note ? WARN_COLOR : 'var(--ui-text-tertiary)'
        },
        children: note || stale
      }),
      toggle
    ]
  })

  if (p.status !== 'ok' && !all.length) {
    const text = p.error || 'fetch failed'
    return jsxs('div', {
      style: rowStyle(1),
      children: [
        header,
        jsx(Tip, {
          label: text,
          children: jsx('span', {
            style: {
              fontSize: 11,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--ui-text-tertiary)'
            },
            children: text
          })
        })
      ]
    })
  }

  return jsxs('div', {
    style: rowStyle(p.stale === true && all.length ? 0.6 : 1),
    children: [
      header,
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(' + cols + ', minmax(0, 1fr))', gap: 12, paddingLeft: 16, paddingRight: 30 },
        children: shown.map(row => quotaCell(row, { mode: ctx.mode, barKey: barKey, barHere: barHere, columns: cols, now: ctx.now }))
      }),
      open ? expandedPanel(p, ctx) : null
    ]
  })
}

/* ---------- popover ---------- */

/* Pin all when not every provider is pinned, otherwise Unpin all. */
export function pinAllSet(pins, ids) {
  return allPinned(pins, ids) ? [] : ids.slice()
}

/* One provider opens at a time: the same id closes, another replaces it. */
export function nextOpenId(current, id) {
  return current === id ? null : id
}

export function setBarQuota(providerId, key) {
  $barQuota.set({ ...$barQuota.get(), [providerId]: key })
}

export function groupHeadingElement(title) {
  return jsx('div', {
    style: {
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      padding: '8px 14px 2px',
      color: title === 'Needs attention' ? WARN_COLOR : 'var(--ui-text-tertiary)'
    },
    children: title
  })
}

function UsagePanel() {
  const { data, isError } = useUsage()
  const qc = useQueryClient()
  const mode = useValue($mode)
  const interval = useValue($interval)
  const pins = useValue($barProviders)
  const sessionProvider = useValue($sessionProvider)
  const choice = useValue($barQuota)
  const alertAt = useValue($alertAt)
  const [view, setView] = useState('all')
  const [openId, setOpenId] = useState(null)
  const [tabs, setTabs] = useState({})
  const [alertFor, setAlertFor] = useState(null)
  const [spinning, setSpinning] = useState(false)

  const refresh = () => {
    if (spinning) return
    setSpinning(true)
    fetchUsage(true)
      .then(d => qc.setQueryData(USAGE_KEY, d))
      .catch(() => {})
      .then(() => setTimeout(() => setSpinning(false), 600))
  }

  const stamp = data
    ? 'updated ' + clockOf(data.fetched_at)
    : isError
      ? 'unreachable'
      : 'loading…'

  const provs = data && Array.isArray(data.providers) ? data.providers : []
  const ids = provs.map(x => x.id)
  const pinnedCount = pinnedIds(pins, ids).length
  const everyPinned = allPinned(pins, ids)
  const now = Date.now()
  const barIds = barModel(provs, pins, sessionProvider, mode, null, choice).entries.map(e => e.id)
  const groups = groupProviders(provs, view, pins, now)
  const stale = staleBackend(data)

  const body = []
  if (stale) {
    body.push(jsx('div', {
      key: 'stale',
      style: { fontSize: 11, padding: '8px 14px', color: 'var(--ui-text-tertiary)' },
      children: STALE_BACKEND_TEXT
    }))
  } else if (isError) {
    body.push(jsx('div', { key: 'down', style: { fontSize: 11 }, children: 'Backend unreachable. Enable the plugin and retry.' }))
  } else if (data && !provs.length) {
    body.push(jsx('div', { key: 'empty', style: { fontSize: 11 }, children: 'No providers available.' }))
  } else {
    groups.forEach(group => {
      body.push(jsxs('div', {
        key: group.title,
        style: { display: 'flex', flexDirection: 'column' },
        children: [
          groupHeadingElement(group.title),
          ...group.rows.map(p => providerRowElement(p, {
            mode: mode,
            pins: pins,
            barIds: barIds,
            choice: choice,
            open: openId === p.id,
            tab: tabs[p.id],
            onToggle: () => setOpenId(cur => nextOpenId(cur, p.id)),
            onMore: () => setOpenId(p.id),
            onTab: key => setTabs(cur => ({ ...cur, [p.id]: key })),
            onShowInBar: key => setBarQuota(p.id, key),
            alertAt: alertAt,
            alertOpen: alertFor === p.id,
            onAlertToggle: () => setAlertFor(cur => (cur === p.id ? null : p.id)),
            onAlertClose: () => setAlertFor(null),
            onAlert: (rowKey, value) => setAlert(p.id, rowKey, value),
            onPin: () => $barProviders.set(togglePin($barProviders.get(), p.id)),
            now: now
          }))
        ]
      }))
    })
  }

  return jsxs('div', {
    style: { display: 'flex', width: 390, maxHeight: 'min(700px, 70vh)', flexDirection: 'column', fontSize: 12 },
    children: [
      jsx('style', { key: 'kf', children: '@keyframes hermes-usage-spin{to{transform:rotate(360deg)}}' }),
      jsxs('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px 6px' },
        children: [
          jsx('span', { style: { fontSize: 13, fontWeight: 600 }, children: 'Provider Usage' }),
          jsxs('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ui-text-secondary)' },
            children: [
              jsx('span', { style: { fontSize: 11, color: 'var(--ui-text-secondary)' }, children: stamp }),
              jsx('button', {
                type: 'button',
                onClick: refresh,
                title: 'Refresh now',
                'aria-label': 'Refresh now',
                style: {
                  display: 'inline-flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center',
                  border: '1px solid var(--ui-stroke-tertiary)', borderRadius: 6,
                  background: 'transparent', color: 'inherit', cursor: 'pointer'
                },
                children: jsx('svg', {
                  viewBox: '0 0 24 24', width: 11, height: 11, fill: 'none', stroke: 'currentColor',
                  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
                  style: spinning ? { animation: 'hermes-usage-spin .7s linear 2' } : undefined,
                  children: [
                    jsx('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
                    jsx('path', { d: 'M21 3v5h-5' }),
                    jsx('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
                    jsx('path', { d: 'M8 16H3v5' })
                  ]
                })
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        key: 'toolbar',
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '2px 12px 8px',
          borderBottom: '1px solid var(--ui-stroke-tertiary)'
        },
        children: [
          miniSegments({
            options: [{ id: 'all', label: 'All ' + provs.length }, { id: 'pinned', label: 'Pinned ' + pinnedCount }],
            value: view,
            onChange: setView,
            label: 'Provider view'
          }),
          jsx('button', {
            type: 'button',
            onClick: () => $barProviders.set(pinAllSet(pins, ids)),
            style: {
              padding: 0, border: 'none', background: 'transparent',
              color: 'var(--ui-accent)', fontSize: 11, fontWeight: 500, cursor: 'pointer'
            },
            children: everyPinned ? 'Unpin all' : 'Pin all'
          }),
          jsx('span', {
            style: { marginLeft: 'auto', fontSize: 10, color: 'var(--ui-text-tertiary)' },
            children: 'Sorted by risk'
          })
        ]
      }),
      jsx(ScrollArea, {
        key: 'body',
        style: { flex: '1 1 0%', minHeight: 0, overflowY: 'auto' },
        children: jsx('div', {
          style: { display: 'flex', flexDirection: 'column' },
          children: body
        })
      }),
      jsxs('div', {
        key: 'foot',
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          borderTop: '1px solid var(--ui-stroke-tertiary)', padding: '9px 14px'
        },
        children: [
          jsx('span', {
            style: { fontSize: 11, color: 'var(--ui-text-secondary)', whiteSpace: 'nowrap' },
            children: 'auto refresh'
          }),
          miniSegments({
            options: INTERVALS.map(o => ({ id: String(o.ms), label: o.label })),
            value: String(interval),
            onChange: id => {
              $interval.set(Number(id))
              qc.refetchQueries({ queryKey: USAGE_KEY })
            },
            label: 'Refresh interval',
            interval: true
          }),
          jsx('span', {
            style: { marginLeft: 'auto' },
            children: miniSegments({
              options: [{ id: 'used', label: 'Used' }, { id: 'remaining', label: 'Remaining' }],
              value: mode,
              onChange: id => $mode.set(id),
              label: 'Value shown'
            })
          })
        ]
      })
    ]
  })
}

/* ---------- registration ---------- */

const ICON = jsx('svg', {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: { width: 12, height: 12, display: 'block' },
  children: [jsx('path', { d: 'm12 14 4-4' }), jsx('path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' })]
})

export default {
  id: 'provider-usage',
  name: 'Provider Usage',
  description: 'Per-provider quota and balance readout in the status bar.',
  register(ctx) {
    if (!storage) bindStorage(ctx.storage)
    try {
      osNotify = ctx.os && typeof ctx.os.notify === 'function' ? ctx.os.notify.bind(ctx.os) : null
    } catch {
      osNotify = null
    }
    try {
      rest = ctx.rest || null
    } catch {
      rest = null
    }
    ctx.register({
      id: 'status',
      area: STATUSBAR_AREAS.right,
      order: 40,
      data: {
        id: 'provider-usage',
        icon: ICON,
        detail: jsx(BarDetail, {}),
        variant: 'menu',
        menuAlign: 'end',
        menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
        menuContent: () => jsx(UsagePanel, {}),
        title: jsx(BarTip, {}),
        toggleLabel: 'Provider usage'
      }
    })
  }
}
