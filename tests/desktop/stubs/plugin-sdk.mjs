export const STATUSBAR_AREAS = { right: 'right' }

export function atom(initial) {
  let current = initial
  const listeners = new Set()
  return {
    get: () => current,
    set: next => {
      current = next
      for (const fn of listeners) fn(current)
    },
    listen: fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    subscribe: fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}

const notAtImport = name => () => {
  throw new Error(name + ' is not available in the desktop test stubs')
}

export const useQuery = notAtImport('useQuery')
export const useQueryClient = notAtImport('useQueryClient')
export const useValue = notAtImport('useValue')

/* The host door is only read inside components, which the tests build as
 * elements rather than render, so the atoms exist and request rejects. */
export const host = {
  state: { focusedSessionId: atom(null), model: atom('') },
  request: () => Promise.reject(new Error('host.request is not available in the desktop test stubs'))
}

export function SegmentedControl(props) {
  return { type: 'SegmentedControl', props }
}

export function ScrollArea(props) {
  return { type: 'ScrollArea', props }
}

export function Tip(props) {
  return { type: 'Tip', props }
}

export function Tabs(props) {
  return { type: 'Tabs', props }
}

export function TabsList(props) {
  return { type: 'TabsList', props }
}

export function TabsTrigger(props) {
  return { type: 'TabsTrigger', props }
}
