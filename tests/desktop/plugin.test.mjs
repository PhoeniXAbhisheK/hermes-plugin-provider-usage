import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPlugin } from './load-plugin.mjs'

const NOW = 1_700_000_000_000
const WARN_COLOR = 'var(--color-amber-600, oklch(0.666 0.179 58.318))'
const ACCENT_COLOR = 'var(--ui-accent)'

const isoAt = ms => new Date(ms).toISOString()

function frozen(ms) {
  const real = Date.now
  Date.now = () => ms
  return () => {
    Date.now = real
  }
}

function fakeContext() {
  const data = {}
  const notices = []
  const registrations = []
  const ctx = {
    storage: {
      get: (key, fallback) => (key in data ? data[key] : fallback),
      set: (key, value) => {
        data[key] = value
      }
    },
    os: { notify: note => notices.push(note) },
    rest: () => {
      throw new Error('rest is not used here')
    },
    register: arg => registrations.push(arg)
  }
  return { ctx, data, notices, registrations }
}

function barValue(barModel, p, mode, choice) {
  const provider = { id: 'p', ...p }
  return barModel([provider], [provider.id], null, mode, null, choice).entries[0].value
}

test('money follows the row currency and the en-US locale', async () => {
  const { money } = await loadPlugin()
  assert.equal(money(9.02, 'USD'), '$9.02')
  assert.equal(money(9.02, 'CNY'), 'CN¥9.02')
  assert.equal(money(9.02, 'EUR'), '€9.02')
  assert.equal(money(9.02, 'GBP'), '£9.02')
  assert.equal(money(9.02, 'CAD'), 'CA$9.02')
  assert.equal(money(1234.5, 'USD'), '$1,234.50')
  assert.equal(money(1234567.5, 'USD'), '$1,234,567.50')
  assert.equal(money('3.5', 'USD'), '$3.50')
  assert.equal(money(3.5), '$3.50')
  assert.equal(money(3.5, ''), '$3.50')
  assert.equal(money(3.5, 'usd'), '$3.50')
  assert.equal(money(1234.5, 'JPY'), '¥1,235')
  assert.equal(money(1.5, 'DOLLARS'), 'DOLLARS 1.50')
  assert.equal(money(1.5, 'dollars'), 'DOLLARS 1.50')
  assert.equal(money(1.5, 'US'), 'US 1.50')
})

test('pct rounds and treats a non-number as zero', async () => {
  const { pct } = await loadPlugin()
  assert.equal(pct(12.4), '12%')
  assert.equal(pct(12.5), '13%')
  assert.equal(pct('abc'), '0%')
  assert.equal(pct(undefined), '0%')
})

test('etaText handles the minute and hour boundaries', async () => {
  const restore = frozen(NOW)
  try {
    const { etaText } = await loadPlugin()
    assert.equal(etaText(''), '')
    assert.equal(etaText('not a date'), '')
    assert.equal(etaText(isoAt(NOW)), 'resets now')
    assert.equal(etaText(isoAt(NOW - 1000)), 'resets now')
    assert.equal(etaText(isoAt(NOW + 89 * 60000)), 'resets in 89m')
    assert.equal(etaText(isoAt(NOW + 90 * 60000)), 'resets in 1h 30m')
    assert.equal(etaText(isoAt(NOW + 35 * 3600000)), 'resets in 35h 0m')
    assert.equal(etaText(isoAt(NOW + 36 * 3600000)), 'resets in 2d')
  } finally {
    restore()
  }
})

test('fmtEta handles zero, negatives, NaN and the boundaries', async () => {
  const { fmtEta } = await loadPlugin()
  assert.equal(fmtEta(0), '')
  assert.equal(fmtEta(-5), '')
  assert.equal(fmtEta(NaN), '')
  assert.equal(fmtEta(89 * 60), '~89m')
  assert.equal(fmtEta(90 * 60), '~1h')
  assert.equal(fmtEta(35 * 3600), '~35h')
  assert.equal(fmtEta(36 * 3600), '~2d')
})

test('usedPercentOf clamps and treats missing fields as zero', async () => {
  const { usedPercentOf } = await loadPlugin()
  assert.equal(usedPercentOf({ used_pct: 150 }), 100)
  assert.equal(usedPercentOf({ used_pct: -5 }), 0)
  assert.equal(usedPercentOf({}), 0)
  assert.equal(usedPercentOf(null), 0)
  assert.equal(usedPercentOf({ used_pct: '42.5' }), 42.5)
})

test('usedPercentOf reads used_pct, not percent', async () => {
  const { usedPercentOf, rowView } = await loadPlugin()
  assert.equal(usedPercentOf({ percent: 90, used_pct: 10 }), 10)
  assert.equal(usedPercentOf({ percent: 90 }), 0)
  assert.equal(rowView({ label: 'x', percent: 90, used_pct: 10, kind: 'window' }, 'used').value, '10%')
})

test('rowView renders windows in both modes', async () => {
  const { rowView } = await loadPlugin()
  const row = { key: '5h', label: '5h', kind: 'window', percent: 42, used_pct: 42, actionable_eta: 7200 }
  assert.deepEqual(rowView(row, 'used'), {
    label: '5h',
    value: '42%',
    totalText: '',
    shown: 42,
    eta: 7200
  })
  const rest = rowView(row, 'remaining')
  assert.equal(rest.value, '58%')
  assert.equal(rest.shown, 58)
  assert.equal(rowView({ label: 'x', percent: 10, used_pct: 10 }, 'used').eta, null)
})

test('rowView renders money in both modes and keys the heading on the row key', async () => {
  const { rowView } = await loadPlugin()
  const balance = {
    key: 'money:balance:usd',
    label: 'Balance',
    kind: 'money',
    total: 20,
    left: 12.5,
    cur: 'USD',
    used_pct: 37.5
  }
  const used = rowView(balance, 'used')
  assert.equal(used.label, 'Spent')
  assert.equal(used.value, '$7.50')
  assert.equal(used.totalText, '$20.00')
  assert.equal(used.shown, 37.5)
  const rest = rowView(balance, 'remaining')
  assert.equal(rest.label, 'Balance')
  assert.equal(rest.value, '$12.50')
  assert.equal(rest.shown, 62.5)
  const cap = rowView(
    { key: 'money:key_cap:usd', label: 'Allowance', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 },
    'used'
  )
  assert.equal(cap.label, 'Cap used')
  const euro = rowView(
    { key: 'money:balance:eur', label: 'Balance', kind: 'money', total: 20, left: 12.5, cur: 'EUR', used_pct: 37.5 },
    'used'
  )
  assert.equal(euro.value, '€7.50')
  assert.equal(euro.totalText, '€20.00')
  const noTotal = rowView({ key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null }, 'used')
  assert.equal(noTotal.value, '$7.00')
  assert.equal(noTotal.totalText, '')
  assert.equal(noTotal.shown, 0)
  const noTotalRest = rowView(
    { key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null },
    'remaining'
  )
  assert.equal(noTotalRest.value, '$7.00')
  assert.equal(noTotalRest.shown, 0)
})

test('sameReset compares stamps inside the tolerance and skips junk keys', async () => {
  const { sameReset, RESET_TOLERANCE_MS } = await loadPlugin()
  const prefix = 'zai:5h:'
  const stamp = NOW
  const seen = { [prefix + isoAt(stamp)]: 1 }
  assert.equal(sameReset(seen, prefix, stamp), true)
  assert.equal(sameReset(seen, prefix, stamp + RESET_TOLERANCE_MS), true)
  assert.equal(sameReset(seen, prefix, stamp + RESET_TOLERANCE_MS + 1), false)
  assert.equal(sameReset(seen, 'other:', stamp), false)
  assert.equal(sameReset({ 'zai:5h:nope': 1 }, prefix, stamp), false)
  assert.equal(sameReset({ ['zai:7d:' + isoAt(stamp)]: 1 }, prefix, stamp), false)
})

test('barModel shows the highest used quota across windows and money', async () => {
  const { barModel } = await loadPlugin()
  const cap = {
    status: 'ok',
    money: [
      {
        key: 'money:key_cap:usd',
        label: 'Key cap',
        kind: 'money',
        total: 10,
        left: 4,
        cur: 'USD',
        used_pct: 60
      }
    ]
  }
  assert.equal(barValue(barModel, cap, 'used'), '$6.00')
  assert.equal(barValue(barModel, cap, 'remaining'), '$4.00')
  const noCap = {
    status: 'ok',
    money: [
      {
        key: 'money:balance:usd',
        label: 'Balance',
        kind: 'money',
        total: 10,
        left: 4,
        cur: 'USD',
        used_pct: 60
      }
    ]
  }
  assert.equal(barValue(barModel, noCap, 'used'), '$6.00')
  const noTotal = {
    status: 'ok',
    money: [
      { key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null }
    ]
  }
  assert.equal(barValue(barModel, noTotal, 'used'), '$7.00')
  assert.equal(barValue(barModel, noTotal, 'remaining'), '$7.00')
  const windows = {
    status: 'ok',
    windows: [
      { key: 'weekly', label: 'Weekly', percent: 10, used_pct: 10, scope: 'account', duration_seconds: 604800 },
      { key: '5h', label: '5h', percent: 20, used_pct: 20, scope: 'account', duration_seconds: 18000 }
    ]
  }
  assert.equal(barValue(barModel, windows, 'used'), '20%')
  assert.equal(barValue(barModel, windows, 'remaining'), '80%')
  const modelHigher = {
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', percent: 10, used_pct: 10, scope: 'account', duration_seconds: 18000 },
      { key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model', duration_seconds: 3600 }
    ]
  }
  assert.equal(barValue(barModel, modelHigher, 'used'), '90%')
  const noDurations = {
    status: 'ok',
    windows: [
      { key: 'first', label: 'First', percent: 30, used_pct: 30, scope: 'account' },
      { key: 'second', label: 'Second', percent: 60, used_pct: 60, scope: 'account' }
    ]
  }
  assert.equal(barValue(barModel, noDurations, 'used'), '60%')
  assert.equal(
    barValue(barModel, { status: 'ok', windows: [{ key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model' }] }, 'used'),
    '90%'
  )
  assert.equal(barValue(barModel, { status: 'ok' }, 'used'), '-')
  assert.equal(barValue(barModel, { status: 'error' }, 'used'), '-')
  const capSecond = {
    status: 'ok',
    money: [
      {
        key: 'money:balance:usd',
        label: 'Balance',
        kind: 'money',
        total: 100,
        left: 90,
        cur: 'USD',
        used_pct: 10
      },
      {
        key: 'money:key_cap:usd',
        label: 'Allowance',
        kind: 'money',
        total: 10,
        left: 4,
        cur: 'USD',
        used_pct: 60
      }
    ]
  }
  assert.equal(barValue(barModel, capSecond, 'used'), '$6.00')
  assert.equal(barValue(barModel, capSecond, 'remaining'), '$4.00')
  assert.equal(barValue(barModel, capSecond, 'used', { zai: 'money:balance:usd' }), '$6.00')
})

test('barModel follows a chosen bar quota', async () => {
  const { barModel } = await loadPlugin()
  const p = {
    id: 'zai',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', used_pct: 20, scope: 'account', duration_seconds: 18000 },
      { key: 'weekly', label: 'Weekly', used_pct: 40, scope: 'account', duration_seconds: 604800 }
    ]
  }
  assert.equal(barValue(barModel, p, 'used'), '40%')
  assert.equal(barValue(barModel, p, 'used', { zai: '5h' }), '20%')
  assert.equal(barValue(barModel, p, 'remaining', { zai: '5h' }), '80%')
  assert.equal(barValue(barModel, p, 'used', { zai: 'gone' }), '40%')
  assert.equal(barValue(barModel, p, 'used', { other: '5h' }), '40%')
})

test('checkAlerts fires a warned window once and stores it under the row key', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, data, notices } = fakeContext()
    plugin.register(ctx)
    const resetsAt = isoAt(NOW + 30 * 60000)
    const payload = {
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [
            { key: '5h', label: '5h', percent: 80.6, used_pct: 80.6, warn: true, resets_at: resetsAt },
            { key: 'quiet', label: 'Quiet', used_pct: 95, warn: false, resets_at: resetsAt }
          ]
        }
      ]
    }
    checkAlerts(payload)
    assert.deepEqual(notices, [{ title: 'Zai: 5h at 81% used', body: 'resets in 30m' }])
    assert.deepEqual(Object.keys(data.alerts), ['zai:5h:' + resetsAt])
    assert.equal(data.alerts['zai:5h:' + resetsAt], NOW)
    checkAlerts(payload)
    assert.equal(notices.length, 1)

    const moved = isoAt(NOW + 30 * 60000 + 60000)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: 'Session', used_pct: 80.6, warn: true, resets_at: moved }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('a window with no reset time is stored under no-reset', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, data, notices } = fakeContext()
    plugin.register(ctx)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 80, warn: true }]
        }
      ]
    })
    assert.deepEqual(notices, [{ title: 'Zai: 5h at 80% used', body: '' }])
    assert.deepEqual(Object.keys(data.alerts), ['zai:5h:no-reset'])
  } finally {
    restore()
  }
})

test('a warned key cap fires once per day under its row key', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, data, notices } = fakeContext()
    plugin.register(ctx)
    const payload = {
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          money: [
            {
              key: 'money:key_cap:usd',
              label: 'Key cap',
              total: 10,
              left: 2,
              cur: 'USD',
              used_pct: 80,
              warn: true,
              actionable_eta: 5400
            }
          ]
        }
      ]
    }
    checkAlerts(payload)
    assert.deepEqual(notices, [
      {
        title: 'Zai: Key cap at 80% used',
        body: 'At this rate, exhausted in ~1h \u00b7 $2.00 of $10.00 left'
      }
    ])
    assert.deepEqual(Object.keys(data.alerts), [
      'zai:money:key_cap:usd:' + Math.floor(NOW / 86400000)
    ])
    checkAlerts(payload)
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('a warned money row fires even when it is not the key cap, and an error provider never does', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, data, notices } = fakeContext()
    plugin.register(ctx)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          money: [
            {
              key: 'money:balance:usd',
              label: 'Balance',
              total: 100,
              left: 10,
              cur: 'USD',
              used_pct: 90,
              warn: true,
              actionable_eta: null
            }
          ]
        }
      ]
    })
    assert.deepEqual(notices, [{ title: 'Zai: Balance at 90% used', body: '$10.00 of $100.00 left' }])
    assert.deepEqual(Object.keys(data.alerts), [
      'zai:money:balance:usd:' + Math.floor(NOW / 86400000)
    ])
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'error',
          windows: [{ key: '5h', label: '5h', used_pct: 99, warn: true }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('an actionable eta adds the projection to the body', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [
            {
              key: '5h',
              label: '5h',
              used_pct: 80,
              warn: true,
              eta_seconds: 86400,
              actionable_eta: 999,
              resets_at: isoAt(NOW + 1000 * 1000)
            }
          ],
          money: [
            {
              key: 'money:key_cap:usd',
              label: 'Key cap',
              total: 10,
              left: 2,
              cur: 'USD',
              used_pct: 80,
              warn: true,
              actionable_eta: 5400
            }
          ]
        }
      ]
    })
    assert.equal(notices[0].body, 'At this rate, 100% in ~17m \u00b7 resets in 17m')
    assert.ok(notices[1].body.startsWith('At this rate, exhausted in ~1h \u00b7 '))
  } finally {
    restore()
  }
})

