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

test('summary shows the highest used quota across windows and money', async () => {
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
  const modelHigher = {
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', percent: 10, used_pct: 10, scope: 'account', duration_seconds: 18000 },
      { key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model', duration_seconds: 3600 }
    ]
  }
  assert.equal(summary(modelHigher, 'used'), '90%')
  const noDurations = {
    status: 'ok',
    windows: [
      { key: 'first', label: 'First', percent: 30, used_pct: 30, scope: 'account' },
      { key: 'second', label: 'Second', percent: 60, used_pct: 60, scope: 'account' }
    ]
  }
  assert.equal(summary(noDurations, 'used'), '60%')
  assert.equal(
    summary({ status: 'ok', windows: [{ key: 'opus:weekly', label: 'Opus', percent: 90, used_pct: 90, scope: 'model' }] }, 'used'),
    '90%'
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
  assert.equal(summary(capSecond, 'remaining'), '$4.00')
  assert.equal(summary(capSecond, 'used', { zai: 'money:balance:usd' }), '$6.00')
})

test('summary follows a chosen bar quota', async () => {
  const { summary } = await loadPlugin()
  const p = {
    id: 'zai',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', used_pct: 20, scope: 'account', duration_seconds: 18000 },
      { key: 'weekly', label: 'Weekly', used_pct: 40, scope: 'account', duration_seconds: 604800 }
    ]
  }
  assert.equal(summary(p, 'used'), '40%')
  assert.equal(summary(p, 'used', { zai: '5h' }), '20%')
  assert.equal(summary(p, 'remaining', { zai: '5h' }), '80%')
  assert.equal(summary(p, 'used', { zai: 'gone' }), '40%')
  assert.equal(summary(p, 'used', { other: '5h' }), '40%')
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
  assert.equal(findNodes(collapsed, n => typeof n.type === 'function' && n.type.name === 'Tabs').length, 0)
  const open = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: true })
  assert.equal(findNodes(open, n => typeof n.type === 'function' && n.type.name === 'Tabs').length, 1)
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

/* ---------- detail chart and expanded row ---------- */

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

test('statsFor reads a window and a money row', async () => {
  const { statsFor } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const window = {
    kind: 'window',
    used_pct: 40,
    eta_seconds: 3600,
    resets_at: new Date(now + 1800 * 1000).toISOString()
  }
  assert.deepEqual(statsFor(window, now), [
    { label: 'Burn', value: '60.0%/h' },
    { label: 'At reset', value: '~70%', warn: false },
    { label: 'Pace', value: '0.7×' }
  ])
  const over = {
    kind: 'window',
    used_pct: 90,
    eta_seconds: 3600,
    resets_at: new Date(now + 7200 * 1000).toISOString()
  }
  const overStats = statsFor(over, now)
  assert.equal(overStats[1].value, 'runs out')
  assert.equal(overStats[1].warn, true)
  const noEta = statsFor({ kind: 'window', used_pct: 55 }, now)
  assert.deepEqual(noEta, [
    { label: 'Burn', value: '-' },
    { label: 'At reset', value: '-', warn: false },
    { label: 'Pace', value: '-' }
  ])
  const money = statsFor(
    { kind: 'money', total: 100, left: 20, cur: 'USD', used_pct: 80, depletes_in_seconds: 86400 },
    now
  )
  assert.deepEqual(money, [
    { label: 'Spend', value: '$20.00/d' },
    { label: 'Lasts', value: '~24h' },
    { label: 'Used', value: '80%' }
  ])
  assert.deepEqual(statsFor({ kind: 'money', used_pct: null, left: 5, cur: 'USD' }, now), [
    { label: 'Spend', value: '-' },
    { label: 'Lasts', value: '-' },
    { label: 'Used', value: '-' }
  ])
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
  const tabs = findNodes(panel, n => typeof n.type === 'function' && n.type.name === 'Tabs')
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].props.value, 'weekly')
  const triggers = findNodes(panel, n => typeof n.type === 'function' && n.type.name === 'TabsTrigger')
  assert.equal(triggers.length, 3)
  assert.deepEqual(triggers.map(t => t.props.value), ['5h', 'weekly', 'monthly'])
  assert.equal(nodeText(panel).includes('Shown in status bar'), true)
  const plus = findNodes(
    panel,
    n => n.props && n.props.className === 'bg-(--ui-accent)' && n.props.style && n.props.style.borderRadius === '50%'
  )
  assert.equal(plus.length, 1)
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

