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
  SegmentedControl,
  Tabs,
  TabsList,
  TabsTrigger,
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
const STORE_BAR = 'barProviders'
const STORE_BAR_QUOTA = 'barQuota'

let storage = null
let osNotify = null
let rest = null

function persist(key, value) {
  if (!storage) return
  try {
    storage.set(key, value)
  } catch (e) {
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
  } catch (e) {
    /* ignore malformed persisted state */
  }
  $interval.listen(v => persist(STORE_INTERVAL, v))
  $mode.listen(v => persist(STORE_MODE, v))
  $barProviders.listen(v => persist(STORE_BAR, v))
  $barQuota.listen(v => persist(STORE_BAR_QUOTA, v))
}

async function fetchUsage(fresh, manual) {
  if (!rest) throw new Error('plugin backend not bound')
  if (manual) return rest('/usage?fresh=1&refresh=1')
  return rest(fresh ? '/usage?fresh=1' : '/usage')
}

function useUsage() {
  const interval = useValue($interval)
  return useQuery({
    queryKey: USAGE_KEY,
    queryFn: () => fetchUsage(true),
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
  } catch (e) {
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
const CODE = {
  'opencode-go': 'opencode',
  'openai-codex': 'codex',
  openrouter: 'openrouter',
  anthropic: 'claude',
  copilot: 'copilot',
  nous: 'nous',
  zai: 'zai',
  'kimi-coding': 'kimi',
  minimax: 'minimax',
  deepseek: 'deepseek'
}
export const code = p => CODE[p.id] || p.id

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
  return Math.max(0, Math.min(100, Number(w && w.used_pct) || 0))
}

export function capUsedPercent(m) {
  const total = Number(m && m.total) || 0
  const left = Number(m && m.left) || 0
  return total > 0 ? Math.max(0, Math.min(100, ((total - left) / total) * 100)) : 0
}

export function providerWarn(p) {
  if (!p || p.status !== 'ok') return false
  const rows = (p.windows || []).concat(p.money || [])
  for (const row of rows) if (row.warn === true) return true
  return false
}

/* ---------- session provider (read on focus/model change only) ---------- */

const $sessionProvider = atom(null)

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
        } catch (e) {
          /* native notification unavailable */
        }
      }
    }

    for (const p of data.providers) {
      if (p.status !== 'ok') continue
      for (const w of p.windows || []) {
        if (w.warn !== true) continue
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
  } catch (e) {
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
      width: cap === null ? 0 : shown,
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
    width: shown,
    eta: Number(row && row.actionable_eta) || null
  }
}

/* One-line summary for the bar, in the CURRENT value mode: the bar quota row. */
export function summary(p, mode, choice) {
  if (!p || p.status !== 'ok') return '-'
  const key = barQuotaKey(p, choice)
  const row = (Array.isArray(p.windows) ? p.windows : [])
    .concat(Array.isArray(p.money) ? p.money : [])
    .find(r => r && r.key === key)
  return row ? rowView(row, mode).value : '-'
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
    } catch (e) {
      done(null)
      return
    }
    Promise.resolve(request).then(
      res => done(res && typeof res.provider === 'string' ? res.provider : null),
      () => done(null)
    )
  })
}

/* A provider needs attention when it is ok and one of its rows is warned or
 * already carries an actionable ETA. */
export function providerAttention(p) {
  if (!p || p.status !== 'ok') return false
  const rows = (p.windows || []).concat(p.money || [])
  for (const row of rows) {
    if (!row) continue
    if (row.warn === true) return true
    if (row.actionable_eta !== null && row.actionable_eta !== undefined) return true
  }
  return false
}

