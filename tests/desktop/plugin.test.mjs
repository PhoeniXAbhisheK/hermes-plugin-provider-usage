import test from 'node:test'
import assert from 'node:assert/strict'

import { loadPlugin } from './load-plugin.mjs'

const NOW = 1_700_000_000_000

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

test('code maps known ids and returns unknown ones as is', async () => {
  const { code } = await loadPlugin()
  assert.equal(code({ id: 'opencode-go' }), 'opencode')
  assert.equal(code({ id: 'zai' }), 'zai')
  assert.equal(code({ id: 'unknown' }), 'unknown')
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

test('capUsedPercent clamps and returns zero without a total', async () => {
  const { capUsedPercent } = await loadPlugin()
  assert.equal(capUsedPercent({ total: 100, left: 40 }), 60)
  assert.equal(capUsedPercent({ total: 0, left: 5 }), 0)
  assert.equal(capUsedPercent({}), 0)
  assert.equal(capUsedPercent({ total: 100, left: 120 }), 0)
  assert.equal(capUsedPercent({ total: 100, left: -20 }), 100)
})

test('providerWarn follows the backend warn flag', async () => {
  const { providerWarn } = await loadPlugin()
  assert.equal(
    providerWarn({ status: 'ok', windows: [{ percent: 95, used_pct: 95, warn: false }] }),
    false
  )
  assert.equal(
    providerWarn({ status: 'ok', windows: [{ percent: 10, used_pct: 10, warn: true }] }),
    true
  )
  assert.equal(
    providerWarn({
      status: 'ok',
      money: [{ key: 'money:balance:usd', total: 100, left: 5, used_pct: 95, warn: false }]
    }),
    false
  )
  assert.equal(providerWarn({ status: 'error', windows: [{ percent: 99, warn: true }] }), false)
})

test('rowView renders windows in both modes', async () => {
  const { rowView } = await loadPlugin()
  const row = { key: '5h', label: '5h', kind: 'window', percent: 42, used_pct: 42, actionable_eta: 7200 }
  assert.deepEqual(rowView(row, 'used'), {
    label: '5h',
    value: '42%',
    totalText: '',
    shown: 42,
    width: 42,
    eta: 7200
  })
  const rest = rowView(row, 'remaining')
  assert.equal(rest.value, '58%')
  assert.equal(rest.width, 58)
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
  assert.equal(used.width, 37.5)
  const rest = rowView(balance, 'remaining')
  assert.equal(rest.label, 'Balance')
  assert.equal(rest.value, '$12.50')
  assert.equal(rest.width, 62.5)
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
  assert.equal(noTotal.width, 0)
  const noTotalRest = rowView(
    { key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null },
    'remaining'
  )
  assert.equal(noTotalRest.value, '$7.00')
  assert.equal(noTotalRest.width, 0)
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

test('summary picks the shortest account window and the key cap', async () => {
  const { summary } = await loadPlugin()
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
  assert.equal(summary(cap, 'used'), '$6.00')
  assert.equal(summary(cap, 'remaining'), '$4.00')
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
  assert.equal(summary(noCap, 'used'), '$6.00')
  const noTotal = {
    status: 'ok',
    money: [
      { key: 'money:balance:usd', label: 'Balance', kind: 'money', left: 7, cur: 'USD', used_pct: null }
    ]
  }
  assert.equal(summary(noTotal, 'used'), '$7.00')
  assert.equal(summary(noTotal, 'remaining'), '$7.00')
  const windows = {
    status: 'ok',
    windows: [
      { key: 'weekly', label: 'Weekly', percent: 10, used_pct: 10, scope: 'account', duration_seconds: 604800 },
      { key: '5h', label: '5h', percent: 20, used_pct: 20, scope: 'account', duration_seconds: 18000 }
    ]
  }
  assert.equal(summary(windows, 'used'), '20%')
  assert.equal(summary(windows, 'remaining'), '80%')
  const modelShorter = {
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', percent: 10, used_pct: 10, scope: 'account', duration_seconds: 18000 },
      { key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model', duration_seconds: 3600 }
    ]
  }
  assert.equal(summary(modelShorter, 'used'), '10%')
  const noDurations = {
    status: 'ok',
    windows: [
      { key: 'first', label: 'First', percent: 30, used_pct: 30, scope: 'account' },
      { key: 'second', label: 'Second', percent: 60, used_pct: 60, scope: 'account' }
    ]
  }
  assert.equal(summary(noDurations, 'used'), '30%')
  assert.equal(
    summary({ status: 'ok', windows: [{ key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model' }] }, 'used'),
    '-'
  )
  assert.equal(summary({ status: 'ok' }, 'used'), '-')
  assert.equal(summary({ status: 'error' }, 'used'), '-')
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
  assert.equal(summary(capSecond, 'used'), '$6.00')
})

test('tipLine uses the actionable eta and the row keys', async () => {
  const { tipLine } = await loadPlugin()
  const windows = {
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', percent: 20, used_pct: 20, actionable_eta: 5400 },
      { key: 'weekly', label: 'Weekly', percent: 20, used_pct: 20, eta_seconds: 5400, actionable_eta: null }
    ]
  }
  assert.equal(tipLine(windows, 'used'), '5h 20% (~1h) · Weekly 20%')
  assert.equal(tipLine(windows, 'remaining'), '5h 80% (~1h) · Weekly 80%')
  const moneyRows = {
    status: 'ok',
    money: [
      {
        key: 'money:balance:usd',
        label: 'Balance',
        kind: 'money',
        total: 10,
        left: 4,
        cur: 'USD',
        used_pct: 60,
        actionable_eta: 5400
      },
      {
        key: 'money:key_cap:usd',
        label: 'Key cap',
        kind: 'money',
        total: 10,
        left: 4,
        cur: 'USD',
        used_pct: 60,
        actionable_eta: null
      }
    ]
  }
  assert.equal(tipLine(moneyRows, 'used'), 'Spent $6.00/$10.00 (~1h) · Cap used $6.00/$10.00')
  assert.equal(tipLine(moneyRows, 'remaining'), 'Balance $4.00/$10.00 (~1h) · Key cap $4.00/$10.00')
  assert.equal(tipLine({ status: 'error' }, 'used'), 'unavailable')
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
            { key: '5h', label: '5h', percent: 80, used_pct: 80, warn: true, resets_at: resetsAt }
          ]
        }
      ]
    }
    checkAlerts(payload)
    assert.deepEqual(notices, [{ title: 'Zai: 5h at 80% used', body: 'resets in 30m' }])
    assert.deepEqual(Object.keys(data.alerts), ['zai:5h:' + resetsAt])
    assert.equal(data.alerts['zai:5h:' + resetsAt], NOW)
    checkAlerts(payload)
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('a moved reset inside the tolerance does not fire again', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    const first = isoAt(NOW + 30 * 60000)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 80, warn: true, resets_at: first }]
        }
      ]
    })
    const moved = isoAt(NOW + 30 * 60000 + 60000)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 80, warn: true, resets_at: moved }]
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