/* ---------- UI: bar, tip and panel ---------- */

function nodeText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (node.props && node.props.children !== undefined) return nodeText(node.props.children)
  return ''
}

function findNodes(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    node.forEach(child => findNodes(child, pred, out))
    return out
  }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  if (node.props && node.props.children !== undefined) findNodes(node.props.children, pred, out)
  return out
}

const okProvider = (id, name, code, used, warn, extra = {}) => ({
  id: id,
  name: name,
  tag: 'Pro',
  code: code,
  status: 'ok',
  windows: [
    {
      key: '5h',
      label: '5h',
      kind: 'window',
      scope: 'account',
      duration_seconds: 18000,
      used_pct: used,
      warn: warn,
      actionable_eta: null,
      resets_at: null
    }
  ],
  ...extra
})

test('barModel follows the session provider when nothing is pinned', async () => {
  const { barModel, barContent } = await loadPlugin()
  const provs = [
    okProvider('zai', 'Zai', 'zai', 20, false),
    okProvider('anthropic', 'Anthropic', 'claude', 95, true)
  ]
  const followed = barModel(provs, null, 'claude', 'used', null)
  assert.equal(followed.following, true)
  assert.deepEqual(followed.entries.map(e => e.id), ['anthropic'])
  assert.equal(barContent(followed).props.children.length, 1)
  assert.equal(nodeText(barContent(followed)), 'claude 95%')
  const amber = findNodes(barContent(followed), n => n.props && n.props.style && n.props.style.color === WARN_COLOR)
  assert.equal(amber.length, 1)
  assert.equal(nodeText(amber[0]), 'claude 95%')
})

test('barModel uses the provider code and falls back to its id', async () => {
  const { barModel } = await loadPlugin()
  const provs = [
    okProvider('zai', 'Zai', 'zai-code', 20, false),
    okProvider('no-code', 'No code', undefined, 30, false)
  ]
  const model = barModel(provs, ['zai', 'no-code'], null, 'used', null)
  assert.deepEqual(model.entries.map(e => e.code), ['zai-code', 'no-code'])
})

test('barContent renders Usage when the session provider is unknown or unread', async () => {
  const { barModel, barContent } = await loadPlugin()
  const provs = [okProvider('zai', 'Zai', 'zai', 20, false)]
  assert.equal(barContent(barModel(provs, null, 'gemini', 'used', null)), 'Usage')
  assert.equal(barContent(barModel(provs, null, null, 'used', null)), 'Usage')
  assert.equal(barContent(barModel(provs, null, 'zai', 'used', null)).type, 'span')
})

test('barContent renders two pins in full text with the attention entry amber', async () => {
  const { barModel, barContent } = await loadPlugin()
  const provs = [
    okProvider('zai', 'Zai', 'zai', 20, false),
    okProvider('anthropic', 'Anthropic', 'claude', 95, true)
  ]
  const model = barModel(provs, ['zai', 'anthropic'], null, 'used', null)
  assert.equal(model.following, false)
  assert.equal(model.layout.mode, 'full')
  assert.equal(nodeText(barContent(model)), 'claude 95% · zai 20%')
  const amber = findNodes(barContent(model), n => n.props && n.props.style && n.props.style.color === WARN_COLOR)
  assert.equal(amber.length, 1)
  assert.equal(nodeText(amber[0]), 'claude 95%')
})

test('barContent renders meters and the pin count for seven pins', async () => {
  const { barModel, barContent } = await loadPlugin()
  const provs = []
  for (let i = 0; i < 7; i++) {
    provs.push(okProvider('p' + i, 'P' + i, 'p' + i, i * 10, i === 6))
  }
  const model = barModel(provs, provs.map(p => p.id), null, 'used', null)
  assert.equal(model.layout.mode, 'meters')
  const content = barContent(model)
  assert.equal(nodeText(content), 'p6 60%7 pinned')
  assert.equal(findNodes(content, n => n.props && n.props.style && n.props.style.background === WARN_COLOR).length, 1)
  assert.equal(findNodes(content, n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR).length, 6)
  assert.equal(model.layout.pinned, '7 pinned')
})

test('barContent steps down when the bar is narrow', async () => {
  const { barModel } = await loadPlugin()
  const provs = [
    okProvider('zai', 'Zai', 'zai', 20, false),
    okProvider('anthropic', 'Anthropic', 'claude', 95, true)
  ]
  const wide = barModel(provs, ['zai', 'anthropic'], null, 'used', null)
  assert.equal(wide.layout.mode, 'full')
  const narrow = barModel(provs, ['zai', 'anthropic'], null, 'used', 40)
  assert.equal(narrow.layout.mode, 'meters')
})

test('a meter with zero usage still draws a 2px bar', async () => {
  const { barLayout, barContent } = await loadPlugin()
  const entries = []
  for (let i = 0; i < 7; i++) {
    entries.push({ id: 'p' + i, code: 'p' + i, value: '0%', used_pct: 0, attention: false })
  }
  const model = { entries: entries, layout: barLayout(entries, false, null) }
  assert.equal(model.layout.mode, 'meters')
  const bars = findNodes(
    barContent(model),
    n => n.props && n.props.style && n.props.style.height === 2
  )
  assert.equal(bars.length, 7)
})

test('barContent drops the percent in bare mode and keeps money as is', async () => {
  const { barLayout, barContent } = await loadPlugin()
  const entries = [
    { id: 'a', code: 'codex', value: '78%', used_pct: 78, attention: false },
    { id: 'b', code: 'zai', value: '12%', used_pct: 12, attention: false },
    { id: 'c', code: 'claude', value: '40%', used_pct: 40, attention: false },
    { id: 'd', code: 'kimi', value: '5%', used_pct: 5, attention: false },
    { id: 'e', code: 'openrouter', value: '$3.00', used_pct: 30, attention: false }
  ]
  const model = { entries: entries, layout: barLayout(entries, false, null) }
  assert.equal(model.layout.mode, 'bare')
  assert.equal(nodeText(barContent(model)), 'codex 78 · zai 12 · claude 40 · kimi 5 · openrouter $3.00')
  assert.equal(model.layout.text, nodeText(barContent(model)))
})

test('a pinned provider in error stays in the bar as a dash', async () => {
  const { barModel, barContent } = await loadPlugin()
  const provs = [
    okProvider('zai', 'Zai', 'zai', 20, false),
    { id: 'openrouter', name: 'OpenRouter', tag: 'Credits', code: 'openrouter', status: 'error', error: 'boom' }
  ]
  const pinned = barModel(provs, ['openrouter'], null, 'used', null)
  assert.deepEqual(pinned.entries.map(e => e.id), ['openrouter'])
  assert.equal(pinned.entries[0].value, '-')
  assert.equal(pinned.entries[0].attention, false)
  assert.equal(nodeText(barContent(pinned)), 'openrouter -')
  const followed = barModel(provs, null, 'openrouter', 'used', null)
  assert.deepEqual(followed.entries.map(e => e.id), ['openrouter'])
  assert.equal(nodeText(barContent(followed)), 'openrouter -')
})

test('watchSessionProvider ignores a stale reply from the previous session', async () => {
  const { watchSessionProvider } = await loadPlugin()
  const atomLike = initial => {
    let value = initial
    const listeners = []
    return {
      get: () => value,
      listen: fn => {
        listeners.push(fn)
        return () => {}
      },
      set: next => {
        value = next
        listeners.forEach(fn => fn())
      }
    }
  }
  const pending = {}
  const hostStub = {
    request: (method, params) =>
      new Promise(resolve => {
        pending[params.session_id] = resolve
      })
  }
  const focus = atomLike('A')
  const model = atomLike('m')
  const seen = []
  watchSessionProvider(hostStub, focus, model, v => seen.push(v))
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  focus.set('B')
  pending.B({ provider: 'minimax' })
  await tick()
  assert.deepEqual(seen, ['minimax'])
  pending.A({ provider: 'anthropic' })
  await tick()
  assert.deepEqual(seen, ['minimax'])
})

test('watchSessionProvider drops a reply that lands after cleanup', async () => {
  const { watchSessionProvider } = await loadPlugin()
  const atomLike = initial => {
    let value = initial
    return {
      get: () => value,
      listen: () => () => {},
      set: next => {
        value = next
      }
    }
  }
  let release
  const hostStub = {
    request: () =>
      new Promise(resolve => {
        release = resolve
      })
  }
  const seen = []
  const off = watchSessionProvider(hostStub, atomLike('A'), atomLike('m'), v => seen.push(v))
  off()
  release({ provider: 'claude' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(seen, [])
})

test('watchSessionProvider reads again on focus and model changes only', async () => {
  const { watchSessionProvider } = await loadPlugin()
  const atomLike = initial => {
    let value = initial
    const listeners = []
    return {
      get: () => value,
      listen: fn => {
        listeners.push(fn)
        return () => {
          const at = listeners.indexOf(fn)
          if (at !== -1) listeners.splice(at, 1)
        }
      },
      set: next => {
        value = next
        listeners.forEach(fn => fn())
      }
    }
  }
  const calls = []
  const hostStub = {
    request: (method, params) => {
      calls.push(params.session_id)
      return Promise.resolve({ provider: 'claude' })
    }
  }
  const focus = atomLike('s1')
  const model = atomLike('m1')
  const seen = []
  const off = watchSessionProvider(hostStub, focus, model, v => seen.push(v))
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  await tick()
  assert.deepEqual(calls, ['s1'])
  assert.deepEqual(seen, ['claude'])
  focus.set('s2')
  await tick()
  assert.deepEqual(calls, ['s1', 's2'])
  model.set('m2')
  await tick()
  assert.deepEqual(calls, ['s1', 's2', 's2'])
  off()
  focus.set('s3')
  await tick()
  assert.equal(calls.length, 3)
})

test('tipBody lists one line per entry and the footer', async () => {
  const { tipBody } = await loadPlugin()
  const lines = [
    { name: 'Zai', label: '5h', value: '20%', attention: false },
    { name: 'Claude', label: 'Weekly', value: '95%', attention: true }
  ]
  const node = tipBody(lines, '09:41')
  assert.ok(nodeText(node).includes('Zai'))
  assert.ok(nodeText(node).includes('Weekly'))
  assert.ok(nodeText(node).includes('Click to open · updated 09:41'))
  const amber = findNodes(node, n => n.props && n.props.style && n.props.style.color === WARN_COLOR)
  assert.equal(amber.length, 1)
  assert.equal(nodeText(amber[0]), '95%')
})

test('tipBody explains the empty bar', async () => {
  const { tipBody } = await loadPlugin()
  const node = tipBody([], '09:41')
  assert.ok(nodeText(node).includes('Pin a provider, or open a chat that uses one'))
  assert.ok(nodeText(node).includes('Click to open · updated 09:41'))
})

test('tipBody inherits the tooltip colours instead of panel tokens', async () => {
  const { tipBody } = await loadPlugin()
  const lines = [
    { name: 'Zai', label: '5h', value: '20%', attention: false },
    { name: 'Claude', label: 'Weekly', value: '95%', attention: true }
  ]
  const withLines = tipBody(lines, '09:41')
  const empty = tipBody([], '09:41')
  for (const node of [withLines, empty]) {
    const styles = findNodes(node, n => n.props && n.props.style).map(n => JSON.stringify(n.props.style))
    assert.ok(!styles.join(' ').includes('--ui-text-'))
    assert.ok(!styles.join(' ').includes('--ui-stroke-'))
  }
  const label = findNodes(withLines, n => n.type === 'span' && nodeText(n) === '5h')
  assert.equal(label.length, 1)
  assert.equal(label[0].props.style.opacity, 0.6)
  const foot = findNodes(withLines, n => n.type === 'div' && nodeText(n) === 'Click to open · updated 09:41')
  assert.equal(foot.length, 1)
  assert.equal(foot[0].props.style.opacity, 0.6)
  assert.equal(foot[0].props.style.borderTop, '1px solid color-mix(in srgb, currentColor 25%, transparent)')
})

test('pinAllSet pins every provider, then unpins all', async () => {
  const { pinAllSet } = await loadPlugin()
  const ids = ['zai', 'anthropic']
  assert.deepEqual(pinAllSet(null, ids), ['zai', 'anthropic'])
  assert.deepEqual(pinAllSet(['zai'], ids), ['zai', 'anthropic'])
  assert.deepEqual(pinAllSet(['zai', 'anthropic'], ids), [])
  assert.deepEqual(pinAllSet([], ids), ['zai', 'anthropic'])
})

test('providerRowElement keys the pin toggle and the bar quota dot', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = okProvider('zai', 'Zai', 'zai', 20, false)
  const off = providerRowElement(p, { mode: 'used', pins: [], barIds: ['zai'], expanded: false })
  const pin = findNodes(off, n => n.type === 'button' && n.props['aria-label'])
  assert.equal(pin.length, 1)
  assert.equal(pin[0].props['aria-pressed'], false)
  assert.equal(pin[0].props['aria-label'], 'Pin Zai to status bar')
  assert.equal(pin[0].props.title, 'Pin Zai to status bar')
  const on = providerRowElement(p, { mode: 'used', pins: ['zai'], barIds: ['zai'], expanded: false })
  const pinned = findNodes(on, n => n.type === 'button' && n.props['aria-label'])
  assert.equal(pinned[0].props['aria-pressed'], true)
  assert.equal(pinned[0].props['aria-label'], 'Unpin Zai from status bar')
  assert.equal(findNodes(off, n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR && n.props.style.borderRadius === '50%').length, 1)
  const noDot = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  assert.equal(findNodes(noDot, n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR && n.props.style.borderRadius === '50%').length, 0)
})

test('providerRowElement shows +N more and the open row renders its panel', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [
      { key: 'a', label: 'A', kind: 'window', used_pct: 90, warn: false, duration_seconds: 18000 },
      { key: 'b', label: 'B', kind: 'window', used_pct: 80, warn: false, duration_seconds: 604800 },
      { key: 'c', label: 'C', kind: 'window', used_pct: 70, warn: false, duration_seconds: 2592000 },
      { key: 'd', label: 'D', kind: 'window', used_pct: 60, warn: false }
    ]
  }
  const collapsed = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: false })
  const more = findNodes(collapsed, n => n.type === 'button' && nodeText(n) === '+1 more')
  assert.equal(more.length, 1)
  assert.equal(findNodes(collapsed, n => n.type === 'div' && n.props && n.props.role === 'tablist').length, 0)
  const open = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: true })
  assert.equal(findNodes(open, n => n.type === 'div' && n.props && n.props.role === 'tablist').length, 1)
  assert.equal(findNodes(open, n => typeof n.type === 'function' && ['Tabs', 'SegmentedControl'].includes(n.type.name)).length, 0)
  assert.equal(findNodes(open, n => n.type === 'button' && nodeText(n) === 'Show less').length, 0)
  assert.equal(nodeText(open).includes('D'), true)
})