/* The earliest actionable ETA in the provider, worded for its kind. */
export function attentionNote(p) {
  if (!p || p.status !== 'ok') return ''
  let best = null
  const consider = (row, money) => {
    const raw = row && row.actionable_eta
    if (raw === null || raw === undefined) return
    const eta = Number(raw)
    if (!isFinite(eta) || eta <= 0) return
    if (best === null || eta < best.eta) best = { eta: eta, money: money }
  }
  for (const w of p.windows || []) consider(w, false)
  for (const m of p.money || []) consider(m, true)
  if (best === null) return ''
  return (best.money ? 'runs out ' : 'full ') + fmtEta(best.eta)
}

/* Attention first, backend order kept inside each group. */
export function groupProviders(providers, view, set) {
  const rows = Array.isArray(providers) ? providers : []
  const pins = pinnedIds(set, rows.map(p => p.id))
  const kept = view === 'pinned' ? rows.filter(p => pins.indexOf(p.id) !== -1) : rows.slice()
  const attention = kept.filter(providerAttention)
  const rest = kept.filter(p => !providerAttention(p))
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
 * (null lowest, ties in payload order, no usable value at all = first row). */
export function barQuotaKey(p, choice) {
  if (!p) return null
  const rows = (Array.isArray(p.windows) ? p.windows : []).concat(Array.isArray(p.money) ? p.money : [])
  if (!rows.length) return null
  const picked = choice && typeof choice === 'object' ? choice[p.id] : null
  if (picked && rows.some(r => r && r.key === picked)) return picked
  let best = null
  let bestUsed = -Infinity
  for (const row of rows) {
    if (!row) continue
    const raw = row.used_pct
    const used = raw === null || raw === undefined ? -Infinity : Number(raw)
    const score = isFinite(used) ? used : -Infinity
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
const CHART_BASE = 66
const CHART_SCALE = 0.64
const CHART_HISTORY_S = 21600

function chartY(pct) {
  return CHART_BASE - Math.max(0, Math.min(100, Number(pct) || 0)) * CHART_SCALE
}

/* Burn rate in percentage points per second for a window, or null. */
function windowRate(row) {
  const used = Number(row.used_pct)
  const eta = Number(row.eta_seconds)
  if (!isFinite(used) || !isFinite(eta) || eta <= 0) return null
  return (100 - used) / eta
}

/* History is [epoch seconds, value]; windows store the used percent, money
 * rows store the used amount in the row's currency (see _row_history in
 * dashboard/plugin_api.py). Money values are divided by the row total so the
 * chart stays on the same 0-100 axis. */
export function chartModel(row, nowMs) {
  if (!row) return null
  const isMoney = row.kind === 'money'
  const raw = row.used_pct
  if (raw === null || raw === undefined) return null
  const used = Math.max(0, Math.min(100, Number(raw) || 0))
  const now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const total = Number(row.total) || 0
  const history = Array.isArray(row.history) ? row.history : []
  const points = []
  for (const sample of history) {
    if (!Array.isArray(sample) || sample.length < 2) continue
    const t = Number(sample[0])
    const v = Number(sample[1])
    if (!isFinite(t) || !isFinite(v)) continue
    const age = now / 1000 - t
    if (age < 0 || age > CHART_HISTORY_S) continue
    const pct = isMoney ? (total > 0 ? (v / total) * 100 : v) : v
    points.push([CHART_HISTORY_W - (age / CHART_HISTORY_S) * CHART_HISTORY_W, chartY(pct)])
  }
  points.sort((a, b) => a[0] - b[0])
  const series = points.length >= 2 ? points : [[CHART_HISTORY_W, chartY(used)]]
  const rate = isMoney ? null : windowRate(row)
  let projection = null
  let valueAtReset = null
  let overflow = false
  if (isMoney) {
    const depletes = Number(row.depletes_in_seconds)
    if (isFinite(depletes) && depletes > 0) {
      projection = { x0: CHART_HISTORY_W, y0: chartY(used), x1: CHART_W, y1: chartY(100) }
      valueAtReset = 100
      overflow = true
    }
  } else {
    const reset = Date.parse(row.resets_at)
    if (isFinite(reset) && reset > now) {
      const seconds = (reset - now) / 1000
      valueAtReset = used + (rate === null ? 0 : rate * seconds)
      if (valueAtReset >= 100) {
        overflow = true
        const to100 = rate > 0 ? (100 - used) / rate : seconds
        const x = Math.min(CHART_W, CHART_HISTORY_W + (to100 / seconds) * (CHART_W - CHART_HISTORY_W))
        projection = { x0: CHART_HISTORY_W, y0: chartY(used), x1: x, y1: chartY(100) }
      } else {
        projection = { x0: CHART_HISTORY_W, y0: chartY(used), x1: CHART_W, y1: chartY(valueAtReset) }
      }
    }
  }
  const amber =
    row.warn === true ||
    (row.actionable_eta !== null && row.actionable_eta !== undefined)
  return {
    series: series,
    current: [CHART_HISTORY_W, chartY(used)],
    projection: projection,
    valueAtReset: valueAtReset === null ? null : Math.round(valueAtReset),
    rate: rate,
    overflow: overflow,
    colour: amber ? 'amber' : 'accent'
  }
}

export function statsFor(row, nowMs) {
  if (!row) return []
  const raw = row.used_pct
  const used = raw === null || raw === undefined ? null : Math.max(0, Math.min(100, Number(raw) || 0))
  const now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
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
      { label: 'Used', value: used === null ? '-' : pct(used) }
    ]
  }
  const rate = windowRate(row)
  const reset = Date.parse(row.resets_at)
  const atReset =
    used !== null && rate !== null && isFinite(reset) && reset > now
      ? used + rate * ((reset - now) / 1000)
      : null
  return [
    { label: 'Burn', value: rate === null ? '-' : (rate * 3600).toFixed(1) + '%/h' },
    {
      label: 'At reset',
      value: atReset === null ? '-' : atReset >= 100 ? 'runs out' : '~' + Math.round(atReset) + '%',
      warn: atReset !== null && atReset >= 100
    },
    { label: 'Pace', value: atReset === null ? '-' : (atReset / 100).toFixed(1) + '×' }
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
        const height = raw === null || raw === undefined
          ? 30
          : Math.max(0, Math.min(100, Number(raw) || 0))
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
    const row = (p.windows || []).concat(p.money || []).find(r => r && r.key === key) || null
    return {
      id: p.id,
      code: p.code || code(p),
      value: summary(p, mode, choice),
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
          className: e.attention ? 'bg-amber-600' : 'bg-(--ui-accent)',
          style: {
            width: 4,
            height: Math.max(2, Math.round((layout.meters[i] ? layout.meters[i].height : 30) * 0.12)),
            borderRadius: 2,
            display: 'inline-block',
            flex: 'none'
          }
        })),
        jsx('span', {
          key: 'summary',
          className: urgent ? 'text-amber-600' : undefined,
          style: { marginLeft: 2 },
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
      className: e.attention ? 'text-amber-600' : undefined,
      children: e.code + ' ' + barValue(e, layout.mode === 'bare')
    }))
  })
  return jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: parts })
}

