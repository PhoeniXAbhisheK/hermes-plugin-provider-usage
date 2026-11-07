/**
 * Provider Usage: desktop status-bar item (right cluster).
 *
 * Data: this plugin's own backend namespace
 * (/api/plugins/provider-usage/usage, served by dashboard/plugin_api.py),
 * so provider credentials stay on the local machine.
 *
 * Each provider header carries an eye toggle that shows/hides that provider
 * in the status bar; until one is touched, only the first provider shows.
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
import { STATUSBAR_AREAS, atom, useQuery, useQueryClient, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

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
/* Which providers appear in the status bar. null = default (first provider
 * only); an array of ids = an explicit choice from the panel's eye toggles. */
const $barProviders = atom(null)

const STORE_INTERVAL = 'intervalMs'
const STORE_MODE = 'valueMode'
const STORE_ALERTS = 'alerts'
const STORE_BAR = 'barProviders'

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
  } catch (e) {
    /* ignore malformed persisted state */
  }
  $interval.listen(v => persist(STORE_INTERVAL, v))
  $mode.listen(v => persist(STORE_MODE, v))
  $barProviders.listen(v => persist(STORE_BAR, v))
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

/* Bar visibility: default is the FIRST provider only (provider list order);
 * once the user touches a toggle, an explicit id list decides. */
export function barVisible(set, id, ids) {
  if (!Array.isArray(ids)) return false
  if (set === null) return ids.length > 0 && ids[0] === id
  return set.indexOf(id) !== -1
}

function toggleBarProvider(id, ids) {
  const cur = $barProviders.get()
  const effective = cur === null ? (ids.length ? [ids[0]] : []) : cur.slice()
  const next = effective.indexOf(id) === -1 ? effective.concat([id]) : effective.filter(x => x !== id)
  $barProviders.set(next)
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

/* One-line summary for the bar, in the CURRENT value mode: the shortest
 * account-scope window, or the key-cap money row. A model-scope row never
 * summarises the provider. */
export function summary(p, mode) {
  if (!p || p.status !== 'ok') return '-'
  const moneyRows = Array.isArray(p.money) ? p.money : []
  if (moneyRows.length) {
    const cap =
      moneyRows.find(m => String(m.key || '').indexOf('money:key_cap') === 0) || moneyRows[0]
    return rowView(cap, mode).value
  }
  const wins = (Array.isArray(p.windows) ? p.windows : []).filter(w => w.scope !== 'model')
  if (!wins.length) return '-'
  let pick = null
  for (const w of wins) {
    const d = Number(w.duration_seconds)
    if (!isFinite(d) || d <= 0) continue
    if (pick === null || d < Number(pick.duration_seconds)) pick = w
  }
  return rowView(pick || wins[0], mode).value
}

/* ---------- bar item (live) ---------- */

function BarDetail() {
  const { data, isError } = useUsage()
  const mode = useValue($mode)
  const barSet = useValue($barProviders)

  useEffect(() => {
    if (data) checkAlerts(data)
  }, [data])

  if (isError) return 'backend down'
  if (!data) return '…'
  const provs = data.providers || []
  const visible = barSet === null
    ? provs.slice(0, 1)
    : provs.filter(p => barSet.indexOf(p.id) !== -1)
  const parts = []
  visible.forEach((p, i) => {
    if (i) parts.push(' · ')
    parts.push(jsx('span', {
      key: p.id,
      className: providerWarn(p) ? 'text-amber-600' : undefined,
      children: code(p) + ' ' + summary(p, mode)
    }))
  })
  // The host renders plugin detail content in text-muted-foreground/80 (a
  // double-dimmed tone); force the same token built-in statusbar values use.
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

function BarTip() {
  const { data } = useUsage()
  const mode = useValue($mode)
  const rows = data && Array.isArray(data.providers) ? data.providers : []
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 235, fontSize: 11, textAlign: 'left' },
    children: rows.length
      ? rows.map(p =>
          jsxs('div', {
            key: p.id,
            style: { display: 'flex', justifyContent: 'space-between', gap: 12 },
            children: [
              jsx('span', { style: { fontWeight: 600 }, children: p.name }),
              jsx('span', { style: { opacity: 0.8, fontVariantNumeric: 'tabular-nums' }, children: tipLine(p, mode) })
            ]
          })
        )
      : [jsx('div', {
          key: data ? 'empty' : 'load',
          children: data ? 'Provider usage: no providers available' : 'Provider usage: loading…'
        })]
  })
}

/* ---------- popover panel ---------- */

const MONO = 'tabular-nums'