test('providerRowElement distinguishes retry from a last reading', async () => {
  const { providerRowElement } = await loadPlugin()
  const future = new Date(Date.now() + 3600000).toISOString()
  const retry = providerRowElement(
    okProvider('zai', 'Zai', 'zai', 20, false, { stale: true, hold_until: future }),
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  assert.ok(nodeText(retry).includes('retry '))
  const last = providerRowElement(
    okProvider('zai', 'Zai', 'zai', 20, false, { stale: true, fetched_at: new Date().toISOString() }),
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  assert.ok(nodeText(last).includes('last reading '))
  assert.equal(findNodes(retry, n => n.props && n.props.style && n.props.style.opacity === 0.6).length, 1)
  assert.ok(nodeText(retry).includes('retry '))
})

test('a stale provider with a past hold_until shows its last reading', async () => {
  const { staleText } = await loadPlugin()
  const p = {
    stale: true,
    hold_until: new Date(Date.now() - 3600000).toISOString(),
    fetched_at: new Date().toISOString()
  }
  const text = staleText(p)
  assert.ok(text.startsWith('last reading '))
  assert.equal(text.includes('retry'), false)
})

test('an error provider keeps its header and puts the text beneath it', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = { id: 'zai', name: 'Zai', tag: 'Pro', status: 'error', error: 'token rejected by the provider' }
  const node = providerRowElement(p, {
    mode: 'used',
    pins: [],
    barIds: [],
    expanded: false,
    onPin: () => {},
    onMore: () => {}
  })
  assert.ok(nodeText(node).includes('Zai'))
  assert.ok(nodeText(node).includes('Pro'))
  assert.ok(nodeText(node).includes('token rejected by the provider'))
  const tips = findNodes(node, n => typeof n.type === 'function' && n.type.name === 'Tip')
  assert.equal(tips.length, 1)
  assert.equal(tips[0].props.label, 'token rejected by the provider')
  const pin = findNodes(node, n => n.type === 'button' && n.props['aria-label'])
  assert.equal(pin.length, 1)
  assert.equal(pin[0].props['aria-label'], 'Pin Zai to status bar')
  const links = findNodes(node, n => n.type === 'a')
  assert.equal(links.length, 0)
  assert.equal(nodeText(node).includes('re-auth'), false)
})

test('quota cells put label and value on one line above the bar', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false },
      { key: 'weekly', label: 'Weekly', kind: 'window', used_pct: 40, warn: true, duration_seconds: 604800 }
    ]
  }
  const row = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  const grid = row.props.children[1]
  assert.equal(grid.props.children.length, 2)
  const cell = grid.props.children[0]
  const line = cell.props.children[0]
  assert.equal(line.props.style.display, 'flex')
  assert.equal(line.props.style.alignItems, 'baseline')
  assert.equal(nodeText(line), '5h20%')
  const value = line.props.children[2]
  assert.equal(value.props.style.marginLeft, 'auto')
  assert.equal(value.props.style.flex, 'none')
  assert.equal(nodeText(value), '20%')
  const bar = cell.props.children[1]
  assert.equal(bar.props.style.height, 4)
})

test('a single quota shows the reset text and several quotas do not', async () => {
  const { providerRowElement } = await loadPlugin()
  const resets = new Date(Date.now() + 1800000).toISOString()
  const single = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false, resets_at: resets }]
  }
  const oneRow = providerRowElement(single, { mode: 'used', pins: [], barIds: [], expanded: false })
  assert.ok(nodeText(oneRow).includes('resets in '))
  const multi = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false, resets_at: resets },
      { key: 'weekly', label: 'Weekly', kind: 'window', used_pct: 40, warn: false, resets_at: resets, duration_seconds: 604800 }
    ]
  }
  const twoRow = providerRowElement(multi, { mode: 'used', pins: [], barIds: [], expanded: false })
  assert.equal(nodeText(twoRow).includes('resets in '), false)
})

test('a warned quota value is amber and a quiet one is not', async () => {
  const { providerRowElement } = await loadPlugin()
  const loud = providerRowElement(
    {
      id: 'zai',
      name: 'Zai',
      tag: 'Pro',
      status: 'ok',
      windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: true }]
    },
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  const loudValue = findNodes(loud, n => n.props && nodeText(n) === '20%' && n.props.style && n.props.style.fontSize === 11)
  assert.equal(loudValue.length, 1)
  assert.equal(loudValue[0].props.style.color, WARN_COLOR)
  const quiet = providerRowElement(
    {
      id: 'zai',
      name: 'Zai',
      tag: 'Pro',
      status: 'ok',
      windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false }]
    },
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  const quietValue = findNodes(quiet, n => n.props && nodeText(n) === '20%' && n.props.style && n.props.style.fontSize === 11)
  assert.equal(quietValue.length, 1)
  assert.equal(quietValue[0].props.style.color, undefined)
})

test('an actionable eta alone colours the quota value and bar amber', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false, actionable_eta: 0 }]
  }
  const node = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  const values = findNodes(node, n => n.props && nodeText(n) === '20%' && n.props.style && n.props.style.fontSize === 11)
  assert.equal(values.length, 1)
  assert.equal(values[0].props.style.color, WARN_COLOR)
  const bars = findNodes(
    node,
    n => n.type === 'span' && n.props && n.props.style && n.props.style.background === WARN_COLOR
  )
  assert.equal(bars.length, 1)
})

test('a money row with no used_pct draws no track and no fill', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'openrouter',
    name: 'OpenRouter',
    tag: 'Credits',
    status: 'ok',
    money: [
      { key: 'money:balance:usd', label: 'Balance', kind: 'money', total: 10, left: 7, cur: 'USD', used_pct: null }
    ]
  }
  const row = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  const grid = row.props.children[1]
  const cell = grid.props.children[0]
  const bar = cell.props.children[1]
  assert.equal(bar.props.style.background, 'transparent')
  assert.equal(bar.props.children, null)
})

test('money keeps its total beside the value at any column count', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'openrouter',
    name: 'OpenRouter',
    tag: 'Credits',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false }],
    money: [
      { key: 'money:key_cap:usd', label: 'Key cap', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80, warn: true }
    ]
  }
  const row = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  assert.ok(nodeText(row).includes('/ $10.00'))
})

test('provider rows carry the list padding and a bottom divider', async () => {
  const { providerRowElement } = await loadPlugin()
  const ok = providerRowElement(okProvider('zai', 'Zai', 'zai', 20, false), {
    mode: 'used',
    pins: [],
    barIds: [],
    expanded: false
  })
  assert.equal(ok.props.style.padding, '7px 14px 9px')
  assert.ok(String(ok.props.style.borderBottom).includes('var(--ui-stroke-tertiary)'))
  const err = providerRowElement(
    { id: 'zai', name: 'Zai', tag: 'Pro', status: 'error', error: 'boom' },
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  assert.equal(err.props.style.padding, '7px 14px 9px')
  assert.ok(String(err.props.style.borderBottom).includes('var(--ui-stroke-tertiary)'))
})

test('group headings carry their own padding', async () => {
  const { groupHeadingElement } = await loadPlugin()
  const attention = groupHeadingElement('Needs attention')
  assert.equal(attention.props.style.padding, '8px 14px 2px')
  assert.equal(attention.props.style.color, WARN_COLOR)
  const plain = groupHeadingElement('Providers')
  assert.equal(plain.props.style.padding, '8px 14px 2px')
  assert.equal(plain.props.style.color, 'var(--ui-text-tertiary)')
})

test('desktop/plugin.js has no hex or rgb colours', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false)
  assert.equal(/rgba?\(/.test(source), false)
})

test('desktop/plugin.js contains no className', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.equal(source.includes('className'), false)
})

test('desktop/plugin.js no longer ships an eye icon', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.equal(/EyeIcon|EYE_PATH/.test(source), false)
})

/* ---------- detail chart and expanded row ---------- */

test('windowNotStarted marks only an idle window', async () => {
  const { windowNotStarted } = await loadPlugin()
  const reset = '2026-11-12T18:00:00Z'
  const base = { kind: 'window', used_pct: 0, duration_seconds: 18000 }
  const cases = [
    ['no reset, zero used', base, true],
    ['reset present', { ...base, resets_at: reset }, false],
    ['used above zero', { ...base, used_pct: 3 }, false],
    ['no duration', { ...base, duration_seconds: undefined }, false],
    ['indicative', { ...base, indicative: true }, false],
    ['unparsable reset', { ...base, resets_at: 'not a time' }, true]
  ]
  for (const [label, row, expected] of cases) {
    assert.equal(windowNotStarted(row), expected, label)
  }
})

test('chartModel maps history and projects under the reset', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 50,
    eta_seconds: 7200,
    resets_at: new Date(now + 3600 * 1000).toISOString(),
    history: [
      [now / 1000 - 3600, 30],
      [now / 1000, 50]
    ]
  }
  const m = chartModel(row, now)
  assert.equal(m.series.length, 2)
  assert.ok(Math.abs(m.series[0][0] - (220 - 220 / 6)) < 0.01)
  assert.ok(Math.abs(m.series[0][1] - 46.8) < 0.01)
  assert.ok(Math.abs(m.series[1][0] - 220) < 0.01)
  assert.ok(Math.abs(m.series[1][1] - 34) < 0.01)
  assert.equal(m.projection.x1, 336)
  assert.ok(Math.abs(m.projection.y1 - 18) < 0.01)
  assert.equal(m.valueAtReset, 75)
  assert.equal(m.overflow, false)
  assert.equal(m.colour, 'accent')
  const warned = chartModel({ ...row, warn: true }, now)
  assert.equal(warned.colour, 'amber')
  const remaining = chartModel(row, now, 80, 'remaining')
  assert.equal(remaining.series[0][1], 21.2)
  assert.equal(remaining.series[1][1], 34)
  assert.equal(remaining.current[1], 34)
})

test('chartModel puts 5h, weekly and monthly windows on one whole-window axis', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const five = chartModel(
    {
      kind: 'window',
      used_pct: 20,
      duration_seconds: 5 * 3600,
      resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
    },
    now
  )
  const weekly = chartModel(
    {
      kind: 'window',
      used_pct: 20,
      duration_seconds: 7 * 86400,
      resets_at: new Date(now + (7 * 86400 - 6 * 3600) * 1000).toISOString()
    },
    now
  )
  const monthly = chartModel(
    {
      kind: 'window',
      used_pct: 80,
      duration_seconds: 30 * 86400,
      resets_at: new Date(now + 22.5 * 3600 * 1000).toISOString()
    },
    now
  )
  assert.ok(Math.abs(five.nowX - 53.76) < 0.01)
  assert.ok(Math.abs(weekly.nowX - 12) < 0.01)
  assert.ok(Math.abs(monthly.nowX - 325.5) < 0.01)
  assert.equal(five.current[0], five.nowX)
  assert.equal(five.series[0][0], 0)
  assert.ok(Math.abs(five.series[1][0] - five.nowX) < 0.01)
  assert.equal(five.average, true)
  assert.equal(five.nowLabel.y, 9)
  assert.equal(weekly.nowLabel.y, 21)
  assert.equal(monthly.nowLabel.y, 68)
  assert.equal(monthly.nowLabel.anchor, 'end')
  for (const model of [five, weekly, monthly]) {
    const distance = Math.hypot(model.nowLabel.x - model.current[0], model.nowLabel.y - model.current[1])
    assert.ok(distance >= 6)
    if (model.alert) {
      const alertY = Math.max(9, model.alert.y - 3.8)
      const alertWidth = model.alert.label.length * 4.7
      const left = model.nowLabel.anchor === 'start' ? model.nowLabel.x : model.nowLabel.x - 15
      const right = model.nowLabel.anchor === 'start' ? model.nowLabel.x + 15 : model.nowLabel.x
      if (left < alertWidth && right > 0) assert.ok(Math.abs(model.nowLabel.y - alertY) >= 10)
    }
  }
})

test('chartModel keeps only history inside the window on the window axis', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 20,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
  }
  const start = Date.parse(row.resets_at) - row.duration_seconds * 1000
  const m = chartModel(
    {
      ...row,
      history: [
        [start / 1000 - 60, 1],
        [start / 1000 + 60, 2],
        [now / 1000, 20]
      ]
    },
    now
  )
  assert.equal(m.series.length, 2)
  assert.ok(Math.abs(m.series[0][0] - 1.12) < 0.01)
  assert.ok(Math.abs(m.series[1][0] - 53.76) < 0.01)
})

test('chartModel projects overflow from the window now position', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 90,
    eta_seconds: 1000,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
  }
  const start = Date.parse(row.resets_at) - row.duration_seconds * 1000
  const m = chartModel(
    {
      ...row,
      history: [
        [start / 1000 + 60, 80],
        [now / 1000, 90]
      ]
    },
    now
  )
  const expected = 53.76 + (1000 / (4 * 3600 + 12 * 60)) * (336 - 53.76)
  assert.equal(m.overflow, true)
  assert.equal(m.projection.x0, m.nowX)
  assert.ok(Math.abs(m.projection.x1 - expected) < 0.01)
  assert.equal(m.projection.y1, 2)
})

test('chartModel keeps the old axis for money and windows without a duration', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const money = chartModel(
    {
      kind: 'money',
      used_pct: 40,
      total: 100,
      left: 60,
      cur: 'USD',
      history: [
        [now / 1000 - 3600, 20],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(money.nowX, 220)
  assert.deepEqual(money.nowLabel, { x: 223, y: 68, anchor: 'start' })
  assert.ok(Math.abs(money.series[0][0] - (220 - 220 / 6)) < 0.01)
  const noDuration = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      resets_at: new Date(now + 4 * 3600 * 1000).toISOString()
    },
    now
  )
  assert.equal(noDuration.nowX, 220)
  assert.deepEqual(noDuration.nowLabel, { x: 223, y: 68, anchor: 'start' })
  assert.equal(noDuration.series[0][0], 220)
})