test('the provider name button carries aria-expanded and the chevron', async () => {
  const { providerRowElement } = await loadPlugin()
  const p = { id: 'zai', name: 'Zai', tag: 'Pro', status: 'ok', windows: [{ key: '5h', label: '5h', used_pct: 20 }] }
  const closed = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: false })
  const closedButton = findNodes(closed, n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(closedButton.length, 1)
  assert.equal(closedButton[0].props['aria-expanded'], false)
  const closedChevron = findNodes(closedButton[0], n => n.type === 'svg' && n.props.style)
  assert.equal(closedChevron[0].props.style.transform, 'none')
  const open = providerRowElement(p, { mode: 'used', pins: [], barIds: [], open: true })
  const openButton = findNodes(open, n => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(openButton[0].props['aria-expanded'], true)
  const openChevron = findNodes(openButton[0], n => n.type === 'svg' && n.props.style)
  assert.equal(openChevron[0].props.style.transform, 'rotate(90deg)')
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
    findNodes(cell, n => n.props && n.props.className === 'bg-(--ui-accent)' && n.props.style && n.props.style.borderRadius === '50%').length
  )
  assert.equal(dotOn.length, 1)
  assert.ok(nodeText(dotOn[0]).includes('5h'))
})

test('a zero eta yields no rate and a dash for burn', async () => {
  const { statsFor } = await loadPlugin()
  const stats = statsFor({ kind: 'window', used_pct: 40, eta_seconds: 0 })
  assert.deepEqual(stats, [
    { label: 'Burn', value: '-' },
    { label: 'At reset', value: '-', warn: false },
    { label: 'Pace', value: '-' }
  ])
})

test('chartModel clamps history values to the chart height', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      history: [
        [now / 1000 - 3600, 150],
        [now / 1000 - 1800, -20],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(m.series.length, 3)
  assert.equal(m.series[0][1], 2)
  assert.equal(m.series[1][1], 66)
})

test('chartModel drops a sample stamped in the future', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      history: [
        [now / 1000 + 600, 90],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(m.series.length, 1)
  assert.equal(m.series[0][0], 220)
  assert.ok(Math.abs(m.series[0][1] - 40.4) < 0.01)
})

test('chartModel drops a sample older than six hours', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      history: [
        [now / 1000 - 7 * 3600, 10],
        [now / 1000, 40]
      ]
    },
    now
  )
  assert.equal(m.series.length, 1)
  assert.equal(m.series[0][0], 220)
})

test('chartModel maps money history through the row total', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'money',
      total: 20,
      left: 15,
      cur: 'USD',
      used_pct: 25,
      history: [
        [now / 1000 - 3600, 5],
        [now / 1000, 5]
      ]
    },
    now
  )
  assert.equal(m.series[0][1], 50)
})

test('chartModel sorts samples given newest first', async () => {
  const { chartModel } = await loadPlugin()
  const now = Date.parse('2026-11-08T00:00:00Z')
  const m = chartModel(
    {
      kind: 'window',
      used_pct: 40,
      history: [
        [now / 1000, 40],
        [now / 1000 - 3600, 20]
      ]
    },
    now
  )
  assert.ok(Math.abs(m.series[0][0] - (220 - 220 / 6)) < 0.01)
  assert.equal(m.series[1][0], 220)
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
  const { default: plugin, currentAlertAt, setAlert } = await loadPlugin()
  const { ctx, data } = fakeContext()
  data.alertAt = { 'zai:5h': 90, 'zai:weekly': '40', 'nous:5h': 'off', 'x:y': 'junk' }
  plugin.register(ctx)
  assert.deepEqual(currentAlertAt(), { 'zai:5h': 90, 'nous:5h': 'off' })
  setAlert('zai', '5h', 95)
  assert.deepEqual(data.alertAt, { 'zai:5h': 95, 'nous:5h': 'off' })
  const again = await loadPlugin()
  const second = fakeContext()
  second.data.alertAt = 'not an object'
  again.default.register(second.ctx)
  assert.deepEqual(again.currentAlertAt(), {})
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
  assert.deepEqual(chartModel(row, now).alert, { value: 80, y: 14.8 })
  assert.deepEqual(chartModel(row, now, 90).alert, { value: 90, y: 8.4 })
  assert.equal(chartModel(row, now, 'off').alert, null)
  const loud = chartModel({ ...row, used_pct: 90, warn: false }, now, 50)
  assert.equal(loud.colour, 'accent')
})