function Row({ label, value, width, meta, warn, eta }) {
  const raw = Number(width)
  const w = isFinite(raw) && raw > 0 ? Math.max(3, Math.min(100, raw)) : 0
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px', margin: '0 -4px', borderRadius: 5 },
    children: [
      jsx('span', {
        style: { width: 72, flex: 'none', fontSize: 12, opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        children: label
      }),
      jsx('span', {
        style: { flex: '1 1 auto', height: 3, borderRadius: 3, background: 'var(--ui-stroke-tertiary, rgba(128,132,144,.25))', overflow: 'hidden' },
        children: w > 0
          ? jsx('span', {
              style: { display: 'block', height: '100%', width: w + '%', borderRadius: 3, background: 'var(--ui-accent, #6f9dff)', opacity: 0.9 }
            })
          : null
      }),
      jsx('span', {
        style: { width: 48, flex: 'none', textAlign: 'right', fontWeight: 600, fontSize: 12, fontVariantNumeric: MONO },
        className: warn ? 'text-amber-600' : undefined,
        children: value
      }),
      jsx('span', {
        style: { width: 112, flex: 'none', textAlign: 'right', fontSize: 11, opacity: 0.7, fontVariantNumeric: MONO, whiteSpace: 'nowrap' },
        children: eta
          ? [meta, jsx('span', { key: 'eta', className: 'text-amber-600', style: { marginLeft: 4 }, children: eta })]
          : meta
      })
    ]
  })
}

/* Money-row headings flip with the value mode so the number can never lie. */

const EYE_PATH = 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'

function EyeIcon({ off }) {
  return jsx('svg', {
    viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block' },
    children: [
      jsx('path', { key: 'eye', d: EYE_PATH }),
      jsx('circle', { key: 'pupil', cx: 12, cy: 12, r: 3 }),
      off ? jsx('path', { key: 'slash', d: 'm3 3 18 18' }) : null
    ]
  })
}

/* Eye toggle: shows/hides one provider in the status bar. */
function BarToggle({ p, ids }) {
  const set = useValue($barProviders)
  const on = barVisible(set, p.id, ids)
  return jsx('button', {
    type: 'button',
    title: on ? 'Hide from status bar' : 'Show in status bar',
    'aria-label': on ? 'Hide from status bar' : 'Show in status bar',
    onClick: () => toggleBarProvider(p.id, ids),
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 16, height: 20, padding: 0, border: 'none', borderRadius: 5,
      background: 'transparent', color: 'inherit', cursor: 'pointer',
      opacity: on ? 1 : 0.6, transform: 'translate(-1.5px, -2px)'
    },
    children: jsx(EyeIcon, { off: !on })
  })
}

export function ProviderBlock({ p, first, mode, ids }) {
  const rows = []
  if (p.status !== 'ok') {
    rows.push(jsx('div', { key: 'err', style: { fontSize: 11, opacity: 0.8 }, children: 'unavailable: ' + (p.error || 'fetch failed') }))
  }
  if (p.stale && (p.hold_until || p.fetched_at)) {
    const clock = (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const bits = []
    if (p.fetched_at) bits.push('last reading ' + clock(p.fetched_at))
    if (p.hold_until) bits.push('retry after ' + clock(p.hold_until))
    rows.push(jsx('div', { key: 'stale', style: { fontSize: 11, opacity: 0.8 }, children: bits.join(' · ') }))
  }
  for (const w of p.windows || []) {
    const view = rowView(w, mode)
    rows.push(jsx(Row, {
      key: 'w' + w.key,
      label: view.label,
      value: view.value,
      width: view.width,
      meta: etaText(w.resets_at),
      warn: w.warn === true,
      eta: view.eta ? fmtEta(view.eta) : null
    }))
  }
  for (const m of p.money || []) {
    const view = rowView(m, mode)
    rows.push(jsx(Row, {
      key: 'm' + m.key,
      label: view.label,
      value: view.value,
      width: view.width,
      meta: view.totalText ? '/ ' + view.totalText : '',
      warn: m.warn === true,
      eta: view.eta ? fmtEta(view.eta) : null
    }))
  }
  return jsxs('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 3,
      borderTop: first ? 'none' : '1px solid var(--ui-stroke-tertiary, #3a3f4a)',
      paddingTop: first ? 0 : 6
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 },
        children: [
          jsxs('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 1 },
            children: [
              jsx(BarToggle, { p, ids }),
              jsx('span', { style: { fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.75 }, children: p.name })
            ]
          }),
          jsx('span', { style: { fontSize: 11, opacity: 0.6 }, children: p.tag || '' })
        ]
      }),
      ...rows
    ]
  })
}

/* ---------- footer controls ---------- */