test('chartModel plots remaining values for money and ends overflow at zero left', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const money = chartModel(
    {
      kind: 'money',
      used_pct: 40,
      total: 100,
      left: 60,
      cur: 'USD',
      depletes_in_seconds: 86400,
      history: [
        [now / 1000 - 3600, 20],
        [now / 1000, 40]
      ]
    },
    now,
    80,
    'remaining'
  )
  assert.equal(money.series[0][1], 14.8)
  assert.equal(money.series[1][1], 27.6)
  assert.equal(money.current[1], 27.6)
  assert.equal(money.projection.y0, 27.6)
  assert.equal(money.projection.y1, 66)
  const row = {
    kind: 'window',
    used_pct: 90,
    eta_seconds: 1000,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
  }
  const start = Date.parse(row.resets_at) - row.duration_seconds * 1000
  const history = [
    [start / 1000 + 60, 80],
    [now / 1000, 90]
  ]
  const used = chartModel({ ...row, history: history }, now, 80, 'used')
  const remaining = chartModel({ ...row, history: history }, now, 80, 'remaining')
  assert.equal(remaining.overflow, true)
  assert.equal(remaining.projection.x1, used.projection.x1)
  assert.equal(remaining.projection.y1, 66)
})

test('chartModel plots the average, alert and now label in remaining terms', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 20,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
  }
  const used = chartModel(row, now, 80, 'used')
  const remaining = chartModel(row, now, 80, 'remaining')
  assert.deepEqual(used, chartModel(row, now, 80))
  assert.equal(remaining.series[0][1], 2)
  assert.equal(remaining.series[1][1], 14.8)
  assert.equal(remaining.alert.y, 53.2)
  assert.equal(remaining.alert.label, 'alert 80% used')
  assert.equal(used.alert.y, 14.8)
  assert.equal(used.alert.label, 'alert 80%')
  const distance = Math.hypot(
    remaining.nowLabel.x - remaining.current[0],
    remaining.nowLabel.y - remaining.current[1]
  )
  assert.ok(distance >= 6)
  const alertY = Math.max(9, remaining.alert.y - 3.8)
  const alertWidth = remaining.alert.label.length * 4.7
  const left = remaining.nowLabel.anchor === 'start' ? remaining.nowLabel.x : remaining.nowLabel.x - 15
  const right = remaining.nowLabel.anchor === 'start' ? remaining.nowLabel.x + 15 : remaining.nowLabel.x
  if (left < alertWidth && right > 0) assert.ok(Math.abs(remaining.nowLabel.y - alertY) >= 10)
})

test('chartModel leads into a monthly or weekly window from its first sample', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const cases = [
    {
      label: 'monthly',
      duration: 30 * 86400,
      used: 50,
      reset: now + 86400 * 1000,
      first: 29 * 86400 - 6 * 3600,
      x: 322
    },
    {
      label: 'weekly',
      duration: 7 * 86400,
      used: 40,
      reset: now + 3 * 86400 * 1000,
      first: 3 * 86400,
      x: 144
    }
  ]
  for (const c of cases) {
    const start = c.reset - c.duration * 1000
    const m = chartModel(
      {
        kind: 'window',
        used_pct: c.used,
        duration_seconds: c.duration,
        resets_at: new Date(c.reset).toISOString(),
        history: [[start / 1000 + c.first, c.used - 10], [now / 1000, c.used]]
      },
      now
    )
    assert.equal(m.leadIn.length, 2, c.label)
    assert.equal(m.leadIn[0][0], 0, c.label)
    assert.equal(m.leadIn[0][1], 66, c.label)
    assert.ok(Math.abs(m.leadIn[1][0] - c.x) < 0.01, c.label)
    assert.equal(m.leadIn[1][1], m.series[0][1], c.label)
  }
})

test('chartModel has no lead-in for sparse history, money or the fallback', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const startStart = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      duration_seconds: 7 * 86400,
      resets_at: new Date(now + 3 * 86400 * 1000).toISOString(),
      history: [
        [Date.parse(new Date(now + 3 * 86400 * 1000).toISOString()) / 1000 - 7 * 86400 + 300, 20],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(startStart.leadIn, null)
  const avg = chartModel(
    {
      kind: 'window',
      used_pct: 20,
      eta_seconds: 7200,
      duration_seconds: 5 * 3600,
      resets_at: new Date(now + (4 * 3600 + 12 * 60) * 1000).toISOString()
    },
    now
  )
  assert.equal(avg.average, true)
  assert.equal(avg.leadIn, null)
  const money = chartModel(
    {
      kind: 'money',
      used_pct: 40,
      total: 100,
      left: 60,
      cur: 'USD',
      history: [
        [now / 1000 - 3600, 20],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(money.leadIn, null)
  const fallback = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      resets_at: new Date(now + 4 * 3600 * 1000).toISOString(),
      history: [
        [now / 1000 - 3600, 20],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(fallback.leadIn, null)
})

test('chartModel starts the remaining lead-in at the top', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const duration = 30 * 86400
  const row = {
    kind: 'window',
    used_pct: 50,
    duration_seconds: duration,
    resets_at: new Date(now + 86400 * 1000).toISOString()
  }
  const start = Date.parse(row.resets_at) - duration * 1000
  const history = [
    [start / 1000 + 29 * 86400 - 6 * 3600, 40],
    [now / 1000, 50]
  ]
  const used = chartModel({ ...row, history: history }, now, 80, 'used')
  const remaining = chartModel({ ...row, history: history }, now, 80, 'remaining')
  assert.equal(used.leadIn[0][1], 66)
  assert.equal(remaining.leadIn[0][1], 2)
  assert.equal(remaining.leadIn[1][1], remaining.series[0][1])
})

test('chartModel and chartElement mark inferred lead-in and gap bridges', async () => {
  const { chartModel, expandedPanel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const duration = 7 * 86400
  const row = {
    key: 'weekly',
    label: 'Weekly',
    kind: 'window',
    used_pct: 40,
    duration_seconds: duration,
    resets_at: new Date(now + 3 * 86400 * 1000).toISOString()
  }
  const start = Date.parse(row.resets_at) - duration * 1000
  const history = [
    [start / 1000 + 86400, 20],
    [start / 1000 + 86400 + 600, 22],
    [now / 1000, 40]
  ]
  const model = chartModel({ ...row, history: history }, now)
  assert.equal(model.series.length, 3)
  assert.equal(model.segments.length, 2)
  assert.equal(model.segments[0].length, 2)
  assert.equal(model.segments[1].length, 1)
  assert.equal(model.bridges.length, 1)
  assert.equal(model.leadInInferred, true)
  assert.equal(model.leadIn[0][0], 0)
  const element = expandedPanel(
    { id: 'x', name: 'X', status: 'ok', windows: [{ ...row, history: history }] },
    { mode: 'used', alertAt: {}, barIds: [], choice: {}, tab: undefined }
  )
  const lead = findNodes(element, n => n.type === 'polyline' && n.props.key === 'leadIn')
  assert.equal(lead[0].props.strokeDasharray, '3 3')
  const bridge = findNodes(element, n => n.type === 'polyline' && n.props.key === 'bridge-1')
  assert.equal(bridge[0].props.strokeDasharray, '3 3')
  const measured = findNodes(element, n => n.type === 'polyline' && n.props.key === 'history')
  assert.equal(measured[0].props.strokeDasharray, undefined)
})

test('chartModel stops the projection where it reaches 100', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 90,
    eta_seconds: 1000,
    resets_at: new Date(now + 3600 * 1000).toISOString()
  }
  const m = chartModel(row, now)
  assert.equal(m.overflow, true)
  assert.equal(m.valueAtReset, 126)
  assert.ok(Math.abs(m.projection.x1 - (220 + (1000 / 3600) * 116)) < 0.01)
  assert.equal(m.projection.y1, 2)
})

test('chartModel leaves a window without a reset unprojected', async () => {
  const { chartModel } = await loadPlugin()
  const m = chartModel({ key: 'w', label: 'W', kind: 'window', used_pct: 40 }, Date.now())
  assert.equal(m.projection, null)
  assert.equal(m.series.length, 1)
  assert.equal(m.series[0][0], 220)
})

test('chartModel charts money through its total and refuses a null used_pct', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const money = {
    key: 'money:key_cap:usd',
    label: 'Key cap',
    kind: 'money',
    total: 100,
    left: 60,
    cur: 'USD',
    used_pct: 40,
    depletes_in_seconds: 86400,
    history: [
      [now / 1000 - 3600, 20],
      [now / 1000, 40]
    ]
  }
  const m = chartModel(money, now)
  assert.ok(Math.abs(m.series[0][1] - 53.2) < 0.01)
  assert.equal(m.projection.x1, 336)
  assert.equal(m.projection.y1, 2)
  assert.equal(m.valueAtReset, 100)
  assert.equal(m.overflow, true)
  assert.equal(chartModel({ ...money, used_pct: null }, now), null)
})

test('statsFor reads windows and money in both modes', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = { kind: 'window', used_pct: 0, eta_seconds: 360000, resets_at: new Date(now + 18000 * 1000).toISOString() }
  const cases = [
    ['remaining At reset', row, 'remaining', [
      { label: 'Burn', value: '1.0%/h' },
      { label: 'At reset', value: '~95% left', warn: false },
      { label: 'Pace', value: '0.05×' }
    ]],
    ['window runs out', { ...row, resets_at: new Date(now + 360000 * 1000).toISOString() }, 'remaining', [
      { label: 'Burn', value: '1.0%/h' },
      { label: 'At reset', value: 'runs out', warn: true },
      { label: 'Pace', value: '1.0×' }
    ]],
    ['no rate', { kind: 'window', used_pct: 55, eta_seconds: 0 }, 'used', [
      { label: 'Burn', value: '-' },
      { label: 'At reset', value: '-', warn: false },
      { label: 'Pace', value: '-' }
    ]],
    ['used and remaining', { kind: 'window', used_pct: 40, eta_seconds: 3600, resets_at: new Date(now + 1800 * 1000).toISOString() }, 'used', [
      { label: 'Burn', value: '60.0%/h' },
      { label: 'At reset', value: '~70%', warn: false },
      { label: 'Pace', value: '0.7×' }
    ]],
    ['window runs out early', { kind: 'window', used_pct: 90, eta_seconds: 3600, resets_at: new Date(now + 7200 * 1000).toISOString() }, 'used', [
      { label: 'Burn', value: '10.0%/h' },
      { label: 'At reset', value: 'runs out', warn: true },
      { label: 'Pace', value: '1.1×' }
    ]],
    ['money used', { kind: 'money', total: 100, left: 20, cur: 'USD', used_pct: 80, depletes_in_seconds: 86400 }, 'used', [
      { label: 'Spend', value: '$20.00/d' },
      { label: 'Lasts', value: '~24h' },
      { label: 'Used', value: '80%' }
    ]],
    ['money remaining', { kind: 'money', total: 100, left: 20, cur: 'USD', used_pct: 80, depletes_in_seconds: 86400 }, 'remaining', [
      { label: 'Spend', value: '$20.00/d' },
      { label: 'Lasts', value: '~24h' },
      { label: 'Left', value: '20%' }
    ]],
    ['money without a value', { kind: 'money', used_pct: null, left: 5, cur: 'USD' }, 'used', [
      { label: 'Spend', value: '-' },
      { label: 'Lasts', value: '-' },
      { label: 'Used', value: '-' }
    ]]
  ]
  for (const [name, value, mode, expected] of cases) {
    assert.deepEqual(statsFor(value, now, mode), expected, name)
  }
})

test('expandedPanel opens on the bar quota and lists every quota tab', async () => {
  const { expandedPanel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', kind: 'window', used_pct: 20, resets_at: new Date(now + 1800 * 1000).toISOString() },
      { key: 'weekly', label: 'Weekly', kind: 'window', used_pct: 60 },
      { key: 'monthly', label: 'Monthly', kind: 'window', used_pct: 10 }
    ]
  }
  const panel = expandedPanel(p, { mode: 'used', choice: { zai: 'weekly' }, barIds: ['zai'], now: now })
  const tabs = findNodes(panel, n => n.type === 'div' && n.props && n.props.role === 'tablist')
  assert.equal(tabs.length, 1)
  const triggers = findNodes(panel, n => n.type === 'button' && n.props && n.props.role === 'tab')
  assert.equal(triggers.length, 3)
  assert.deepEqual(triggers.map(t => nodeText(t)), ['5h', 'Weekly', 'Monthly'])
  assert.equal(triggers[1].props['aria-selected'], true)
  assert.equal(triggers[0].props['aria-selected'], false)
  assert.equal(nodeText(panel).includes('Shown in status bar'), true)
  const plus = findNodes(
    panel,
    n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR && n.props.style.borderRadius === '50%'
  )
  assert.equal(plus.length, 1)
})

test('statsFor prints pace below one tenth with two decimals', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const paceAt = seconds =>
    statsFor(
      {
        kind: 'window',
        used_pct: 0,
        eta_seconds: 3600,
        resets_at: new Date(now + seconds * 1000).toISOString()
      },
      now
    )[2].value
  assert.equal(paceAt(180), '0.05×')
  assert.equal(paceAt(1512), '0.4×')
  assert.equal(paceAt(7.2), '0×')
})

test('statsElement draws three bordered cards in a three-column grid', async () => {
  const { expandedPanel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 40,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 3 * 3600 * 1000).toISOString()
  }
  const panel = expandedPanel(
    { id: 'zai', name: 'Zai', status: 'ok', windows: [row] },
    { mode: 'used', choice: {}, barIds: [], tab: '5h', now: now }
  )
  const grids = findNodes(panel, n => n.type === 'div' && n.props.style && n.props.style.gridTemplateColumns === 'repeat(3, minmax(0, 1fr))')
  assert.equal(grids.length, 1)
  const cards = grids[0].props.children
  assert.equal(cards.length, 3)
  for (const card of cards) {
    assert.equal(card.props.style.border, '1px solid var(--ui-stroke-tertiary)')
    assert.equal(card.props.style.borderRadius, 6)
    assert.equal(card.props.style.background, 'var(--ui-bg-secondary)')
    assert.equal(card.props.style.padding, '6px 8px')
  }
})

test('the show-in-bar button sets the tab quota and then reads Shown', async () => {
  const { expandedPanel } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', kind: 'window', used_pct: 20 },
      { key: 'weekly', label: 'Weekly', kind: 'window', used_pct: 60 }
    ]
  }
  const chosen = []
  const panel = expandedPanel(p, {
    mode: 'used',
    choice: {},
    barIds: ['zai'],
    tab: '5h',
    onShowInBar: key => chosen.push(key)
  })
  const button = findNodes(panel, n => n.type === 'button' && nodeText(n) === 'Show 5h in status bar')
  assert.equal(button.length, 1)
  assert.equal(nodeText(panel).includes('40%'), false)
  button[0].props.onClick()
  assert.deepEqual(chosen, ['5h'])
  const shown = expandedPanel(p, { mode: 'used', choice: { zai: '5h' }, barIds: ['zai'], tab: '5h' })
  assert.equal(findNodes(shown, n => n.type === 'button' && nodeText(n) === 'Shown in status bar').length, 1)
})

