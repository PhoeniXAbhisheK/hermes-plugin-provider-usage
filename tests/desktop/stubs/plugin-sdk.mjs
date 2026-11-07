import { __runHook } from './react.mjs'

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

export const useQuery = options => __runHook('useQuery', [options])
export const useQueryClient = () => __runHook('useQueryClient', [])
export const useValue = value => __runHook('useValue', [value])

/* The host door is only read inside components, which the tests build as
 * elements rather than render, so the atoms exist and request rejects. */
export const host = {
  state: { focusedSessionId: atom(null), model: atom('') },
  request: () => Promise.reject(new Error('host.request is not available in the desktop test stubs'))
}

export function ScrollArea(props) {
  return { type: 'ScrollArea', props }
}

export function Tip(props) {
  return { type: 'Tip', props }
}
