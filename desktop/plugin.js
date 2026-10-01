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
 * Near-limit tint: any window or the OpenRouter key cap at >= 80% used
 * renders amber in the bar and in the popover rows.
 *
 * Native notification (ctx.os.notify) fires once per threshold crossing,
 * deduped per window cycle (keyed by reset time) and per day for the cap.
 *
 * Burn-rate projections: the backend reports `eta_seconds` /
 * `depletes_in_seconds` from observed history; rows show "~2d" when a
 * window would hit 100% before its reset (or a cap depletes soon).
 */
import { STATUSBAR_AREAS, atom, useQuery, useQueryClient, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const USAGE_KEY = ['plugin-provider-usage', 'backend']
const WARN_PCT = 80

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

async function fetchUsage(fresh) {
  if (!rest) throw new Error('plugin backend not bound')
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

const CUR = { USD: '$', CNY: '\u00a5', tokens: '' }
const money = (v, cur) => {
  const sym = CUR[cur] || '$'
  if (cur === 'tokens') return Number(v).toLocaleString() + ' tokens'
  return sym + Number(v).toFixed(2)
}
const pct = v => Math.round(Number(v) || 0) + '%'
const CODE = {
  'opencode-zen': 'zen',
  'opencode-go': 'go',
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
const code = p => CODE[p.id] || p.id

function etaText(iso) {
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

function fmtEta(sec) {
  const s = Number(sec)
  if (!isFinite(s) || s <= 0) return ''
  const mins = Math.round(s / 60)
  if (mins < 90) return '~' + mins + 'm'
  const hours = Math.floor(mins / 60)
  if (hours < 36) return '~' + hours + 'h'
  return '~' + Math.round(hours / 24) + 'd'
}

function usedPercentOf(w) {
  return Math.max(0, Math.min(100, Number(w && w.percent) || 0))
}

function capUsedPercent(m) {
  const total = Number(m && m.total) || 0
  const left = Number(m && m.left) || 0
  return total > 0 ? Math.max(0, Math.min(100, ((total - left) / total) * 100)) : 0
}

function providerWarn(p) {
  if (!p || p.status !== 'ok') return false
  for (const w of p.windows || []) if (usedPercentOf(w) >= WARN_PCT) return true
  for (const m of p.money || []) {
    if (m.label === 'Key cap' && capUsedPercent(m) >= WARN_PCT) return true
  }
  return false
}

/* Bar visibility: default is the FIRST provider only (provider list order);
 * once the user touches a toggle, an explicit id list decides. */
function barVisible(set, id, ids) {
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

/* A projection is actionable when the window would hit 100% BEFORE its own
 * reset (otherwise the reset saves you first). Without a reset time, only
 * projections inside a week are surfaced. */
function actionableEta(w) {
  const e = Number(w && w.eta_seconds)
  if (!isFinite(e) || e <= 0) return null
  if (w && w.resets_at) {
    const toReset = (Date.parse(w.resets_at) - Date.now()) / 1000
    if (isFinite(toReset) && e >= toReset) return null
  } else if (e > 7 * 86400) {
    return null
  }
  return e
}

/* ---------- alerts (native notification, deduped) ---------- */

function checkAlerts(data) {
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
        const u = usedPercentOf(w)
        if (u < WARN_PCT) continue
        const eta = actionableEta(w)
        const bits = []
        if (eta) bits.push('At this rate, 100% in ' + fmtEta(eta))
        const r = etaText(w.resets_at)
        if (r) bits.push(r)
        fire(
          p.id + ':' + w.label + ':' + (w.resets_at || 'no-reset'),
          p.name + ': ' + w.label + ' at ' + Math.round(u) + '% used',
          bits.join(' · ')
        )
      }
      for (const m of p.money || []) {
        if (m.label !== 'Key cap') continue
        const u = capUsedPercent(m)
        if (u < WARN_PCT) continue
        const d = Number(m.depletes_in_seconds)
        const bits = []
        if (isFinite(d) && d > 0) bits.push('At this rate, exhausted in ' + fmtEta(d))
        bits.push(money(m.left, m.cur) + ' of ' + money(m.total, m.cur) + ' left')
        fire(
          p.id + ':' + m.label + ':' + day,
          p.name + ': ' + m.label + ' at ' + Math.round(u) + '% used',
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

/* One-line summary for the bar, in the CURRENT value mode:
 * quota providers show their 5h (rolling) window, used or remaining;
 * OpenRouter shows its key-cap amount (used or left). */
function summary(p, mode) {
  if (!p || p.status !== 'ok') return '-'
  const used = mode !== 'remaining'
  const moneyRows = Array.isArray(p.money) ? p.money : []
  if (moneyRows.length) {
    const cap = moneyRows.find(m => m.label === 'Key cap') || moneyRows[0]
    const total = Number(cap.total) || 0
    const left = Number(cap.left) || 0
    if (total > 0) return money(used ? Math.max(0, total - left) : left, cap.cur)
    return money(left, cap.cur)
  }
  const wins = Array.isArray(p.windows) ? p.windows : []
  const win = wins.find(w => w.label === '5h') || wins[0]
  const u = usedPercentOf(win)
  return Math.round(used ? u : 100 - u) + '%'
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

function tipLine(p, mode) {
  if (p.status !== 'ok') return 'unavailable'
  const used = mode !== 'remaining'
  const moneyRows = Array.isArray(p.money) ? p.money : []
  if (moneyRows.length) {
    return moneyRows.map(m => {
      const total = Number(m.total) || 0
      const left = Number(m.left) || 0
      const amt = total > 0 ? (used ? Math.max(0, total - left) : left) : left
      const label = used && total > 0 ? (MONEY_LABEL_USED[m.label] || m.label) : m.label
      const d = Number(m.depletes_in_seconds)
      const tag = isFinite(d) && d > 0 ? ' (' + fmtEta(d) + ')' : ''
      const amount = money(amt, m.cur) + (total > 0 ? '/' + money(total, m.cur) : '')
      return label + ' ' + amount + tag
    }).join(' · ')
  }
  return (p.windows || []).map(w => {
    const u = usedPercentOf(w)
    const e = Number(w.eta_seconds)
    const tag = isFinite(e) && e > 0 ? ' (' + fmtEta(e) + ')' : ''
    return w.label + ' ' + pct(used ? u : 100 - u) + tag
  }).join(' · ')
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
      : [jsx('div', { key: 'load', children: 'Provider usage: loading…' })]
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

/* Money-row headings flip with the value mode so the number can never lie:
 * "Balance $9.02" would read as a balance; "Spent $9.02" reads as used. */
const MONEY_LABEL_USED = { Balance: 'Spent', 'Key cap': 'Cap used' }

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

function ProviderBlock({ p, first, mode, ids }) {
  const used = mode === 'used'
  const rows = []
  if (p.status !== 'ok') {
    rows.push(jsx('div', { key: 'err', style: { fontSize: 11, opacity: 0.8 }, children: 'unavailable: ' + (p.error || 'fetch failed') }))
  }
  for (const w of p.windows || []) {
    const usedPct = usedPercentOf(w)
    const shown = used ? usedPct : 100 - usedPct
    const aEta = actionableEta(w)
    rows.push(jsx(Row, {
      key: 'w' + w.label,
      label: w.label,
      value: pct(shown),
      width: shown,
      meta: etaText(w.resets_at),
      warn: usedPct >= WARN_PCT,
      eta: aEta ? fmtEta(aEta) : null
    }))
  }
  for (const m of p.money || []) {
    const total = Number(m.total) || 0
    const left = Number(m.left) || 0
    const shown = total > 0 ? (used ? Math.max(0, total - left) : left) : left
    const d = Number(m.depletes_in_seconds)
    const aEta = isFinite(d) && d > 0 && d < 14 * 86400 ? d : null
    rows.push(jsx(Row, {
      key: 'm' + m.label,
      label: used && total > 0 ? (MONEY_LABEL_USED[m.label] || m.label) : m.label,
      value: money(shown, m.cur),
      width: total > 0 ? (shown / total) * 100 : 0,
      meta: total > 0 ? '/ ' + money(total, m.cur) : '',
      warn: m.label === 'Key cap' && capUsedPercent(m) >= WARN_PCT,
      eta: aEta ? fmtEta(aEta) : null
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
    fetchUsage(true)
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
