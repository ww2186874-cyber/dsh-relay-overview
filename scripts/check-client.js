import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderClientBundle } from './build-client.js'

const source = await readFile(resolve('src/client-module.js'), 'utf8')
const built = await readFile(resolve('lib/client.js'), 'utf8')
if (built !== renderClientBundle(source)) {
  console.error('lib/client.js is stale; run pnpm bundle and commit the result')
  process.exitCode = 1
} else {
  console.log('lib/client.js matches src/client-module.js')
}