export function tipLine(p, mode) {
  if (p.status !== 'ok') return 'unavailable'
  const moneyRows = Array.isArray(p.money) ? p.money : []
  if (moneyRows.length) {
    return moneyRows
      .map(m => {
        const view = rowView(m, mode)
        const tag = view.eta ? ' (' + fmtEta(view.eta) + ')' : ''
        const amount = view.value + (view.totalText ? '/' + view.totalText : '')
        return view.label + ' ' + amount + tag
      })
      .join(' · ')
  }
  return (p.windows || [])
    .map(w => {
      const view = rowView(w, mode)
      const tag = view.eta ? ' (' + fmtEta(view.eta) + ')' : ''
      return view.label + ' ' + view.value + tag
    })
    .join(' · ')
}

export function tipBody(lines, stamp) {
  const body = lines.length
    ? lines.map((line, i) =>
        jsxs('div', {
          key: 'q' + i,
          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
          children: [
            jsx('span', {
              className: line.attention ? 'bg-amber-600' : 'bg-(--ui-accent)',
              style: { width: 4, height: 10, borderRadius: 2, display: 'inline-block', flex: 'none' }
            }),
            jsx('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' }, children: line.name }),
            jsx('span', { style: { color: 'var(--ui-text-tertiary)', whiteSpace: 'nowrap' }, children: line.label }),
            jsx('span', {
              className: line.attention ? 'text-amber-600' : undefined,
              style: { marginLeft: 'auto', fontVariantNumeric: MONO, whiteSpace: 'nowrap' },
              children: line.value
            })
          ]
        })
      )
    : [jsx('div', { key: 'empty', children: 'Pin a provider, or open a chat that uses one' })]
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 250, fontSize: 11, textAlign: 'left' },
    children: [
      ...body,
      jsx('div', {
        key: 'foot',
        style: {
          borderTop: '1px solid var(--ui-stroke-tertiary)',
          paddingTop: 4,
          marginTop: 2,
          color: 'var(--ui-text-tertiary)'
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
  const model = barModel(rows, barSet, sessionProvider, mode, null, choice)
  return tipBody(tipEntries(model.entries), data ? clockOf(data.fetched_at) : '')
}

/* ---------- popover panel ---------- */

const MONO = 'tabular-nums'

function clockOf(iso) {
  const t = Date.parse(iso)
  if (!isFinite(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const PIN_PATH = 'M9 4h6M12 4v6m0 0 3 3v1H9v-1l3-3m-3 4h6l-1 6H10l-1-6'

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
      width: 24, height: 24, flex: 'none', padding: 0, borderRadius: 6, cursor: 'pointer',
      border: '1px solid ' + (pinned ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'),
      background: pinned ? 'color-mix(in srgb, var(--ui-accent) 15%, transparent)' : 'transparent',
      color: pinned ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'
    },
    children: jsx('svg', {
      viewBox: '0 0 24 24', width: 12, height: 12, fill: pinned ? 'currentColor' : 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      children: jsx('path', { key: 'pin', d: PIN_PATH })
    })
  })
}

function quotaCell(row, ctx) {
  const view = rowView(row, ctx.mode)
  const isMoney = row.kind === 'money'
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
            className: dot ? 'bg-(--ui-accent)' : undefined,
            style: {
              width: 5,
              height: 5,
              borderRadius: '50%',
              flex: 'none',
              alignSelf: 'center',
              background: dot ? undefined : 'transparent'
            }
          }),
          jsx('span', {
            style: { fontSize: 10.5, color: 'var(--ui-text-tertiary)', flex: '0 1 auto', ...ellipsis },
            children: row.label
          }),
          jsx('span', {
            className: row.warn === true ? 'text-amber-600' : undefined,
            style: { fontSize: 11, fontVariantNumeric: MONO, marginLeft: 'auto', flex: 'none' },
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
              className: row.warn === true ? 'bg-amber-600' : 'bg-(--ui-accent)',
              style: {
                display: 'block',
                height: '100%',
                width: Math.max(0, Math.min(100, Number(view.width) || 0)) + '%'
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
  const series = model.series.map(pt => pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ')
  const proj = model.projection
  return jsxs('svg', {
    viewBox: '0 0 336 70',
    width: '100%',
    role: 'img',
    'aria-label':
      p.name + ' ' + row.label + ' ' + (model.overflow ? 'projected to run out before reset' : 'on track'),
    className: amber ? 'text-amber-600' : undefined,
    style: amber ? undefined : { color: 'var(--ui-accent)' },
    children: [
      jsx('line', {
        key: 'alert',
        x1: 0,
        y1: 14.8,
        x2: 336,
        y2: 14.8,
        stroke: 'currentColor',
        strokeDasharray: '3 3',
        opacity: 0.35
      }),
      jsx('text', {
        key: 'alertLabel',
        x: 0,
        y: 11,
        fontSize: 8.5,
        fill: 'currentColor',
        opacity: 0.55,
        children: 'alert 80%'
      }),
      model.series.length >= 2
        ? jsx('polyline', {
            key: 'history',
            points: series,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinejoin: 'round',
            strokeLinecap: 'round'
          })
        : jsx('circle', { key: 'current', cx: 220, cy: model.current[1], r: 3, fill: 'currentColor' }),
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
        x1: 220,
        y1: 0,
        x2: 220,
        y2: 70,
        stroke: 'currentColor',
        strokeDasharray: '2 3',
        opacity: 0.35
      }),
      jsx('text', {
        key: 'nowLabel',
        x: 223,
        y: 68,
        fontSize: 8.5,
        fill: 'currentColor',
        opacity: 0.55,
        children: 'now'
      })
    ]
  })
}

function statsElement(row) {
  const stats = statsFor(row)
  return jsx('div', {
    style: { display: 'flex', gap: 8 },
    children: stats.map(s =>
      jsxs('div', {
        key: s.label,
        style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
        children: [
          jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: s.label }),
          jsx('span', {
            className: s.warn ? 'text-amber-600' : undefined,
            style: { fontSize: 12, fontVariantNumeric: MONO },
            children: s.value
          })
        ]
      })
    )
  })
}

/* The open row's detail panel: tabs per quota, chart, three stats, and the
 * "show this quota in the status bar" action. Hook-free for tests. */
export function expandedPanel(p, ctx) {
  const quotas = (Array.isArray(p.windows) ? p.windows : []).concat(
    Array.isArray(p.money) ? p.money : []
  )
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
  const model = chartModel(tabRow, ctx.now)
  return jsxs('div', {
    style: {
      marginLeft: 16,
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
          jsx(Tabs, {
            value: picked,
            onValueChange: ctx.onTab,
            children: jsx(TabsList, {
              className: 'h-auto gap-1 bg-transparent p-0',
              children: quotas.map(q =>
                jsxs(TabsTrigger, {
                  key: q.key,
                  value: q.key,
                  className: 'h-auto gap-1 px-1.5 py-0.5 text-[10.5px]',
                  children: [
                    jsx('span', {
                      className: barHere && q.key === barKey ? 'bg-(--ui-accent)' : undefined,
                      style: {
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        flex: 'none',
                        background: barHere && q.key === barKey ? undefined : 'transparent'
                      }
                    }),
                    q.label
                  ]
                })
              )
            })
          }),
          jsx('span', {
            style: {
              marginLeft: 'auto',
              fontSize: 10.5,
              color: 'var(--ui-text-tertiary)',
              whiteSpace: 'nowrap'
            },
            children: extra
          })
        ]
      }),
      chartElement(p, tabRow, model),
      statsElement(tabRow),
      jsx('button', {
        key: 'bar',
        type: 'button',
        onClick: () => ctx.onShowInBar && ctx.onShowInBar(tabRow.key),
        style: {
          alignSelf: 'flex-start',
          fontSize: 10.5,
          padding: '3px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid ' + (shownInBar ? 'var(--ui-accent)' : 'var(--ui-stroke-tertiary)'),
          background: shownInBar ? 'color-mix(in srgb, var(--ui-accent) 15%, transparent)' : 'transparent',
          color: shownInBar ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)'
        },
        children: shownInBar ? 'Shown in status bar' : 'Show ' + tabRow.label + ' in status bar'
      })
    ]
  })
}

