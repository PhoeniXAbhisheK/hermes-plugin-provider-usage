const notAtImport = name => () => {
  throw new Error(name + ' is not available in the desktop test stubs')
}

export const useEffect = notAtImport('useEffect')
export const useRef = notAtImport('useRef')
export const useState = notAtImport('useState')
