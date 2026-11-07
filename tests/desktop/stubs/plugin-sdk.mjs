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
