import js from '@eslint/js'
import globals from 'globals'

/* Lints the plugin's desktop code from tools/lint, so the plugin root keeps no
 * package.json and the installer never sees a Node sidecar. Paths are relative
 * to the repository root, which is the working directory of the lint command. */
export default [
  { ignores: ['**/node_modules/**', '**/.coverage/**'] },
  js.configs.recommended,
  {
    files: ['desktop/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },
  {
    files: ['tests/desktop/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    }
  }
]