test('expandedPanel shows a money tab as left of total', async () => {
  const { expandedPanel } = await loadPlugin()
  const p = {
    id: 'openrouter',
    name: 'OpenRouter',
    status: 'ok',
    money: [
      { key: 'money:key_cap:usd', label: 'Key cap', kind: 'money', total: 10, left: 7, cur: 'USD', used_pct: 30 }
    ]
  }
  const panel = expandedPanel(p, { mode: 'used', choice: {}, barIds: [], tab: 'money:key_cap:usd' })
  assert.ok(nodeText(panel).includes('$7.00 of $10.00 left'))
})

test('the provider name button carries aria-expanded and the chevron first', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = { id: 'zai', name: 'Zai', tag: 'Pro', status: 'ok', windows: [{ key: '5h', label: '5h', used_pct: 20 }] }
  const closed = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: false })
  const closedButton = findNodes(closed, n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(closedButton.length, 1)
  assert.equal(closedButton[0].props['aria-expanded'], false)
  assert.equal(closedButton[0].props.children[0].type, 'svg')
  assert.equal(closedButton[0].props.children[1], 'Zai')
  const closedChevron = findNodes(closedButton[0], n => n.type === 'svg' && n.props.style)
  assert.equal(closedChevron[0].props.style.transform, 'none')
  assert.equal(closedChevron[0].props.style.color, 'var(--ui-text-tertiary)')
  assert.equal(closedChevron[0].props.width, 11)
  assert.equal(closedChevron[0].props.height, 11)
  assert.equal(closedChevron[0].props.strokeWidth, 2.4)
  const open = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: true })
  const openButton = findNodes(open, n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(openButton[0].props['aria-expanded'], true)
  const openChevron = findNodes(openButton[0], n => n.type === 'svg' && n.props.style)
  assert.equal(openChevron[0].props.style.transform, 'rotate(90deg)')
})

test('the pin control uses the two-path outline and fills only when pinned', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = { id: 'zai', name: 'Zai', status: 'ok', windows: [{ key: '5h', label: '5h', used_pct: 20 }] }
  const off = providerRowElement(p, { mode: 'used', pins: [], barIds: [] })
  const offPin = findNodes(off, n => n.type === 'button' && n.props['aria-label'] === 'Pin Zai to status bar')
  assert.equal(offPin.length, 1)
  const offSvg = findNodes(offPin[0], n => n.type === 'svg')[0]
  assert.equal(offSvg.props.fill, 'none')
  const offPaths = findNodes(offSvg, n => n.type === 'path')
  assert.equal(offPaths.length, 2)
  assert.deepEqual(offPaths.map(path => path.props.d), [
    'M12 17v5',
    'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
  ])
  const on = providerRowElement(p, { mode: 'used', pins: ['zai'], barIds: [] })
  const onPin = findNodes(on, n => n.type === 'button' && n.props['aria-label'] === 'Unpin Zai from status bar')
  const onSvg = findNodes(onPin[0], n => n.type === 'svg')[0]
  assert.equal(onSvg.props.fill, 'currentColor')
  assert.equal(findNodes(onSvg, n => n.type === 'path').length, 2)
})

test('nextOpenId keeps one provider open at a time', async () => {
  const { nextOpenId } = await loadPlugin()
  assert.equal(nextOpenId(null, 'a'), 'a')
  assert.equal(nextOpenId('a', 'b'), 'b')
  assert.equal(nextOpenId('a', 'a'), null)
})

test('the bar quota choice persists under barQuota', async () => {
  const { default: plugin, setBarQuota } = await loadPlugin()
  const { ctx, data } = fakeContext()
  data.barQuota = { zai: 'weekly' }
  plugin.register(ctx)
  setBarQuota('nous', '5h')
  assert.deepEqual(data.barQuota, { zai: 'weekly', nous: '5h' })
})

test('the tooltip and the dot follow the chosen bar quota', async () => {
  const { barModel, tipEntries, providerRowElement } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', kind: 'window', used_pct: 20, warn: false },
      { key: 'weekly', label: 'Weekly', kind: 'window', used_pct: 60, warn: false }
    ]
  }
  const chosen = barModel([p], ['zai'], null, 'used', null, { zai: '5h' })
  assert.equal(chosen.entries[0].label, '5h')
  assert.deepEqual(tipEntries(chosen.entries), [{ name: 'Zai', label: '5h', value: '20%', attention: false }])
  const row = providerRowElement(p, { mode: 'used', pins: [], barIds: ['zai'], choice: { zai: '5h' } })
  const grid = row.props.children[1]
  const cells = grid.props.children
  const dotOn = cells.filter(cell =>
    findNodes(cell, n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR && n.props.style.borderRadius === '50%').length
  )
  assert.equal(dotOn.length, 1)
  assert.ok(nodeText(dotOn[0]).includes('5h'))
})

test('chartModel filters and orders history samples', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const cases = [
    {
      label: 'clamps out-of-range values',
      history: [[now / 1000 - 3600, 150], [now / 1000 - 1800, -20], [now / 1000, 40]],
      length: 3,
      firstY: 2,
      secondY: 66
    },
    {
      label: 'drops a future sample',
      history: [[now / 1000 + 600, 90], [now / 1000, 40]],
      length: 1,
      firstX: 220,
      firstY: 40.4
    },
    {
      label: 'drops a sample older than six hours',
      history: [[now / 1000 - 7 * 3600, 10], [now / 1000, 40]],
      length: 1,
      firstX: 220
    },
    {
      label: 'sorts newest first',
      history: [[now / 1000, 40], [now / 1000 - 3600, 20]],
      length: 2,
      firstX: 220 - 220 / 6,
      secondX: 220
    },
    {
      label: 'maps money through the row total',
      row: {
        kind: 'money',
        total: 20,
        left: 15,
        cur: 'USD',
        used_pct: 25,
        history: [[now / 1000 - 3600, 5], [now / 1000, 5]]
      },
      length: 2,
      firstY: 50
    }
  ]
  for (const c of cases) {
    const m = chartModel(c.row || { kind: 'window', used_pct: 40, history: c.history }, now)
    assert.equal(m.series.length, c.length, c.label)
    if (c.firstX !== undefined) assert.ok(Math.abs(m.series[0][0] - c.firstX) < 0.01, c.label)
    if (c.firstY !== undefined) assert.ok(Math.abs(m.series[0][1] - c.firstY) < 0.01, c.label)
    if (c.secondX !== undefined) assert.ok(Math.abs(m.series[1][0] - c.secondX) < 0.01, c.label)
    if (c.secondY !== undefined) assert.equal(m.series[1][1], c.secondY, c.label)
  }
})

test('chartModel ignores a reset that already passed', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      eta_seconds: 600,
      resets_at: new Date(now - 3600 * 1000).toISOString()
    },
    now
  )
  assert.equal(m.projection, null)
  assert.equal(m.valueAtReset, null)
})

test('chartModel turns amber on an actionable eta alone', async () => {
  const { chartModel } = await loadPlugin()
  const m = chartModel(
    { kind: 'window', used_pct: 40, warn: false, actionable_eta: 600, resets_at: null },
    Date.now()
  )
  assert.equal(m.colour, 'amber')
})

test('a money tab without a used_pct shows the no-cap text and no chart', async () => {
  const { expandedPanel } = await loadPlugin()
  const p = {
    id: 'openrouter',
    name: 'OpenRouter',
    status: 'ok',
    money: [
      { key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null }
    ]
  }
  const panel = expandedPanel(p, { mode: 'used', choice: {}, barIds: [], tab: 'money:balance:usd' })
  assert.ok(nodeText(panel).includes('No cap, so no chart'))
  assert.equal(findNodes(panel, n => n.type === 'svg').length, 0)
})

test('the chart aria-label names the provider, quota and forecast', async () => {
  const { expandedPanel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const over = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [
      {
        key: '5h',
        label: '5h',
        kind: 'window',
        used_pct: 90,
        eta_seconds: 1000,
        resets_at: new Date(now + 3600 * 1000).toISOString()
      }
    ]
  }
  const overPanel = expandedPanel(over, { mode: 'used', choice: {}, barIds: [], tab: '5h', now: now })
  const overSvg = findNodes(overPanel, n => n.type === 'svg' && n.props.role === 'img')
  assert.equal(overSvg.length, 1)
  assert.equal(overSvg[0].props['aria-label'], 'Zai 5h projected to run out before reset')
  const calm = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [
      {
        key: '5h',
        label: '5h',
        kind: 'window',
        used_pct: 40,
        eta_seconds: 7200,
        resets_at: new Date(now + 3600 * 1000).toISOString()
      }
    ]
  }
  const calmPanel = expandedPanel(calm, { mode: 'used', choice: {}, barIds: [], tab: '5h', now: now })
  const calmSvg = findNodes(calmPanel, n => n.type === 'svg' && n.props.role === 'img')
  assert.equal(calmSvg[0].props['aria-label'], 'Zai 5h on track')
})

test('an open row carries the raised background and a closed one does not', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    tag: 'Pro',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 20 }]
  }
  const closed = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: false })
  assert.equal(closed.props.style.background, 'transparent')
  const open = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: true })
  assert.equal(open.props.style.background, 'var(--ui-bg-elevated)')
})

/* ---------- per-window alert thresholds ---------- */

test('alertThreshold reads only saved window steps', async () => {
  const { alertThreshold } = await loadPlugin()
  const row = { key: '5h', kind: 'window' }
  assert.equal(alertThreshold({}, 'zai', row), null)
  assert.equal(alertThreshold(null, 'zai', row), null)
  assert.equal(alertThreshold({ 'zai:5h': 90 }, 'zai', row), 90)
  assert.equal(alertThreshold({ 'zai:5h': 'off' }, 'zai', row), 'off')
  assert.equal(alertThreshold({ 'zai:5h': 90 }, 'nous', row), null)
  assert.equal(alertThreshold({ 'zai:5h': 80 }, 'zai', { key: 'weekly', kind: 'window' }), null)
  assert.equal(alertThreshold({ 'zai:5h': 90 }, 'zai', { key: '5h', kind: 'money' }), null)
  assert.equal(alertThreshold({ 'zai:5h': 'junk' }, 'zai', row), null)
})

test('the saved alert map drops junk on load and persists new picks', async () => {
  const { default: plugin, setAlert } = await loadPlugin()
  const { ctx, data } = fakeContext()
  data.alertAt = { 'zai:5h': 90, 'zai:weekly': '40', 'nous:5h': 'off', 'x:y': 'junk' }
  plugin.register(ctx)
  setAlert('zai', '5h', 95)
  assert.deepEqual(data.alertAt, { 'zai:5h': 95, 'nous:5h': 'off' })
  const again = await loadPlugin()
  const second = fakeContext()
  second.data.alertAt = 'not an object'
  again.default.register(second.ctx)
  again.setAlert('a', 'b', 90)
  assert.deepEqual(second.data.alertAt, { 'a:b': 90 })
})

test('a 90 threshold alarms at 92 and stays silent at 85', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('zai', '5h', 90)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 85, warn: true, resets_at: isoAt(NOW + 1800000) }]
        }
      ]
    })
    assert.equal(notices.length, 0)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 92, warn: false, resets_at: isoAt(NOW + 3600000) }]
        }
      ]
    })
    assert.equal(notices.length, 1)
    assert.equal(notices[0].title, 'Zai: 5h at 92% used')
  } finally {
    restore()
  }
})

test('a window exactly at the threshold fires', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('nous', 'weekly', 90)
    checkAlerts({
      providers: [
        {
          id: 'nous',
          name: 'Nous',
          status: 'ok',
          windows: [{ key: 'weekly', label: 'Weekly', used_pct: 90, warn: false, resets_at: isoAt(NOW + 5400000) }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('an off threshold never fires', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('zai', '5h', 'off')
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 99, warn: true, resets_at: isoAt(NOW + 1800000) }]
        }
      ]
    })
    assert.equal(notices.length, 0)
  } finally {
    restore()
  }
})

test('a 50 threshold fires below the backend warn flag', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('zai', '5h', 50)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 55, warn: false, resets_at: isoAt(NOW + 1800000) }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('an unsaved threshold still follows the backend warn flag', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 99, warn: false, resets_at: isoAt(NOW + 1800000) }]
        }
      ]
    })
    assert.equal(notices.length, 0)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 92, warn: true, resets_at: isoAt(NOW + 3600000) }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('a saved threshold does not change money alerts', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('or', 'money:key_cap:usd', 'off')
    checkAlerts({
      providers: [
        {
          id: 'or',
          name: 'OpenRouter',
          status: 'ok',
          money: [
            {
              key: 'money:key_cap:usd',
              label: 'Key cap',
              kind: 'money',
              total: 10,
              left: 2,
              cur: 'USD',
              used_pct: 80,
              warn: true
            }
          ]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('changing the threshold mid-cycle does not fire twice', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin, setAlert } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    setAlert('zai', '5h', 90)
    const payload = {
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 92, warn: true, resets_at: isoAt(NOW + 3600000) }]
        }
      ]
    }
    checkAlerts(payload)
    setAlert('zai', '5h', 80)
    checkAlerts(payload)
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('the chart follows the saved threshold and drops the line when off', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const row = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 40,
    resets_at: new Date(now + 3600000).toISOString()
  }
  assert.deepEqual(chartModel(row, now).alert, { value: 80, y: 14.8, label: 'alert 80%' })
  assert.deepEqual(chartModel(row, now, 90).alert, { value: 90, y: 8.4, label: 'alert 90%' })
  assert.equal(chartModel(row, now, 'off').alert, null)
  const loud = chartModel({ ...row, used_pct: 90, warn: false }, now, 50)
  assert.equal(loud.colour, 'accent')
})

test('the expanded row collapses the alert choice and note until the alert button opens it', async () => {
  const { expandedPanel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 40, resets_at: new Date(now + 3600000).toISOString() }]
  }
  const panel = expandedPanel(p, { mode: 'used', choice: {}, barIds: [], tab: '5h', alertAt: { 'zai:5h': 90 } })
  assert.ok(nodeText(panel).includes('alert 90%'))
  assert.ok(nodeText(panel).includes('Alert at 90%'))
  assert.equal(nodeText(panel).includes('Notifications appear while Hermes is in the background.'), false)
  const open = expandedPanel(p, {
    mode: 'used', choice: {}, barIds: [], tab: '5h', alertAt: { 'zai:5h': 90 }, alertOpen: true
  })
  assert.ok(nodeText(open).includes('Notifications appear while Hermes is in the background.'))
  const openButton = findNodes(open, n => n.type === 'button' && nodeText(n) === 'Alert at 90%')
  assert.equal(openButton.length, 1)
  assert.equal(openButton[0].props['aria-expanded'], true)
  const line = findNodes(panel, n => n.type === 'line' && n.props.key === 'alert')
  assert.equal(line.length, 1)
  assert.equal(line[0].props.y1, 8.4)
  const offPanel = expandedPanel(p, { mode: 'used', choice: {}, barIds: [], tab: '5h', alertAt: { 'zai:5h': 'off' } })
  assert.equal(findNodes(offPanel, n => n.type === 'line' && n.props.key === 'alert').length, 0)
  assert.ok(nodeText(offPanel).includes('Alert off'))
  assert.equal(nodeText(offPanel).includes('alert 80%'), false)
})