test('the expanded row shows the alert line label and the notification note', async () => {
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
  assert.ok(nodeText(panel).includes('Notifications appear while Hermes is in the background.'))
  const line = findNodes(panel, n => n.type === 'line' && n.props.key === 'alert')
  assert.equal(line.length, 1)
  assert.equal(line[0].props.y1, 8.4)
  const offPanel = expandedPanel(p, { mode: 'used', choice: {}, barIds: [], tab: '5h', alertAt: { 'zai:5h': 'off' } })
  assert.equal(findNodes(offPanel, n => n.type === 'line' && n.props.key === 'alert').length, 0)
  assert.ok(nodeText(offPanel).includes('Alert off'))
  assert.equal(nodeText(offPanel).includes('alert 80%'), false)
})

test('the alert control offers the six steps and reports a pick', async () => {
  const { expandedPanel } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [{ key: '5h', label: '5h', kind: 'window', used_pct: 40 }]
  }
  const picks = []
  const panel = expandedPanel(p, {
    mode: 'used',
    choice: {},
    barIds: [],
    tab: '5h',
    alertAt: { 'zai:5h': 90 },
    onAlert: (rowKey, value) => picks.push([rowKey, value])
  })
  const control = findNodes(panel, n => typeof n.type === 'function' && n.type.name === 'SegmentedControl')
  assert.equal(control.length, 1)
  assert.deepEqual(control[0].props.options.map(o => o.id), ['50', '70', '80', '90', '95', 'off'])
  assert.equal(control[0].props.value, '90')
  control[0].props.onChange('70')
  control[0].props.onChange('off')
  assert.deepEqual(picks, [
    ['5h', 70],
    ['5h', 'off']
  ])
  const moneyPanel = expandedPanel(
    { id: 'or', name: 'OpenRouter', status: 'ok', money: [{ key: 'money:key_cap:usd', label: 'Key cap', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 }] },
    { mode: 'used', choice: {}, barIds: [], tab: 'money:key_cap:usd' }
  )
  assert.equal(findNodes(moneyPanel, n => typeof n.type === 'function' && n.type.name === 'SegmentedControl').length, 0)
  assert.ok(nodeText(moneyPanel).includes('Notifications appear while Hermes is in the background.'))
})

test('a real payload shape drives the bar, the tip and the warn flag', async () => {
  const { readFile } = await import('node:fs/promises')
  const payload = JSON.parse(await readFile(new URL('./payload.json', import.meta.url), 'utf8'))
  const { summary, tipLine, providerWarn } = await loadPlugin()
  const [anthropic, openrouter] = payload.providers
  assert.equal(summary(anthropic, 'used'), '95%')
  assert.equal(summary(anthropic, 'remaining'), '5%')
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

test('barQuotaKey defaults to the highest used row and honours a choice', async () => {
  const { barQuotaKey, summary } = await loadPlugin()
  const money = {
    id: 'or',
    status: 'ok',
    money: [
      { key: 'money:balance:usd', kind: 'money', total: 10, left: 9, cur: 'USD', used_pct: 10 },
      { key: 'money:key_cap:usd', kind: 'money', total: 10, left: 2, cur: 'USD', used_pct: 80 }
    ]
  }
  assert.equal(barQuotaKey(money), 'money:key_cap:usd')
  assert.equal(summary(money, 'used'), '$8.00')
  assert.equal(barQuotaKey(money, { or: 'money:balance:usd' }), 'money:balance:usd')
  assert.equal(summary(money, 'used', { or: 'money:balance:usd' }), '$1.00')
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
  assert.equal(summary(windows, 'used'), '99%')
  assert.equal(barQuotaKey(windows, { zai: '5h' }), '5h')
  assert.equal(summary(windows, 'used', { zai: '5h' }), '20%')
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
