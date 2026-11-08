import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { renderComponent } from './render.mjs'
import { loadPlugin } from './load-plugin.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const payload = JSON.parse(await readFile(join(HERE, 'payload.json'), 'utf8'))
const IDS = payload.providers.map(p => p.id)

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

function invented(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'p' + (i + 1),
    status: 'ok',
    name: 'Provider ' + (i + 1),
    tag: 'Plan',
    code: 'c' + (i + 1),
    windows: [
      {
        label: '5h',
        percent: 10 + i,
        resets_at: '2026-11-07T20:00:00Z',
        status: 'ok',
        key: '5h',
        kind: 'window',
        used_pct: 10 + i,
        warn: false,
        actionable_eta: null
      }
    ]
  }))
}

const errorProvider = {
  id: 'e1',
  status: 'error',
  name: 'Broken',
  tag: 'Plan',
  code: 'e1',
  error: 'HTTP 500'
}

test('UsagePanel renders loading without data', async () => {
  const view = await renderComponent('UsagePanel')
  assert.match(view.joined, /loading/)
  assert.match(view.joined, /Pin all/)
  assert.match(view.joined, /Sorted by risk/)
  assert.equal(view.joined.includes('Unpin all'), false)
})

test('UsagePanel renders the backend error state', async () => {
  const view = await renderComponent('UsagePanel', { isError: true })
  assert.match(view.joined, /unreachable/)
  assert.match(view.joined, /Backend unreachable/)
  assert.match(view.joined, /Pin all/)
})

test('UsagePanel renders the empty provider list', async () => {
  const view = await renderComponent('UsagePanel', { data: { providers: [] } })
  assert.match(view.joined, /No providers available/)
  assert.match(view.joined, /All 0/)
  assert.match(view.joined, /Pinned 0/)
})

test('UsagePanel renders the attention group with both providers', async () => {
  const view = await renderComponent('UsagePanel', { data: payload })
  assert.match(view.joined, /Needs attention/)
  assert.equal(view.joined.includes('Everything else'), false)
  assert.match(view.joined, /Anthropic/)
  assert.match(view.joined, /OpenRouter/)
  assert.match(view.joined, /Sorted by risk/)
  assert.match(view.joined, /All 2/)
})

test('UsagePanel header stamp uses the UI font, not mono', async () => {
  const view = await renderComponent('UsagePanel', { data: payload })
  const stamp = findNodes(
    view.rendered,
    n => n.type === 'span' && typeof n.props.children === 'string' && n.props.children.startsWith('updated ')
  )
  assert.equal(stamp.length, 1)
  assert.equal(stamp[0].props.style.fontFamily, undefined)
  assert.equal(stamp[0].props.style.fontSize, 11)
  assert.equal(stamp[0].props.style.color, 'var(--ui-text-secondary)')
})

test('UsagePanel shows Pin all with no pins and with some pins', async () => {
  const none = await renderComponent('UsagePanel', { data: payload })
  assert.match(none.joined, /Pin all/)
  const some = await renderComponent('UsagePanel', {
    data: payload,
    storage: { barProviders: ['anthropic'] }
  })
  assert.match(some.joined, /Pin all/)
  assert.match(some.joined, /Pinned 1/)
})

test('UsagePanel shows Unpin all when every provider is pinned', async () => {
  const view = await renderComponent('UsagePanel', {
    data: payload,
    storage: { barProviders: IDS }
  })
  assert.match(view.joined, /Unpin all/)
  assert.equal(view.joined.includes('Pin all'), false)
})

test('UsagePanel renders an open window row with its compact tabs and alert button', async () => {
  const view = await renderComponent('UsagePanel', {
    data: payload,
    state: { 1: 'anthropic' }
  })
  for (const label of ['5h', 'Weekly', 'Opus']) assert.match(view.joined, new RegExp(label))
  assert.match(view.joined, /Alert at/)
  assert.equal(view.joined.includes('Notifications appear while Hermes is in the background'), false)
  assert.match(view.joined, /in status bar/)
})

test('UsagePanel renders an open money row with its stats', async () => {
  const view = await renderComponent('UsagePanel', {
    data: payload,
    state: { 1: 'openrouter' }
  })
  assert.match(view.joined, /Balance/)
  assert.match(view.joined, /Key cap/)
  assert.match(view.joined, /Spend/)
  assert.match(view.joined, /Lasts/)
})