function ModeSelect() {
  const mode = useValue($mode)
  const seg = (key, label) => {
    const active = mode === key
    return jsx('button', {
      type: 'button',
      onClick: () => $mode.set(key),
      style: {
        padding: '1px 7px', fontSize: 11, lineHeight: '16px', cursor: 'pointer', borderRadius: 5,
        border: '1px solid ' + (active ? 'var(--ui-accent, #6f9dff)' : 'var(--ui-stroke-tertiary, #3a3f4a)'),
        background: active ? 'color-mix(in srgb, var(--ui-accent, #6f9dff) 30%, transparent)' : 'transparent',
        color: 'inherit', opacity: active ? 1 : 0.72
      },
      children: label
    }, key)
  }
  return jsx('span', {
    style: { display: 'inline-flex', gap: 4 },
    children: [seg('used', 'Used'), seg('remaining', 'Remaining')]
  })
}

function IntervalSelect({ onChanged }) {
  const interval = useValue($interval)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = INTERVALS.find(o => o.ms === interval) || INTERVALS[2]

  return jsxs('span', {
    ref: wrapRef,
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 5 },
    children: [
      jsx('span', { style: { opacity: 0.7 }, children: 'auto refresh' }),
      jsxs('button', {
        type: 'button',
        onClick: () => setOpen(v => !v),
        title: 'Refresh interval',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', fontSize: 11, lineHeight: '16px',
          border: '1px solid var(--ui-stroke-tertiary, #3a3f4a)', borderRadius: 5, background: 'transparent',
          color: 'inherit', cursor: 'pointer'
        },
        children: [
          jsx('span', { children: current.label }),
          jsx('svg', {
            viewBox: '0 0 24 24', width: 9, height: 9, fill: 'none', stroke: 'currentColor',
            strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round',
            children: jsx('path', { d: 'm6 9 6 6 6-6' })
          })
        ]
      }),
      open &&
        jsx('div', {
          style: {
            position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 40,
            display: 'flex', flexDirection: 'column', gap: 1, minWidth: 58, padding: 3,
            border: '1px solid var(--ui-stroke-tertiary, #3a3f4a)', borderRadius: 7,
            background: 'var(--ui-bg-elevated, #26272b)', boxShadow: '0 6px 18px rgba(0,0,0,.35)'
          },
          children: INTERVALS.map(o =>
            jsx('button', {
              key: o.ms,
              type: 'button',
              onClick: () => {
                $interval.set(o.ms)
                setOpen(false)
                if (onChanged) onChanged(o.ms)
              },
              style: {
                textAlign: 'left', padding: '2px 8px', fontSize: 11, border: 'none', borderRadius: 5, cursor: 'pointer',
                color: 'inherit',
                background: o.ms === interval ? 'color-mix(in srgb, var(--ui-accent, #6f9dff) 30%, transparent)' : 'transparent'
              },
              children: o.label
            })
          )
        })
    ]
  })
}

/* ---------- popover ---------- */

function UsagePanel() {
  const { data, isError } = useUsage()
  const qc = useQueryClient()
  const mode = useValue($mode)
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
    ? 'updated ' + new Date(data.fetched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : isError
      ? 'unreachable'
      : 'loading…'

  const provs = data && Array.isArray(data.providers) ? data.providers : []
  const body = []
  const ids = provs.map(x => x.id)
  provs.forEach((p, i) => body.push(jsx(ProviderBlock, { p, first: i === 0, mode, ids }, p.id)))
  if (isError) {
    body.push(jsx('div', { key: 'down', style: { fontSize: 11 }, children: 'Backend unreachable. Enable the plugin and retry.' }))
  } else if (data && !provs.length) {
    body.push(jsx('div', { key: 'empty', style: { fontSize: 11 }, children: 'No providers available.' }))
  }

  return jsxs('div', {
    style: { display: 'flex', width: 320, flexDirection: 'column', gap: 9, padding: '11px 12px 10px', fontSize: 12 },
    children: [
      jsx('style', { key: 'kf', children: '@keyframes hermes-usage-spin{to{transform:rotate(360deg)}}' }),
      jsxs('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        children: [
          jsx('span', { style: { fontSize: 12, fontWeight: 650 }, children: 'Provider Usage' }),
          jsxs('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.75 },
            children: [
              jsx('span', { style: { fontVariantNumeric: MONO }, children: stamp }),
              jsx('button', {
                type: 'button',
                onClick: refresh,
                title: 'Refresh usage',
                'aria-label': 'Refresh usage',
                style: {
                  display: 'inline-flex', width: 21, height: 21, alignItems: 'center', justifyContent: 'center',
                  border: '1px solid var(--ui-stroke-tertiary, #3a3f4a)', borderRadius: 6,
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
      ...body,
      jsxs('div', {
        key: 'foot',
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          borderTop: '1px solid var(--ui-stroke-tertiary, #3a3f4a)', paddingTop: 6, fontSize: 11
        },
        children: [
          jsx(IntervalSelect, { onChanged: () => qc.refetchQueries({ queryKey: USAGE_KEY }) }, 'int'),
          jsx(ModeSelect, {}, 'mode')
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