test('the open alert control offers the six steps, reports a pick and closes', async () => {
  const { expandedPanel } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 40 }]
  }
  const picks = []
  let closed = 0
  const panel = expandedPanel(p, {
    mode: 'used',
    choice: {},
    barIds: [],
    tab: '5h',
    alertAt: { 'zai:5h': 90 },
    alertOpen: true,
    onAlert: (rowKey, value) => picks.push([rowKey, value]),
    onAlertClose: () => { closed += 1 }
  })
  const group = findNodes(panel, n => n.type === 'div' && n.props && n.props['aria-label'] === 'Alert threshold')
  assert.equal(group.length, 1)
  const wrapper = findNodes(panel, n => n.type === 'div' && n.props && n.props.key === 'alert')
  assert.equal(wrapper.length, 1)
  assert.equal(wrapper[0].props.style.alignItems, 'flex-start')
  const control = findNodes(group[0], n => n.type === 'button')
  assert.deepEqual(control.map(b => nodeText(b)), ['50', '70', '80', '90', '95', 'Off'])
  assert.equal(control[3].props['aria-pressed'], true)
  assert.equal(control[2].props['aria-pressed'], false)
  control[1].props.onClick()
  control[5].props.onClick()
  assert.deepEqual(picks, [
    ['5h', 70],
    ['5h', 'off']
  ])
  assert.equal(closed, 2)
  const moneyPanel = expandedPanel(
    { id: 'or', name: 'OpenRouter', status: 'ok', money: [{ key: 'money:key_cap:usd', label: 'Key cap', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 }] },
    { mode: 'used', choice: {}, barIds: [], tab: 'money:key_cap:usd', alertOpen: true }
  )
  assert.equal(findNodes(moneyPanel, n => n.type === 'div' && n.props && n.props['aria-label'] === 'Alert threshold').length, 0)
  assert.equal(nodeText(moneyPanel).includes('Notifications appear while Hermes is in the background.'), false)
})

test('a real payload shape drives the bar values', async () => {
  const { readFile } = await import('node:fs/promises')
  const payload = JSON.parse(await readFile(new URL('./payload.json', import.meta.url), 'utf8'))
  const { barModel } = await loadPlugin()
  const [anthropic, openrouter] = payload.providers
  assert.equal(barValue(barModel, anthropic, 'used'), '95%')
  assert.equal(barValue(barModel, anthropic, 'remaining'), '5%')
  assert.equal(barValue(barModel, openrouter, 'used'), '$8.00')
  assert.equal(barValue(barModel, openrouter, 'remaining'), '$2.00')
})

test('the default export registers one status item', async () => {
  const { default: plugin } = await loadPlugin()
  const { ctx, registrations } = fakeContext()
  assert.equal(plugin.id, 'provider-usage')
  assert.equal(typeof plugin.register, 'function')
  plugin.register(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'status')
})

/* ---------- redesign phase 1: pins, session follow, grouping, layout ---------- */

test('a saved eye array carries over as pins unchanged', async () => {
  const { pinnedIds, allPinned } = await loadPlugin()
  const ids = ['zai', 'anthropic', 'nous']
  assert.deepEqual(pinnedIds(['nous', 'zai'], ids), ['zai', 'nous'])
  assert.deepEqual(pinnedIds(null, ids), [])
  assert.deepEqual(pinnedIds(['zai', 'gone'], ids), ['zai'])
  assert.equal(allPinned(['zai', 'anthropic', 'nous'], ids), true)
  assert.equal(allPinned(['zai'], ids), false)
  assert.equal(allPinned([], ids), false)
  assert.equal(allPinned(['zai'], []), false)
})

test('togglePin adds, removes, and treats null as empty', async () => {
  const { togglePin } = await loadPlugin()
  assert.deepEqual(togglePin(null, 'zai'), ['zai'])
  assert.deepEqual(togglePin(['zai'], 'nous'), ['zai', 'nous'])
  assert.deepEqual(togglePin(['zai', 'nous'], 'zai'), ['nous'])
  assert.deepEqual(togglePin([], 'zai'), ['zai'])
})

test('normaliseProvider maps Hermes aliases and rejects junk', async () => {
  const { normaliseProvider } = await loadPlugin()
  assert.equal(normaliseProvider('minimax-cn'), 'minimax')
  assert.equal(normaliseProvider('KIMI-CODING-CN'), 'kimi-coding')
  assert.equal(normaliseProvider('copilot-acp'), 'copilot')
  assert.equal(normaliseProvider('  GLM '), 'zai')
  assert.equal(normaliseProvider('claude-code'), 'anthropic')
  assert.equal(normaliseProvider('go'), 'opencode-go')
  assert.equal(normaliseProvider('or'), 'openrouter')
  assert.equal(normaliseProvider('github'), 'copilot')
  assert.equal(normaliseProvider('moonshot'), 'kimi-coding')
  assert.equal(normaliseProvider('minimax-china'), 'minimax')
  assert.equal(normaliseProvider('deepseek'), 'deepseek')
  assert.equal(normaliseProvider(''), null)
  assert.equal(normaliseProvider('   '), null)
  assert.equal(normaliseProvider(42), null)
  assert.equal(normaliseProvider(null), null)
})

test('barProviderIds follows the session when nothing is pinned, and Unpin all returns to it', async () => {
  const { barProviderIds } = await loadPlugin()
  const ids = ['zai', 'anthropic', 'nous']
  assert.deepEqual(barProviderIds(null, ids, 'claude'), ['anthropic'])
  assert.deepEqual(barProviderIds(['nous'], ids, 'zai'), ['nous'])
  assert.deepEqual(barProviderIds([], ids, 'zai'), ['zai'])
  assert.deepEqual(barProviderIds(['nous'], ids, 'anthropic'), ['nous'])
  assert.deepEqual(barProviderIds(null, ids, 'gemini'), [])
  assert.deepEqual(barProviderIds(null, ids, null), [])
})

test('readSessionProvider reads model.options for the focused session', async () => {
  const { readSessionProvider } = await loadPlugin()
  const calls = []
  const host = {
    request: (method, params) => {
      calls.push([method, params])
      return Promise.resolve({ providers: [], model: 'm', provider: 'copilot-acp' })
    }
  }
  assert.equal(await readSessionProvider(host, 'sess-1', 50), 'copilot-acp')
  assert.deepEqual(calls, [['model.options', { session_id: 'sess-1' }]])
  assert.equal(await readSessionProvider(host, '', 50), null)
  assert.equal(calls.length, 1)
})

test('readSessionProvider turns every failure into null', async () => {
  const { readSessionProvider } = await loadPlugin()
  const throwing = { request: () => { throw new Error('boom') } }
  const rejecting = { request: () => Promise.reject(new Error('down')) }
  const nonString = { request: () => Promise.resolve({ provider: 42 }) }
  const empty = { request: () => Promise.resolve(null) }
  assert.equal(await readSessionProvider(throwing, 's', 50), null)
  assert.equal(await readSessionProvider(rejecting, 's', 50), null)
  assert.equal(await readSessionProvider(nonString, 's', 50), null)
  assert.equal(await readSessionProvider(empty, 's', 50), null)
  assert.equal(await readSessionProvider({}, 's', 50), null)
  assert.equal(await readSessionProvider(null, 's', 50), null)
  const hanging = { request: () => new Promise(() => {}) }
  assert.equal(await readSessionProvider(hanging, 's', 5), null)
})

test('providerAttention follows warn and actionable_eta', async () => {
  const { providerAttention } = await loadPlugin()
  assert.equal(providerAttention({ status: 'ok', windows: [{ warn: false, actionable_eta: null }] }), false)
  assert.equal(providerAttention({ status: 'ok', windows: [{ warn: true }] }), true)
  assert.equal(providerAttention({ status: 'ok', windows: [{ warn: false, actionable_eta: 900 }] }), true)
  assert.equal(providerAttention({ status: 'ok', money: [{ warn: false, actionable_eta: 0 }] }), true)
  assert.equal(providerAttention({ status: 'error', windows: [{ warn: true }] }), false)
  assert.equal(providerAttention(null), false)
})

test('attentionNote names the earliest eta by kind', async () => {
  const { attentionNote } = await loadPlugin()
  assert.equal(attentionNote({ status: 'ok', windows: [{ actionable_eta: 1800 }] }), 'full ~30m')
  assert.equal(attentionNote({ status: 'ok', money: [{ actionable_eta: 3600 }] }), 'runs out ~60m')
  assert.equal(
    attentionNote({
      status: 'ok',
      windows: [{ actionable_eta: 7200 }],
      money: [{ actionable_eta: 1800 }]
    }),
    'runs out ~30m'
  )
  assert.equal(attentionNote({ status: 'ok', windows: [{ actionable_eta: null }] }), '')
  assert.equal(attentionNote({ status: 'error', windows: [{ actionable_eta: 60 }] }), '')
})

test('projectedFull flags a fast window only after the ten percent guard', async () => {
  const { projectedFull } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const base = {
    kind: 'window',
    used_pct: 78,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 3 * 3600 * 1000).toISOString()
  }
  const seconds = projectedFull(base, now)
  assert.ok(seconds > 0 && seconds < 3 * 3600)
  assert.equal(
    projectedFull({ ...base, resets_at: new Date(now + (5 * 3600 - 600) * 1000).toISOString() }, now),
    null
  )
  assert.equal(
    projectedFull({ ...base, used_pct: 10, resets_at: new Date(now + 3600 * 1000).toISOString() }, now),
    null
  )
  assert.equal(projectedFull({ ...base, used_pct: null }, now), null)
  assert.equal(projectedFull({ ...base, used_pct: 100 }, now), null)
  assert.equal(projectedFull({ ...base, kind: 'money' }, now), null)
  assert.equal(projectedFull({ ...base, eta_seconds: 3600 }, now), null)
})

test('rowAttention uses one rule for warn, actionable eta and projection', async () => {
  const { rowAttention, projectedFull } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  assert.equal(rowAttention(null, now), false)
  assert.equal(rowAttention({ warn: false, actionable_eta: null }, now), false)
  assert.equal(rowAttention({ warn: true, actionable_eta: null }, now), true)
  assert.equal(rowAttention({ warn: false, actionable_eta: 0 }, now), true)
  const projected = {
    kind: 'window',
    used_pct: 78,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 3 * 3600 * 1000).toISOString()
  }
  assert.ok(projectedFull(projected, now) > 0)
  assert.equal(rowAttention(projected, now), true)
})

test('providerAttention and attentionNote see a projected run-out', async () => {
  const { providerAttention, attentionNote, groupProviders, chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const projected = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 78,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 3 * 3600 * 1000).toISOString()
  }
  const p = { id: 'x', name: 'X', status: 'ok', windows: [projected] }
  assert.equal(providerAttention(p, now), true)
  assert.equal(attentionNote(p, now), 'full ~34m')
  assert.equal(groupProviders([p], 'all', [], now)[0].title, 'Needs attention')
  assert.equal(chartModel(projected, now).colour, 'amber')
  const withActionable = {
    status: 'ok',
    windows: [projected, { kind: 'window', used_pct: 10, actionable_eta: 600 }]
  }
  assert.equal(attentionNote(withActionable, now), 'full ~10m')
  const laterActionable = {
    status: 'ok',
    windows: [projected, { kind: 'window', used_pct: 10, actionable_eta: 3600 }]
  }
  assert.equal(attentionNote(laterActionable, now), 'full ~34m')
})

test('an indicative row is neutral while a normal row still flags', async () => {
  const {
    rowAttention,
    providerAttention,
    attentionNote,
    chartModel,
    barQuotaKey,
    alertThreshold,
    checkAlerts,
    expandedPanel,
    setAlert,
    default: plugin
  } = await loadPlugin()
  const booster = {
    key: 'booster',
    label: 'Booster',
    kind: 'window',
    percent: 95,
    used_pct: 95,
    warn: true,
    actionable_eta: null,
    indicative: true
  }
  const monthly = {
    key: 'monthly',
    label: 'Monthly',
    kind: 'window',
    percent: 100,
    used_pct: 100,
    warn: true,
    actionable_eta: 3600
  }
  const p = { id: 'kimi-coding', name: 'Kimi', status: 'ok', windows: [booster, monthly] }
  assert.equal(rowAttention(booster, NOW), false)
  assert.equal(providerAttention({ status: 'ok', windows: [booster] }, NOW), false)
  assert.equal(attentionNote({ status: 'ok', windows: [booster] }, NOW), '')
  assert.equal(providerAttention(p, NOW), true)
  assert.equal(attentionNote(p, NOW), 'full ~60m')
  assert.equal(chartModel(booster, NOW).colour, 'accent')
  assert.equal(chartModel(booster, NOW).alert, null)
  assert.equal(chartModel(monthly, NOW).colour, 'amber')
  assert.equal(alertThreshold({ 'kimi-coding:booster': 90 }, 'kimi-coding', booster), null)

  const barP = {
    id: 'kimi-coding',
    status: 'ok',
    windows: [booster, { ...monthly, key: 'normal', label: 'Normal', used_pct: 10, warn: false }]
  }
  assert.equal(barQuotaKey(barP, null), 'normal')
  assert.equal(barQuotaKey(barP, { 'kimi-coding': 'booster' }), 'booster')

  const { ctx, notices } = fakeContext()
  plugin.register(ctx)
  setAlert('kimi-coding', 'booster', 80)
  checkAlerts({ providers: [p] })
  assert.equal(notices.filter(n => n.title.includes('Booster')).length, 0)
  assert.equal(notices.filter(n => n.title.includes('Monthly')).length, 1)

  const panel = expandedPanel(p, {
    mode: 'used',
    choice: {},
    barIds: [],
    tab: 'booster',
    now: NOW,
    alertAt: { 'kimi-coding:booster': 90 }
  })
  assert.equal(findNodes(panel, n => n.type === 'button' && nodeText(n).includes('Alert')).length, 0)
})

test('a long low-use window is not in Needs attention and has no note', async () => {
  const { providerAttention, attentionNote, groupProviders } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const p = {
    id: 'x',
    status: 'ok',
    windows: [
      {
        key: 'monthly',
        label: 'Monthly',
        kind: 'window',
        used_pct: 2,
        warn: false,
        actionable_eta: null,
        duration_seconds: 30 * 86400,
        resets_at: new Date(now + 20 * 86400 * 1000).toISOString()
      }
    ]
  }
  assert.equal(providerAttention(p, now), false)
  assert.equal(attentionNote(p, now), '')
  assert.equal(groupProviders([p], 'all', [], now)[0].title, 'Providers')
})

