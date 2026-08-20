import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function renderClientBundle(input) {
  const source = input.replace(/\r\n?/g, '\n')
  const indented = source.split('\n').map((line) => line === '' ? '' : `    ${line}`).join('\n')
  return `window.__ModuleLoader__.load({\n  id: "dsh-relay-balance",\n  factory: (require) => {\n    const module = { exports: {} }\n    const exports = module.exports\n${indented}\n    return module.exports\n  },\n})\n`
}

export async function buildClient() {
  const source = await readFile(resolve(root, 'src/client-module.js'), 'utf8')
  await mkdir(resolve(root, 'lib'), { recursive: true })
  await writeFile(resolve(root, 'lib/client.js'), renderClientBundle(source), 'utf8')
  console.log('built lib/client.js')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) await buildClient()