test('a fractional used_pct rounds in the title', async () => {
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
              used_pct: 80.6,
              warn: true,
              resets_at: isoAt(NOW + 30 * 60000)
            }
          ]
        }
      ]
    })
    assert.equal(notices.length, 1)
    assert.equal(notices[0].title, 'Zai: 5h at 81% used')
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

test('a row without actionable_eta shows no eta', async () => {
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
              eta_seconds: 5400,
              actionable_eta: null,
              resets_at: isoAt(NOW + 30 * 60000)
            }
          ]
        }
      ]
    })
    assert.equal(notices[0].body, 'resets in 30m')
  } finally {
    restore()
  }
})

test('a label change under the same key does not fire again', async () => {
  const restore = frozen(NOW)
  try {
    const { checkAlerts, default: plugin } = await loadPlugin()
    const { ctx, notices } = fakeContext()
    plugin.register(ctx)
    const resetsAt = isoAt(NOW + 30 * 60000)
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: '5h', used_pct: 80, warn: true, resets_at: resetsAt }]
        }
      ]
    })
    checkAlerts({
      providers: [
        {
          id: 'zai',
          name: 'Zai',
          status: 'ok',
          windows: [{ key: '5h', label: 'Session', used_pct: 80, warn: true, resets_at: resetsAt }]
        }
      ]
    })
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('checkAlerts fires on row.warn, not on the percentage', async () => {
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
              key: 'quiet',
              label: 'Quiet',
              used_pct: 95,
              warn: false,
              resets_at: isoAt(NOW + 30 * 60000)
            },
            {
              key: 'loud',
              label: 'Loud',
              used_pct: 10,
              warn: true,
              resets_at: isoAt(NOW + 30 * 60000)
            }
          ]
        }
      ]
    })
    assert.equal(notices.length, 1)
    assert.equal(notices[0].title, 'Zai: Loud at 10% used')
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
  const amber = findNodes(barContent(followed), n => n.props && n.props.className === 'text-amber-600')
  assert.equal(amber.length, 1)
  assert.equal(nodeText(amber[0]), 'claude 95%')
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
  const amber = findNodes(barContent(model), n => n.props && n.props.className === 'text-amber-600')
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
  assert.equal(findNodes(content, n => n.props && n.props.className === 'bg-amber-600').length, 1)
  assert.equal(findNodes(content, n => n.props && n.props.className === 'bg-(--ui-accent)').length, 6)
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
  const amber = findNodes(node, n => n.props && n.props.className === 'text-amber-600')
  assert.equal(amber.length, 1)
  assert.equal(nodeText(amber[0]), '95%')
})

