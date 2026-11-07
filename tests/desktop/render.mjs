/** Render harness for plugin.js components. Test-only.
 *
 * The react stub throws on every hook call outside a render. This module
 * installs a controller for the duration of each component call, walks the
 * returned element tree, and calls every plugin-defined function component
 * with its props so nested components render too. SDK stub components are
 * leaves: their props are scanned for text instead of being called again.
 */
import {
  ScrollArea,
  Tip,
  host
} from './stubs/plugin-sdk.mjs'
import { __setHooks } from './stubs/react.mjs'
import { loadPlugin } from './load-plugin.mjs'

const LEAVES = new Set([ScrollArea, Tip])

function strings(value, out) {
  if (value == null || typeof value === 'boolean' || typeof value === 'function') return
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out)
  }
}

function makeController(options) {
  let stateIndex = 0
  return {
    useState(initial) {
      const index = stateIndex++
      const override = options.state && Object.prototype.hasOwnProperty.call(options.state, index)
      const value = override
        ? options.state[index]
        : typeof initial === 'function'
          ? initial()
          : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef() {
      return { current: null }
    },
    useValue(value) {
      return value && typeof value.get === 'function' ? value.get() : value
    },
    useQuery() {
      return { data: options.data, isError: Boolean(options.isError) }
    },
    useQueryClient() {
      return { setQueryData() {}, refetchQueries() {} }
    }
  }
}

function walk(node, ctx) {
  if (node == null || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    ctx.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, ctx)
    return
  }
  if (typeof node !== 'object') return

  const { type, props } = node
  if (typeof type === 'function') {
    if (LEAVES.has(type)) {
      strings(props, ctx.text)
      return
    }
    ctx.calls.push(type.name || '<anonymous>')
    const previous = __setHooks(makeController(ctx.options))
    let child
    try {
      child = type(props || {})
    } finally {
      __setHooks(previous)
    }
    if (!ctx.root) ctx.root = child
    walk(child, ctx)
    return
  }
  if (typeof type === 'string') {
    ctx.tags.push(type)
    strings(props && props['aria-label'], ctx.text)
    strings(props && props.title, ctx.text)
    walk(props && props.children, ctx)
  }
}

/** Render one registered component by name: UsagePanel, BarDetail or BarTip. */
export async function renderComponent(name, options = {}) {
  const plugin = await loadPlugin()
  let contribution = null
  const storage = {
    get(key, fallback) {
      return options.storage && Object.prototype.hasOwnProperty.call(options.storage, key)
        ? options.storage[key]
        : fallback
    },
    set() {}
  }
  plugin.default.register({
    storage,
    register(value) {
      contribution = value
    },
    os: { notify() {} },
    rest: {}
  })
  if (!contribution) throw new Error('plugin registered no contribution')

  const data = contribution.data
  const element =
    name === 'UsagePanel'
      ? data.menuContent()
      : name === 'BarDetail'
        ? data.detail
        : name === 'BarTip'
          ? data.title
          : null
  if (!element) throw new Error('unknown component ' + name)

  const ctx = { calls: [], options, tags: [], text: [], root: null }
  walk(element, ctx)
  return { calls: ctx.calls, tags: ctx.tags, text: ctx.text, joined: ctx.text.join(' | '), tree: element, rendered: ctx.root }
}

export { host }
