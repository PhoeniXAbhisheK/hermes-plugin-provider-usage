const notAtImport = name => () => {
  throw new Error(name + ' is not available in the desktop test stubs')
}

let controller = null

/* Test-only switch: the render harness installs hook implementations for the
 * duration of one component call. Outside a render every hook still throws. */
export function __setHooks(next) {
  const previous = controller
  controller = next
  return previous
}

export function __runHook(name, args) {
  if (!controller) notAtImport(name)()
  const fn = controller[name]
  if (typeof fn !== 'function') throw new Error(name + ' is not stubbed for this render')
  return fn(...args)
}

const hook = name => (...args) => __runHook(name, args)

export const useEffect = hook('useEffect')
export const useRef = hook('useRef')
export const useState = hook('useState')