test('tipBody explains the empty bar', async () => {
  const { tipBody } = await loadPlugin()
  const node = tipBody([], '09:41')
  assert.ok(nodeText(node).includes('Pin a provider, or open a chat that uses one'))
  assert.ok(nodeText(node).includes('Click to open · updated 09:41'))
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
  assert.equal(findNodes(off, n => n.props && n.props.className === 'bg-(--ui-accent)' && n.props.style && n.props.style.borderRadius === '50%').length, 1)
  const noDot = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  assert.equal(findNodes(noDot, n => n.props && n.props.className === 'bg-(--ui-accent)' && n.props.style && n.props.style.borderRadius === '50%').length, 0)
})

test('providerRowElement shows +N more and expands on request', async () => {
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
  const collapsed = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: false })
  const more = findNodes(collapsed, n => n.type === 'button' && nodeText(n) === '+1 more')
  assert.equal(more.length, 1)
  assert.equal(nodeText(collapsed).includes('D'), false)
  const expanded = providerRowElement(p, { mode: 'used', pins: [], barIds: [], expanded: true })
  assert.equal(findNodes(expanded, n => n.type === 'button' && nodeText(n) === 'Show less').length, 1)
  assert.equal(nodeText(expanded).includes('D'), true)
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
  assert.equal(loudValue[0].props.className, 'text-amber-600')
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
  assert.equal(quietValue[0].props.className, undefined)
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
  assert.equal(attention.props.className, 'text-amber-600')
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

test('desktop/plugin.js no longer ships an eye icon', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../desktop/plugin.js', import.meta.url), 'utf8')
  assert.equal(/EyeIcon|EYE_PATH/.test(source), false)
})

test('a real payload shape drives the bar, the tip and the warn flag', async () => {
  const { readFile } = await import('node:fs/promises')
  const payload = JSON.parse(await readFile(new URL('./payload.json', import.meta.url), 'utf8'))
  const { summary, tipLine, providerWarn } = await loadPlugin()
  const [anthropic, openrouter] = payload.providers
  assert.equal(summary(anthropic, 'used'), '42%')
  assert.equal(summary(anthropic, 'remaining'), '58%')
  assert.equal(summary(openrouter, 'used'), '$8.00')
  assert.equal(summary(openrouter, 'remaining'), '$2.00')
  assert.equal(tipLine(anthropic, 'used'), '5h 42% (~2h) · Weekly 88% · Opus 95%')
  assert.equal(
    tipLine(openrouter, 'used'),
    'Spent $7.50/$20.00 · Cap used $8.00/$10.00 (~1h)'
  )
  assert.equal(providerWarn(anthropic), true)
  assert.equal(providerWarn(openrouter), true)
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

test('barQuotaKey matches summary', async () => {
  const { barQuotaKey, summary } = await loadPlugin()
  const money = {
    status: 'ok',
    money: [
      { key: 'money:balance:usd', kind: 'money', total: 10, left: 9, cur: 'USD', used_pct: 10 },
      { key: 'money:key_cap:usd', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 }
    ]
  }
  assert.equal(barQuotaKey(money), 'money:key_cap:usd')
  assert.equal(summary(money, 'used'), '$8.00')
  const windows = {
    status: 'ok',
    windows: [
      { key: 'weekly', scope: 'account', duration_seconds: 604800, used_pct: 10 },
      { key: '5h', scope: 'account', duration_seconds: 18000, used_pct: 20 },
      { key: 'opus', scope: 'model', duration_seconds: 1800, used_pct: 99 }
    ]
  }
  assert.equal(barQuotaKey(windows), '5h')
  assert.equal(summary(windows, 'used'), '20%')
  const plain = { status: 'ok', windows: [{ key: 'weekly', scope: 'account', used_pct: 10 }] }
  assert.equal(barQuotaKey(plain), 'weekly')
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
