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

test('money formats USD, CNY and an unknown currency', async () => {
  const { money } = await loadPlugin()
  assert.equal(money(9.02, 'USD'), '$9.02')
  assert.equal(money(9.02, 'CNY'), '\u00a59.02')
  assert.equal(money(9.02, 'EUR'), '$9.02')
  assert.equal(money(1, 'USD'), '$1.00')
  assert.equal(money('3.5', 'USD'), '$3.50')
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
  assert.equal(usedPercentOf({ percent: 150 }), 100)
  assert.equal(usedPercentOf({ percent: -5 }), 0)
  assert.equal(usedPercentOf({}), 0)
  assert.equal(usedPercentOf(null), 0)
  assert.equal(usedPercentOf({ percent: '42.5' }), 42.5)
})

test('capUsedPercent clamps and returns zero without a total', async () => {
  const { capUsedPercent } = await loadPlugin()
  assert.equal(capUsedPercent({ total: 100, left: 40 }), 60)
  assert.equal(capUsedPercent({ total: 0, left: 5 }), 0)
  assert.equal(capUsedPercent({}), 0)
  assert.equal(capUsedPercent({ total: 100, left: 120 }), 0)
  assert.equal(capUsedPercent({ total: 100, left: -20 }), 100)
})

test('providerWarn uses the window and Key cap thresholds', async () => {
  const { providerWarn } = await loadPlugin()
  assert.equal(providerWarn({ status: 'ok', windows: [{ percent: 79.9 }] }), false)
  assert.equal(providerWarn({ status: 'ok', windows: [{ percent: 80 }] }), true)
  assert.equal(
    providerWarn({ status: 'ok', money: [{ label: 'Key cap', total: 100, left: 20 }] }),
    true
  )
  assert.equal(
    providerWarn({ status: 'ok', money: [{ label: 'Balance', total: 100, left: 10 }] }),
    false
  )
  assert.equal(providerWarn({ status: 'error', windows: [{ percent: 99 }] }), false)
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

test('actionableEta applies the reset and seven day rules', async () => {
  const restore = frozen(NOW)
  try {
    const { actionableEta } = await loadPlugin()
    const resetIn1000 = isoAt(NOW + 1000 * 1000)
    assert.equal(actionableEta({ eta_seconds: 1000, resets_at: resetIn1000 }), null)
    assert.equal(actionableEta({ eta_seconds: 999, resets_at: resetIn1000 }), 999)
    assert.equal(actionableEta({ eta_seconds: 7 * 86400 }), 7 * 86400)
    assert.equal(actionableEta({ eta_seconds: 7 * 86400 + 1 }), null)
    assert.equal(actionableEta({ eta_seconds: 10 * 86400, resets_at: 'not a date' }), 10 * 86400)
    assert.equal(actionableEta({ eta_seconds: 0 }), null)
    assert.equal(actionableEta({}), null)
  } finally {
    restore()
  }
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

test('summary covers caps, plain money, windows and empty providers', async () => {
  const { summary } = await loadPlugin()
  const cap = { status: 'ok', money: [{ label: 'Key cap', total: 10, left: 4, cur: 'USD' }] }
  assert.equal(summary(cap, 'used'), '$6.00')
  assert.equal(summary(cap, 'remaining'), '$4.00')
  const noCap = { status: 'ok', money: [{ label: 'Balance', total: 10, left: 4, cur: 'USD' }] }
  assert.equal(summary(noCap, 'used'), '$6.00')
  const noTotal = { status: 'ok', money: [{ label: 'Balance', left: 7, cur: 'USD' }] }
  assert.equal(summary(noTotal, 'used'), '$7.00')
  assert.equal(summary(noTotal, 'remaining'), '$7.00')
  const windows = {
    status: 'ok',
    windows: [
      { label: '7d', percent: 10 },
      { label: '5h', percent: 20 }
    ]
  }
  assert.equal(summary(windows, 'used'), '20%')
  assert.equal(summary(windows, 'remaining'), '80%')
  assert.equal(summary({ status: 'ok', windows: [{ label: '7d', percent: 10 }] }, 'used'), '10%')
  assert.equal(summary({ status: 'ok' }, 'used'), '-')
  assert.equal(summary({ status: 'error' }, 'used'), '-')
  const capSecond = {
    status: 'ok',
    money: [
      { label: 'Balance', total: 100, left: 90, cur: 'USD' },
      { label: 'Key cap', total: 10, left: 4, cur: 'USD' }
    ]
  }
  assert.equal(summary(capSecond, 'used'), '$6.00')
})

test('tipLine covers windows, money rows and an error provider', async () => {
  const { tipLine } = await loadPlugin()
  const windows = { status: 'ok', windows: [{ label: '5h', percent: 20, eta_seconds: 5400 }] }
  assert.equal(tipLine(windows, 'used'), '5h 20% (~1h)')
  assert.equal(tipLine(windows, 'remaining'), '5h 80% (~1h)')
  assert.equal(tipLine({ status: 'ok', windows: [{ label: '5h', percent: 20 }] }, 'used'), '5h 20%')
  const moneyRows = {
    status: 'ok',
    money: [
      { label: 'Balance', total: 10, left: 4, cur: 'USD', depletes_in_seconds: 5400 }
    ]
  }
  assert.equal(tipLine(moneyRows, 'used'), 'Spent $6.00/$10.00 (~1h)')
  assert.equal(tipLine(moneyRows, 'remaining'), 'Balance $4.00/$10.00 (~1h)')
  const cap = { status: 'ok', money: [{ label: 'Key cap', total: 10, left: 4, cur: 'USD' }] }
  assert.equal(tipLine(cap, 'used'), 'Cap used $6.00/$10.00')
  assert.equal(tipLine({ status: 'error' }, 'used'), 'unavailable')
})

test('checkAlerts fires a window at 80 percent once and stores it', async () => {
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
          windows: [{ label: '5h', percent: 80, resets_at: resetsAt }]
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
        { id: 'zai', name: 'Zai', status: 'ok', windows: [{ label: '5h', percent: 80, resets_at: first }] }
      ]
    })
    const moved = isoAt(NOW + 30 * 60000 + 60000)
    checkAlerts({
      providers: [
        { id: 'zai', name: 'Zai', status: 'ok', windows: [{ label: '5h', percent: 80, resets_at: moved }] }
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
        { id: 'zai', name: 'Zai', status: 'ok', windows: [{ label: '5h', percent: 80 }] }
      ]
    })
    assert.deepEqual(notices, [{ title: 'Zai: 5h at 80% used', body: '' }])
    assert.deepEqual(Object.keys(data.alerts), ['zai:5h:no-reset'])
  } finally {
    restore()
  }
})