test('UsagePanel follows the Remaining mode in its values', async () => {
  const view = await renderComponent('UsagePanel', {
    data: payload,
    storage: { valueMode: 'remaining' }
  })
  assert.match(view.joined, /58%/)
  assert.match(view.joined, /Remaining/)
})

test('BarDetail renders nothing to show, backend down and no pins', async () => {
  const empty = await renderComponent('BarDetail')
  assert.match(empty.joined, /…/)
  const down = await renderComponent('BarDetail', { isError: true })
  assert.match(down.joined, /backend down/)
  const unpinned = await renderComponent('BarDetail', { data: payload })
  assert.match(unpinned.joined, /Usage/)
})

test('BarDetail renders four and seven pinned providers', async () => {
  const four = invented(4)
  const fourView = await renderComponent('BarDetail', {
    data: { providers: four },
    storage: { barProviders: four.map(p => p.id) }
  })
  assert.match(fourView.joined, /c1/)
  assert.match(fourView.joined, /c4/)
  const seven = invented(7)
  const sevenView = await renderComponent('BarDetail', {
    data: { providers: seven },
    storage: { barProviders: seven.map(p => p.id) }
  })
  assert.match(sevenView.joined, /7 pinned/)
  assert.match(sevenView.joined, /all ok/)
})

test('BarDetail renders an error provider without throwing', async () => {
  const view = await renderComponent('BarDetail', {
    data: { providers: [errorProvider] },
    storage: { barProviders: ['e1'] }
  })
  assert.match(view.joined, /e1/)
  assert.match(view.joined, /-/)
})

test('BarTip renders the empty hint without data and with no pins', async () => {
  const empty = await renderComponent('BarTip')
  assert.match(empty.joined, /Pin a provider, or open a chat that uses one/)
  assert.match(empty.joined, /Click to open/)
  const unpinned = await renderComponent('BarTip', { data: payload })
  assert.match(unpinned.joined, /Pin a provider, or open a chat that uses one/)
})

test('BarTip renders four and seven pinned providers', async () => {
  const four = invented(4)
  const fourView = await renderComponent('BarTip', {
    data: { providers: four },
    storage: { barProviders: four.map(p => p.id) }
  })
  assert.match(fourView.joined, /Provider 1/)
  assert.match(fourView.joined, /Provider 4/)
  const seven = invented(7)
  const sevenView = await renderComponent('BarTip', {
    data: { providers: seven },
    storage: { barProviders: seven.map(p => p.id) }
  })
  assert.match(sevenView.joined, /Provider 7/)
})

test('BarTip renders an error provider as a dash', async () => {
  const view = await renderComponent('BarTip', {
    data: { providers: [errorProvider] },
    storage: { barProviders: ['e1'] }
  })
  assert.match(view.joined, /Broken/)
  assert.match(view.joined, /-/)
})

/* Hand-built v0.3.1 shape: no key and no used_pct on any row. */
const oldPayload = {
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

test('UsagePanel shows the stale backend notice instead of rows', async () => {
  const view = await renderComponent('UsagePanel', { data: oldPayload })
  assert.match(view.joined, /Restart the Hermes dashboard to finish updating\./)
  assert.equal(view.joined.includes('100%'), false)
  assert.equal(view.joined.includes('Anthropic'), false)
})

test('BarDetail says restart dashboard for a stale backend', async () => {
  const view = await renderComponent('BarDetail', { data: oldPayload })
  assert.match(view.joined, /restart dashboard/)
  assert.equal(view.joined.includes('100%'), false)
})

test('BarTip gives the restart sentence for a stale backend', async () => {
  const view = await renderComponent('BarTip', { data: oldPayload })
  assert.match(view.joined, /Restart the Hermes dashboard to finish updating\./)
  assert.equal(view.joined.includes('100%'), false)
})

test('UsagePanel draws the chart history polyline when a row carries history', async () => {
  const now = Math.floor(Date.now() / 1000)
  const provider = {
    ...payload.providers[0],
    windows: [
      {
        ...payload.providers[0].windows[0],
        history: [
          [now - 3600, 40],
          [now - 60, 42]
        ]
      }
    ]
  }
  const plugin = await loadPlugin()
  const element = plugin.expandedPanel(provider, {
    mode: 'used',
    alertAt: {},
    barIds: [],
    choice: {},
    tab: undefined
  })
  const tags = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node.type === 'string') tags.push(node.type)
    if (node.props) walk(node.props.children)
  }
  walk(element)
  assert.ok(tags.includes('polyline'))
})