test('a projected quota and the bar use the warn colour', async () => {
  const { providerRowElement, barModel, barContent } = await loadPlugin()
  const now = Date.now()
  const row = {
    key: '5h',
    label: '5h',
    kind: 'window',
    used_pct: 78,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 3 * 3600 * 1000).toISOString()
  }
  const p = { id: 'x', name: 'X', status: 'ok', windows: [row] }
  const node = providerRowElement(p, { mode: 'used', pins: [], barIds: [], now: now })
  const value = findNodes(node, n => n.type === 'span' && nodeText(n) === '78%')
  assert.equal(value.length, 1)
  assert.equal(value[0].props.style.color, WARN_COLOR)
  assert.equal(findNodes(node, n => n.type === 'span' && n.props.style && n.props.style.background === WARN_COLOR).length, 1)
  const model = barModel([p], ['x'], null, 'used', null, {})
  assert.equal(model.entries[0].attention, true)
  const content = barContent(model)
  assert.ok(findNodes(content, n => n.props && n.props.style && n.props.style.color === WARN_COLOR).length >= 1)
})

test('warn and accent bars and tip swatches use inline colours', async () => {
  const { providerRowElement, tipBody } = await loadPlugin()
  const loud = providerRowElement(
    { id: 'zai', name: 'Zai', status: 'ok', windows: [{ key: '5h', label: '5h', used_pct: 20, warn: true }] },
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  const quiet = providerRowElement(
    { id: 'zai', name: 'Zai', status: 'ok', windows: [{ key: '5h', label: '5h', used_pct: 20, warn: false }] },
    { mode: 'used', pins: [], barIds: [], expanded: false }
  )
  const bars = node =>
    findNodes(node, n => n.props && n.props.style && n.props.style.height === '100%' && n.props.style.background)
  assert.equal(bars(loud)[0].props.style.background, WARN_COLOR)
  assert.equal(bars(quiet)[0].props.style.background, ACCENT_COLOR)
  const tip = tipBody(
    [
      { name: 'Zai', label: '5h', value: '20%', attention: false },
      { name: 'Claude', label: 'Weekly', value: '95%', attention: true }
    ],
    '09:41'
  )
  const swatches = findNodes(tip, n => n.props && n.props.style && n.props.style.width === 4 && n.props.style.height === 10)
  assert.deepEqual(swatches.map(node => node.props.style.background), [ACCENT_COLOR, WARN_COLOR])
})

test('groupProviders puts attention first and keeps backend order', async () => {
  const { groupProviders } = await loadPlugin()
  const quiet = { id: 'a', status: 'ok', windows: [{ warn: false, actionable_eta: null }] }
  const loud = { id: 'b', status: 'ok', windows: [{ warn: true }] }
  const alsoLoud = { id: 'c', status: 'ok', money: [{ warn: false, actionable_eta: 60 }] }
  const groups = groupProviders([quiet, loud, alsoLoud], 'all', null)
  assert.deepEqual(groups.map(g => g.title), ['Needs attention', 'Everything else'])
  assert.deepEqual(groups[0].rows.map(p => p.id), ['b', 'c'])
  assert.deepEqual(groups[1].rows.map(p => p.id), ['a'])
  const calm = groupProviders([quiet], 'all', null)
  assert.deepEqual(calm.map(g => g.title), ['Providers'])
  assert.deepEqual(calm[0].rows.map(p => p.id), ['a'])
  const onlyLoud = groupProviders([loud], 'all', null)
  assert.deepEqual(onlyLoud.map(g => g.title), ['Needs attention'])
})

test('groupProviders keeps only pinned ids in pinned view', async () => {
  const { groupProviders } = await loadPlugin()
  const a = { id: 'a', status: 'ok', windows: [] }
  const b = { id: 'b', status: 'ok', windows: [{ warn: true }] }
  const c = { id: 'c', status: 'ok', windows: [] }
  const pinned = groupProviders([a, b, c], 'pinned', ['c', 'a'])
  assert.deepEqual(pinned.map(g => g.title), ['Providers'])
  assert.deepEqual(pinned[0].rows.map(p => p.id), ['a', 'c'])
  assert.deepEqual(groupProviders([a, b, c], 'pinned', null), [])
})

test('visibleQuotas returns everything at three or fewer', async () => {
  const { visibleQuotas } = await loadPlugin()
  const p = { windows: [{ key: '5h', used_pct: 10 }, { key: 'weekly', used_pct: 90 }] }
  const out = visibleQuotas(p, '5h')
  assert.deepEqual(out.shown.map(r => r.key), ['5h', 'weekly'])
  assert.equal(out.more, 0)
})

test('visibleQuotas trims exactly four quotas to three', async () => {
  const { visibleQuotas } = await loadPlugin()
  const p = {
    windows: [
      { key: 'a', used_pct: 90, duration_seconds: 18000 },
      { key: 'b', used_pct: 20, duration_seconds: 604800 },
      { key: 'c', used_pct: 10, duration_seconds: 2592000 },
      { key: 'd', used_pct: 5 }
    ]
  }
  const out = visibleQuotas(p, 'a')
  assert.deepEqual(out.shown.map(r => r.key), ['a', 'b', 'c'])
  assert.equal(out.more, 1)
})

test('visibleQuotas takes the top three and always keeps the bar quota', async () => {
  const { visibleQuotas } = await loadPlugin()
  const p = {
    windows: [
      { key: 'a', used_pct: 90, duration_seconds: 604800 },
      { key: 'b', used_pct: 80, duration_seconds: 18000 },
      { key: 'c', used_pct: 70, duration_seconds: 2592000 },
      { key: 'bar', used_pct: 5, duration_seconds: 3600 },
      { key: 'd', used_pct: null }
    ]
  }
  const out = visibleQuotas(p, 'bar')
  assert.deepEqual(out.shown.map(r => r.key), ['bar', 'b', 'a'])
  assert.equal(out.more, 2)
  const withoutBar = visibleQuotas(p, 'nope')
  assert.deepEqual(withoutBar.shown.map(r => r.key), ['b', 'a', 'c'])
  assert.equal(withoutBar.more, 2)
})

test('visibleQuotas orders windows by length, then money', async () => {
  const { visibleQuotas } = await loadPlugin()
  const p = {
    windows: [
      { key: 'long', used_pct: 90, duration_seconds: 2592000 },
      { key: 'short', used_pct: 80, duration_seconds: 18000 },
      { key: 'unknown', used_pct: 70 },
      { key: 'mid', used_pct: 60, duration_seconds: 604800 }
    ],
    money: [{ key: 'money:key_cap:usd', used_pct: 95 }]
  }
  const out = visibleQuotas(p, null)
  assert.deepEqual(out.shown.map(r => r.key), ['short', 'long', 'money:key_cap:usd'])
  assert.equal(out.more, 2)
})

test('barQuotaKey defaults to the highest used row and honours a choice', async () => {
  const { barQuotaKey, barModel } = await loadPlugin()
  const money = {
    id: 'or',
    status: 'ok',
    money: [
      { key: 'money:balance:usd', kind: 'money', total: 10, left: 9, cur: 'USD', used_pct: 10 },
      { key: 'money:key_cap:usd', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 }
    ]
  }
  assert.equal(barQuotaKey(money), 'money:key_cap:usd')
  assert.equal(barValue(barModel, money, 'used'), '$8.00')
  assert.equal(barQuotaKey(money, { or: 'money:balance:usd' }), 'money:balance:usd')
  assert.equal(barValue(barModel, money, 'used', { or: 'money:balance:usd' }), '$1.00')
  const windows = {
    id: 'zai',
    status: 'ok',
    windows: [
      { key: 'weekly', scope: 'account', duration_seconds: 604800, used_pct: 10 },
      { key: '5h', scope: 'account', duration_seconds: 18000, used_pct: 20 },
      { key: 'opus', scope: 'model', duration_seconds: 1800, used_pct: 99 }
    ]
  }
  assert.equal(barQuotaKey(windows), 'opus')
  assert.equal(barValue(barModel, windows, 'used'), '99%')
  assert.equal(barQuotaKey(windows, { zai: '5h' }), '5h')
  assert.equal(barValue(barModel, windows, 'used', { zai: '5h' }), '20%')
  assert.equal(barQuotaKey(windows, { zai: 'gone' }), 'opus')
  assert.equal(barQuotaKey(windows, { other: '5h' }), 'opus')
  const plain = { status: 'ok', windows: [{ key: 'weekly', scope: 'account', used_pct: 10 }] }
  assert.equal(barQuotaKey(plain), 'weekly')
  const noPct = {
    id: 'x',
    status: 'ok',
    windows: [
      { key: 'a', used_pct: null },
      { key: 'b', used_pct: null }
    ]
  }
  assert.equal(barQuotaKey(noPct), 'a')
  const ties = {
    id: 'y',
    status: 'ok',
    windows: [
      { key: 't1', used_pct: 50 },
      { key: 't2', used_pct: 50 }
    ]
  }
  assert.equal(barQuotaKey(ties), 't1')
})

test('barLayout renders 1 to 3 entries full, attention first', async () => {
  const { barLayout } = await loadPlugin()
  const entries = [
    { code: 'claude', value: '42%', used_pct: 42, attention: false },
    { code: 'zai', value: '91%', used_pct: 91, attention: true }
  ]
  assert.deepEqual(barLayout(entries, false, null), { mode: 'full', text: 'zai 91% · claude 42%' })
})

test('barLayout drops the percent at 4 to 6 entries', async () => {
  const { barLayout } = await loadPlugin()
  const entries = [
    { code: 'a', value: '1%', used_pct: 1, attention: false },
    { code: 'b', value: '2%', used_pct: 2, attention: false },
    { code: 'c', value: '$3.00', used_pct: 3, attention: false },
    { code: 'd', value: '4%', used_pct: 4, attention: false }
  ]
  assert.deepEqual(barLayout(entries, false, null), { mode: 'bare', text: 'a 1 · b 2 · c $3.00 · d 4' })
})

test('barLayout switches to meters at 7 or more', async () => {
  const { barLayout } = await loadPlugin()
  const entries = []
  for (let i = 0; i < 7; i++) {
    entries.push({ code: 'p' + i, value: i + '%', used_pct: i === 3 ? null : i, attention: i === 5 })
  }
  const out = barLayout(entries, false, null)
  assert.equal(out.mode, 'meters')
  assert.equal(out.meters.length, 7)
  assert.deepEqual(out.meters[0], { code: 'p5', height: 5 })
  assert.equal(out.meters[4].height, 30)
  assert.equal(out.summary, 'p5 5%')
  assert.equal(out.pinned, '7 pinned')
  assert.equal(barLayout(entries, true, null).pinned, '')
})

test('barLayout in meters mode says all ok when nothing needs attention', async () => {
  const { barLayout } = await loadPlugin()
  const entries = []
  for (let i = 0; i < 7; i++) {
    entries.push({ code: 'p' + i, value: i + '%', used_pct: i, attention: false })
  }
  const out = barLayout(entries, false, null)
  assert.equal(out.mode, 'meters')
  assert.equal(out.summary, 'all ok')
})

test('barLayout steps down while the text is too wide', async () => {
  const { barLayout } = await loadPlugin()
  const entries = [
    { code: 'claude', value: '42%', used_pct: 42, attention: false },
    { code: 'zai', value: '91%', used_pct: 91, attention: false }
  ]
  const full = 'zai 91% · claude 42%'
  assert.equal(barLayout(entries, false, full.length * 6.5).mode, 'full')
  assert.equal(barLayout(entries, false, full.length * 6.5 - 1).mode, 'bare')
  const bare = 'zai 91 · claude 42'
  assert.equal(barLayout(entries, false, bare.length * 6.5 - 1).mode, 'meters')
  assert.equal(barLayout(entries, false, 0).mode, 'meters')
})

test('barLayout returns none with no entries', async () => {
  const { barLayout } = await loadPlugin()
  assert.deepEqual(barLayout([], false, null), { mode: 'none' })
  assert.deepEqual(barLayout(null, false, 100), { mode: 'none' })
})

test('barLayout handles a ten provider bar', async () => {
  const { barLayout } = await loadPlugin()
  const entries = []
  for (let i = 0; i < 10; i++) {
    entries.push({
      code: 'p' + i,
      value: i + '%',
      used_pct: i * 10,
      attention: i === 9
    })
  }
  const out = barLayout(entries, false, null)
  assert.equal(out.mode, 'meters')
  assert.equal(out.meters.length, 10)
  assert.equal(out.meters[0].code, 'p9')
  assert.equal(out.meters[0].height, 90)
  assert.equal(out.summary, 'p9 9%')
  assert.equal(out.pinned, '10 pinned')
})

test('tipEntries lists one line per bar provider in bar order', async () => {
  const { tipEntries } = await loadPlugin()
  const entries = [
    { code: 'a', name: 'Alpha', label: '5h', value: '1%', used_pct: 1, attention: false },
    { code: 'b', name: 'Beta', label: 'Weekly', value: '99%', used_pct: 99, attention: true }
  ]
  assert.deepEqual(tipEntries(entries), [
    { name: 'Beta', label: 'Weekly', value: '99%', attention: true },
    { name: 'Alpha', label: '5h', value: '1%', attention: false }
  ])
})

/* A hand-built v0.3.1-shaped payload: rows have no key and no used_pct. */
const OLD_PAYLOAD = {
  fetched_at: '2026-11-07T18:00:00Z',
  providers: [
    {
      id: 'anthropic',
      status: 'ok',
      name: 'Anthropic',
      tag: 'Max',
      code: 'claude',
      windows: [
        {
          label: '5h',
          percent: 42,
          resets_at: '2026-11-07T20:00:00Z',
          status: 'ok',
          scope: 'account'
        }
      ],
      money: [{ label: 'Balance', left: 12.5, cur: 'USD', total: 20 }]
    }
  ]
}

test('staleBackend treats the old v0.3.1 payload as stale', async () => {
  const { staleBackend } = await loadPlugin()
  assert.equal(staleBackend(OLD_PAYLOAD), true)
})

test('staleBackend accepts the current payload', async () => {
  const { readFile } = await import('node:fs/promises')
  const current = JSON.parse(await readFile(new URL('./payload.json', import.meta.url), 'utf8'))
  const { staleBackend } = await loadPlugin()
  assert.equal(staleBackend(current), false)
})

test('staleBackend accepts a money row with a null used_pct', async () => {
  const { staleBackend } = await loadPlugin()
  const data = {
    providers: [
      {
        id: 'openrouter',
        status: 'ok',
        name: 'OpenRouter',
        tag: 'Credits',
        code: 'openrouter',
        money: [
          {
            label: 'Balance',
            left: 5,
            cur: 'USD',
            key: 'money:balance:usd',
            kind: 'money',
            used_pct: null,
            warn: false,
            actionable_eta: null
          }
        ]
      }
    ]
  }
  assert.equal(staleBackend(data), false)
})

test('staleBackend is false without data, on error and on an empty list', async () => {
  const { staleBackend } = await loadPlugin()
  assert.equal(staleBackend(null), false)
  assert.equal(staleBackend({ providers: [] }), false)
  assert.equal(
    staleBackend({ providers: [{ id: 'x', status: 'error', name: 'X', tag: 'T', code: 'x' }] }),
    false
  )
})

test('checkAlerts fires nothing on a stale payload', async () => {
  const plugin = await loadPlugin()
  const { ctx, data, notices } = fakeContext()
  plugin.default.register(ctx)
  plugin.checkAlerts(OLD_PAYLOAD)
  assert.equal(notices.length, 0)
  assert.equal('alerts' in data, false)
})

const CURRENT_WINDOW = {
  label: '5h',
  key: '5h',
  kind: 'window',
  used_pct: 95,
  warn: true,
  actionable_eta: null,
  resets_at: '2099-01-01T00:00:00Z'
}

test('checkAlerts does not fire on a stale payload that would otherwise alert', async () => {
  const plugin = await loadPlugin()
  const { ctx, notices } = fakeContext()
  plugin.default.register(ctx)
  const staleRow = {
    label: 'Weekly',
    percent: 50,
    resets_at: '2099-01-02T00:00:00Z',
    status: 'ok',
    scope: 'account'
  }
  const data = {
    providers: [
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [CURRENT_WINDOW, staleRow]
      }
    ]
  }
  plugin.checkAlerts(data)
  assert.equal(notices.length, 0)
})