/* One provider row, hook-free so tests can build it directly. */
export function providerRowElement(p, ctx) {
  const pins = Array.isArray(ctx.pins) ? ctx.pins : []
  const pinned = pins.indexOf(p.id) !== -1
  const barKey = barQuotaKey(p, ctx.choice)
  const barHere = (ctx.barIds || []).indexOf(p.id) !== -1
  const windows = Array.isArray(p.windows) ? p.windows : []
  const moneyRows = Array.isArray(p.money) ? p.money : []
  const all = windows.concat(moneyRows)
  const toggle = pinButton(p, pinned, ctx.onPin)
  const note = attentionNote(p)
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
          gap: 4,
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
          p.name,
          jsx('svg', {
            viewBox: '0 0 24 24',
            width: 9,
            height: 9,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { transform: open ? 'rotate(90deg)' : 'none' },
            children: jsx('path', { d: 'm9 6 6 6-6 6' })
          })
        ]
      }),
      jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-tertiary)', whiteSpace: 'nowrap' }, children: p.tag || '' }),
      jsx('span', {
        className: note ? 'text-amber-600' : undefined,
        style: {
          marginLeft: 'auto',
          fontSize: 10,
          fontVariantNumeric: MONO,
          whiteSpace: 'nowrap',
          color: note ? undefined : 'var(--ui-text-tertiary)'
        },
        children: note || stale
      }),
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
        style: { display: 'grid', gridTemplateColumns: 'repeat(' + cols + ', minmax(0, 1fr))', gap: 8 },
        children: shown.map(row => quotaCell(row, { mode: ctx.mode, barKey: barKey, barHere: barHere, columns: cols }))
      }),
      open ? expandedPanel(p, { mode: ctx.mode, choice: ctx.choice, barIds: ctx.barIds, tab: ctx.tab, onTab: ctx.onTab, onShowInBar: ctx.onShowInBar }) : null
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
    className: title === 'Needs attention' ? 'text-amber-600' : undefined,
    style: {
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      padding: '8px 14px 2px',
      color: title === 'Needs attention' ? undefined : 'var(--ui-text-tertiary)'
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
  const [view, setView] = useState('all')
  const [openId, setOpenId] = useState(null)
  const [tabs, setTabs] = useState({})
  const [spinning, setSpinning] = useState(false)

  const refresh = () => {
    if (spinning) return
    setSpinning(true)
    fetchUsage(true, true)
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
  const barIds = barModel(provs, pins, sessionProvider, mode, null, choice).entries.map(e => e.id)
  const groups = groupProviders(provs, view, pins)

  const body = []
  if (isError) {
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
            onPin: () => $barProviders.set(togglePin($barProviders.get(), p.id))
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
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--ui-text-tertiary)' },
            children: [
              jsx('span', { style: { fontVariantNumeric: MONO }, children: stamp }),
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
          jsx(SegmentedControl, {
            options: [{ id: 'all', label: 'All ' + provs.length }, { id: 'pinned', label: 'Pinned ' + pinnedCount }],
            value: view,
            onChange: setView
          }),
          jsx('button', {
            type: 'button',
            onClick: () => $barProviders.set(pinAllSet(pins, ids)),
            style: {
              padding: 0, border: 'none', background: 'transparent',
              color: 'var(--ui-text-tertiary)', fontSize: 11, cursor: 'pointer'
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
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: jsx('div', {
          style: { display: 'flex', flexDirection: 'column' },
          children: body
        })
      }),
      jsxs('div', {
        key: 'foot',
        style: {
          display: 'flex', alignItems: 'center', gap: 6,
          borderTop: '1px solid var(--ui-stroke-tertiary)', padding: '8px 12px'
        },
        children: [
          jsx('span', { style: { fontSize: 10, color: 'var(--ui-text-tertiary)' }, children: 'auto refresh' }),
          jsx(SegmentedControl, {
            options: INTERVALS.map(o => ({ id: String(o.ms), label: o.label })),
            value: String(interval),
            onChange: id => {
              $interval.set(Number(id))
              qc.refetchQueries({ queryKey: USAGE_KEY })
            }
          }),
          jsx('span', {
            style: { marginLeft: 'auto' },
            children: jsx(SegmentedControl, {
              options: [{ id: 'used', label: 'Used' }, { id: 'remaining', label: 'Remaining' }],
              value: mode,
              onChange: id => $mode.set(id)
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
    } catch (e) {
      osNotify = null
    }
    try {
      rest = ctx.rest || null
    } catch (e) {
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