test('a Key cap at 80 percent fires once per day', async () => {
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
            { label: 'Key cap', total: 10, left: 2, cur: 'USD', depletes_in_seconds: 5400 }
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
    assert.deepEqual(Object.keys(data.alerts), ['zai:Key cap:' + Math.floor(NOW / 86400000)])
    checkAlerts(payload)
    assert.equal(notices.length, 1)
  } finally {
    restore()
  }
})

test('a non-cap money row and an error provider never fire', async () => {
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
          money: [{ label: 'Balance', total: 100, left: 10, cur: 'USD' }]
        }
      ]
    })
    checkAlerts({
      providers: [
        { id: 'zai', name: 'Zai', status: 'error', windows: [{ label: '5h', percent: 99 }] }
      ]
    })
    assert.equal(notices.length, 0)
  } finally {
    restore()
  }
})

test('a fractional warn percentage rounds in the title', async () => {
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
          windows: [{ label: '5h', percent: 80.6, resets_at: isoAt(NOW + 30 * 60000) }]
        }
      ]
    })
    assert.equal(notices.length, 1)
    assert.equal(notices[0].title, 'Zai: 5h at 81% used')
  } finally {
    restore()
  }
})

test('an actionable window eta adds the projection to the body', async () => {
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
              label: '5h',
              percent: 80,
              eta_seconds: 999,
              resets_at: isoAt(NOW + 1000 * 1000)
            }
          ],
          money: [
            { label: 'Key cap', total: 10, left: 2, cur: 'USD', depletes_in_seconds: 5400 }
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

test('the default export registers one status item', async () => {
  const { default: plugin } = await loadPlugin()
  const { ctx, registrations } = fakeContext()
  assert.equal(plugin.id, 'provider-usage')
  assert.equal(typeof plugin.register, 'function')
  plugin.register(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'status')
})
