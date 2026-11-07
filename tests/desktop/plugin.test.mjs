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

test('barVisible follows the default and the explicit list', async () => {
  const { barVisible } = await loadPlugin()
  assert.equal(barVisible(null, 'a', ['a', 'b']), true)
  assert.equal(barVisible(null, 'b', ['a', 'b']), false)
  assert.equal(barVisible(null, 'a', []), false)
  assert.equal(barVisible(['b'], 'b', ['a', 'b']), true)
  assert.equal(barVisible(['b'], 'a', ['a', 'b']), false)
  assert.equal(barVisible(null, 'a', undefined), false)
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

test('ProviderBlock takes warn and eta from each row', async () => {
  const { ProviderBlock } = await loadPlugin()
  const p = {
    id: 'zai',
    name: 'Zai',
    status: 'ok',
    windows: [
      { key: '5h', label: '5h', used_pct: 95, warn: false, actionable_eta: 900 },
      { key: 'weekly', label: 'Weekly', used_pct: 10, warn: true, actionable_eta: null }
    ],
    money: [
      {
        key: 'money:balance:usd',
        label: 'Balance',
        kind: 'money',
        total: 10,
        left: 8,
        cur: 'USD',
        used_pct: 20,
        warn: false,
        actionable_eta: 600
      },
      {
        key: 'money:key_cap:usd',
        label: 'Key cap',
        kind: 'money',
        total: 10,
        left: 2,
        cur: 'USD',
        used_pct: 80,
        warn: true,
        actionable_eta: null
      }
    ]
  }
  const block = ProviderBlock({ p, first: true, mode: 'used', ids: ['zai'] })
  const rows = block.props.children.filter(
    child => child && typeof child.type === 'function' && child.type.name === 'Row'
  )
  assert.equal(rows.length, 4)
  assert.equal(rows[0].props.key, 'w5h')
  assert.equal(rows[0].props.warn, false)
  assert.equal(rows[0].props.eta, '~15m')
  assert.equal(rows[1].props.key, 'wweekly')
  assert.equal(rows[1].props.warn, true)
  assert.equal(rows[1].props.eta, null)
  assert.equal(rows[2].props.key, 'mmoney:balance:usd')
  assert.equal(rows[2].props.warn, false)
  assert.equal(rows[2].props.eta, '~10m')
  assert.equal(rows[3].props.key, 'mmoney:key_cap:usd')
  assert.equal(rows[3].props.warn, true)
  assert.equal(rows[3].props.eta, null)
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