test('the same alert payload without the stale row notifies', async () => {
  const plugin = await loadPlugin()
  const { ctx, notices } = fakeContext()
  plugin.default.register(ctx)
  const data = {
    providers: [
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [CURRENT_WINDOW]
      }
    ]
  }
  plugin.checkAlerts(data)
  assert.equal(notices.length, 1)
  assert.match(notices[0].title, /Anthropic: 5h at 95% used/)
})

test('staleBackend checks money rows too', async () => {
  const { staleBackend } = await loadPlugin()
  const data = {
    providers: [
      {
        id: 'openrouter',
        status: 'ok',
        name: 'OpenRouter',
        tag: 'Credits',
        code: 'openrouter',
        windows: [{ ...CURRENT_WINDOW, used_pct: 10, warn: false }],
        money: [
          {
            label: 'Balance',
            left: 5,
            cur: 'USD',
            total: 20,
            kind: 'money',
            used_pct: 75,
            warn: false,
            actionable_eta: null
          }
        ]
      }
    ]
  }
  assert.equal(staleBackend(data), true)
})

test('staleBackend ignores non-ok providers', async () => {
  const { staleBackend } = await loadPlugin()
  const data = {
    providers: [
      {
        id: 'broken',
        status: 'error',
        name: 'Broken',
        tag: 'Plan',
        code: 'broken',
        windows: [{ label: '5h', used_pct: 40, resets_at: '2099-01-01T00:00:00Z' }]
      },
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [CURRENT_WINDOW]
      }
    ]
  }
  assert.equal(staleBackend(data), false)
})

test('staleBackend requires used_pct as well as key', async () => {
  const { staleBackend } = await loadPlugin()
  const data = {
    providers: [
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [{ label: '5h', key: '5h', kind: 'window', warn: true, resets_at: '2099-01-01T00:00:00Z' }]
      }
    ]
  }
  assert.equal(staleBackend(data), true)
})

test('staleBackend requires key as well as used_pct', async () => {
  const { staleBackend } = await loadPlugin()
  const data = {
    providers: [
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [{ label: '5h', kind: 'window', used_pct: 10, warn: false, resets_at: '2099-01-01T00:00:00Z' }]
      }
    ]
  }
  assert.equal(staleBackend(data), true)
})

function alertData() {
  return {
    providers: [
      {
        id: 'anthropic',
        status: 'ok',
        name: 'Anthropic',
        tag: 'Max',
        code: 'claude',
        windows: [CURRENT_WINDOW]
      }
    ]
  }
}

test('checkAlerts survives a storage read failure', async () => {
  const plugin = await loadPlugin()
  const ctx = {
    storage: {
      get() {
        throw new Error('storage broken')
      },
      set() {}
    },
    os: { notify() {} },
    rest: () => {},
    register() {}
  }
  plugin.default.register(ctx)
  assert.doesNotThrow(() => plugin.checkAlerts(alertData()))
})

test('checkAlerts survives a notification that throws', async () => {
  const plugin = await loadPlugin()
  const seen = {}
  const ctx = {
    storage: {
      get: (key, fallback) => (key in seen ? seen[key] : fallback),
      set: (key, value) => {
        seen[key] = value
      }
    },
    os: {
      notify() {
        throw new Error('no notification')
      }
    },
    rest: () => {},
    register() {}
  }
  plugin.default.register(ctx)
  assert.doesNotThrow(() => plugin.checkAlerts(alertData()))
  assert.equal(Object.keys(seen).length, 1)
})

/* ---------- compact controls and mock layout ---------- */

test('miniSegments exposes group semantics, selection and onChange', async () => {
  const { miniSegments } = await loadPlugin()
  const picks = []
  const node = miniSegments({
    options: [{ id: 'all', label: 'All' }, { id: 'pinned', label: 'Pinned' }],
    value: 'pinned',
    onChange: id => picks.push(id),
    label: 'Provider view'
  })
  assert.equal(node.props.role, 'group')
  assert.equal(node.props['aria-label'], 'Provider view')
  const buttons = findNodes(node, n => n.type === 'button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props['aria-pressed'], false)
  assert.equal(buttons[1].props['aria-pressed'], true)
  assert.equal(buttons[0].props.style.padding, '3px 8px')
  buttons[0].props.onClick()
  assert.deepEqual(picks, ['all'])

  const tabs = miniSegments({
    options: [{ id: '5h', label: '5h', dot: true }, { id: 'weekly', label: 'Weekly' }],
    value: '5h',
    onChange: () => {},
    label: 'Quotas',
    tabs: true
  })
  assert.equal(tabs.props.role, 'tablist')
  const tabButtons = findNodes(tabs, n => n.type === 'button')
  assert.equal(tabButtons[0].props.role, 'tab')
  assert.equal(tabButtons[0].props['aria-selected'], true)
  assert.equal(tabButtons[0].props['aria-pressed'], undefined)
  assert.equal(findNodes(tabs, n => n.props && n.props.style && n.props.style.background === ACCENT_COLOR).length, 1)

  const interval = miniSegments({
    options: [{ id: '30000', label: '30s' }],
    value: '30000',
    onChange: () => {},
    label: 'Refresh interval',
    interval: true
  })
  const intervalButton = findNodes(interval, n => n.type === 'button')[0]
  assert.equal(intervalButton.props.style.padding, '3px 7px')
  assert.equal(intervalButton.props.style.fontSize, 10.5)
})

test('the popover uses no SDK segmented or tab components', async () => {
  const { renderComponent } = await import('./render.mjs')
  const data = { providers: [okProvider('anthropic', 'Anthropic', 'anthropic', 42, false)] }
  const view = await renderComponent('UsagePanel', { data })
  assert.equal(view.calls.includes('SegmentedControl'), false)
  assert.equal(view.calls.includes('Tabs'), false)
  assert.equal(view.calls.includes('TabsList'), false)
  assert.equal(view.calls.includes('TabsTrigger'), false)
})

test('UsagePanel keeps the alert choice collapsed until the alert button opens it', async () => {
  const { renderComponent } = await import('./render.mjs')
  const data = { providers: [okProvider('anthropic', 'Anthropic', 'anthropic', 42, false)] }
  const closed = await renderComponent('UsagePanel', {
    data,
    state: { 1: 'anthropic' }
  })
  assert.equal(closed.joined.includes('Notifications appear while Hermes is in the background.'), false)
  const closedButton = findNodes(
    closed.rendered,
    n => n.type === 'button' && nodeText(n) === 'Alert at 80%'
  )
  assert.equal(closedButton.length, 1)
  assert.equal(closedButton[0].props['aria-expanded'], false)

  const open = await renderComponent('UsagePanel', {
    data,
    state: { 1: 'anthropic', 3: 'anthropic' }
  })
  assert.ok(open.joined.includes('Notifications appear while Hermes is in the background.'))
  const steps = findNodes(open.rendered, n => n.type === 'button')
    .map(nodeText)
    .filter(text => ['50', '70', '80', '90', '95', 'Off'].includes(text))
  assert.deepEqual(steps, ['50', '70', '80', '90', '95', 'Off'])
})

test('statsFor derives burn, at reset and pace from a monthly window', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 35,
    duration_seconds: 30 * 86400,
    resets_at: new Date(now + 28 * 86400 * 1000).toISOString()
  }
  assert.deepEqual(statsFor(row, now), [
    { label: 'Burn', value: '17.5%/d' },
    { label: 'At reset', value: 'runs out', warn: true },
    { label: 'Pace', value: '5.3×' }
  ])
  const missingDuration = statsFor({ kind: 'window', used_pct: 35, resets_at: row.resets_at }, now)
  assert.deepEqual(missingDuration.map(s => s.value), ['-', '-', '-'])
  const noElapsed = statsFor(
    { kind: 'window', used_pct: 35, duration_seconds: 30 * 86400, resets_at: new Date(now + 30 * 86400 * 1000).toISOString() },
    now
  )
  assert.deepEqual(noElapsed.map(s => s.value), ['-', '-', '-'])
})

test('statsFor uses per hour at seven days and per day only above seven days', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const weekly = statsFor(
    {
      kind: 'window',
      used_pct: 10,
      duration_seconds: 604800,
      resets_at: new Date(now + 6 * 86400 * 1000).toISOString()
    },
    now
  )
  assert.equal(weekly[0].value, '0.4%/h')
  const monthly = statsFor(
    {
      kind: 'window',
      used_pct: 35,
      duration_seconds: 30 * 86400,
      resets_at: new Date(now + 28 * 86400 * 1000).toISOString()
    },
    now
  )
  assert.equal(monthly[0].value, '17.5%/d')
})

test('statsFor keeps the measured rate ahead of the derived pace', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 50,
    duration_seconds: 10 * 3600,
    resets_at: new Date(now + 8 * 3600 * 1000).toISOString(),
    eta_seconds: 10 * 3600
  }
  assert.equal(statsFor(row, now)[0].value, '5.0%/h')
})

test('derivedRate rejects money rows and a window with no elapsed time', async () => {
  const { derivedRate, statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const money = {
    kind: 'money',
    used_pct: 80,
    duration_seconds: 30 * 86400,
    resets_at: new Date(now + 28 * 86400 * 1000).toISOString()
  }
  assert.equal(derivedRate(money, now), null)
  const noElapsed = {
    kind: 'window',
    used_pct: 10,
    duration_seconds: 5 * 3600,
    resets_at: new Date(now + 5 * 3600 * 1000 + 1000).toISOString()
  }
  assert.equal(derivedRate(noElapsed, now), null)
  assert.deepEqual(statsFor(noElapsed, now).map(s => s.value), ['-', '-', '-'])
})

test('chartModel draws a no-history window line and leaves money without one', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-01T00:00:00Z')
  const row = {
    kind: 'window',
    used_pct: 35,
    duration_seconds: 30 * 86400,
    resets_at: new Date(now + 28 * 86400 * 1000).toISOString()
  }
  const model = chartModel(row, now)
  assert.equal(model.average, true)
  assert.equal(model.series.length, 2)
  assert.equal(model.series[0][0], 0)
  assert.equal(model.series[1][0], 22.4)
  assert.equal(model.nowX, 22.4)
  assert.ok(model.series[0][1] > model.series[1][1])
  assert.ok(model.projection !== null)
  assert.equal(model.rate, 35 / (2 * 86400))
  const zero = chartModel({ ...row, used_pct: 0 }, now)
  const fiveHour = chartModel(
    {
      kind: 'window',
      used_pct: 10,
      duration_seconds: 5 * 3600,
      resets_at: new Date(now + 4 * 3600 * 1000).toISOString()
    },
    now
  )
  assert.equal(fiveHour.series[0][0], 0)
  assert.equal(fiveHour.series[0][1], zero.current[1])
  assert.equal(fiveHour.series[1][0], 67.2)
  assert.equal(fiveHour.current[0], 67.2)
  assert.equal(fiveHour.nowX, 67.2)
  assert.equal(fiveHour.series[1][1], fiveHour.current[1])
  const { expandedPanel } = await loadPlugin()
  const windowPanel = expandedPanel(
    { id: 'z', name: 'Z', status: 'ok', windows: [{ ...row, key: 'monthly', label: 'Monthly' }] },
    { mode: 'used', choice: {}, barIds: [], tab: 'monthly', now }
  )
  assert.equal(findNodes(windowPanel, n => n.type === 'polyline' && n.props.key === 'history').length, 1)
  const money = chartModel(
    { kind: 'money', used_pct: 80, left: 2, total: 10, cur: 'USD' },
    now
  )
  assert.equal(money.average, false)
  assert.equal(money.series.length, 1)
  const moneyPanel = expandedPanel(
    { id: 'or', name: 'OpenRouter', status: 'ok', money: [{ key: 'money:balance:usd', label: 'Balance', kind: 'money', used_pct: 80, left: 2, total: 10, cur: 'USD' }] },
    { mode: 'used', choice: {}, barIds: [], tab: 'money:balance:usd', now }
  )
  assert.equal(findNodes(moneyPanel, n => n.type === 'polyline' && n.props.key === 'history').length, 0)
})

test('tipBody carries the quota label, a 4x10 swatch and the updated footer', async () => {
  const { tipBody } = await loadPlugin()
  const body = tipBody(
    [{ name: 'Anthropic', label: '5h', value: '42%', attention: false }],
    '04:14 AM'
  )
  const text = nodeText(body)
  assert.ok(text.includes('Anthropic'))
  assert.ok(text.includes('5h'))
  assert.ok(text.includes('42%'))
  assert.ok(text.includes('Click to open · updated 04:14 AM'))
  const swatches = findNodes(
    body,
    n => n.type === 'span' && n.props && n.props.style && n.props.style.width === 4 && n.props.style.height === 10
  )
  assert.equal(swatches.length, 1)
})

test('the footer keeps auto refresh and the value control on one row', async () => {
  const { renderComponent } = await import('./render.mjs')
  const data = { providers: [okProvider('anthropic', 'Anthropic', 'anthropic', 42, false)] }
  const view = await renderComponent('UsagePanel', { data })
  const foot = findNodes(
    view.rendered,
    n => n.type === 'div' && n.props && n.props.style && n.props.style.padding === '9px 14px'
  )
  assert.equal(foot.length, 1)
  assert.equal(foot[0].props.style.display, 'flex')
  assert.equal(foot[0].props.style.gap, 8)
  assert.ok(nodeText(foot[0]).includes('auto refresh'))
  const mode = findNodes(foot[0], n => n.type === 'span' && n.props && n.props.style && n.props.style.marginLeft === 'auto')
  assert.equal(mode.length, 1)
})
