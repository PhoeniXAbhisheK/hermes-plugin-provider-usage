import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', '..', 'desktop', 'plugin.js')

const STUBS = [
  ["'@hermes/plugin-sdk'", new URL('./stubs/plugin-sdk.mjs', import.meta.url).href],
  ["'react/jsx-runtime'", new URL('./stubs/react-jsx-runtime.mjs', import.meta.url).href],
  ["'react'", new URL('./stubs/react.mjs', import.meta.url).href]
]

function replaceExactlyOnce(source, needle, url) {
  const parts = source.split(needle)
  if (parts.length !== 2) {
    throw new Error(
      'expected exactly one ' + needle + ' in desktop/plugin.js, found ' + (parts.length - 1)
    )
  }
  return parts[0] + JSON.stringify(url) + parts[1]
}

export async function loadPlugin() {
  const source = await readFile(PLUGIN, 'utf8')
  let patched = source
  for (const [needle, url] of STUBS) patched = replaceExactlyOnce(patched, needle, url)
  const dir = await mkdtemp(join(tmpdir(), 'provider-usage-plugin-'))
  try {
    const file = join(dir, 'plugin.mjs')
    await writeFile(file, patched, 'utf8')
    return await import(pathToFileURL(file).href)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
