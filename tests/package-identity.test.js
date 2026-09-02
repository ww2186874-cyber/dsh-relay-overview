import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const clientBuilder = await readFile(new URL('../scripts/build-client.js', import.meta.url), 'utf8')
const bundlePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

const PACKAGE_NAME = 'dsh-relay-overview'
const ROW_ID = 'relay-overview'

test('package, Client bundle, Cordis row, and CI smoke test share the Relay Overview identity', () => {
  assert.equal(packageJson.name, PACKAGE_NAME)
  assert.match(clientBuilder, new RegExp(`id: "${PACKAGE_NAME}"`))
  assert.match(bundlePatch, new RegExp(`- id: ${ROW_ID}`))
  assert.match(bundlePatch, new RegExp(`name: '${PACKAGE_NAME}'`))
  assert.match(workflow, /package_name="\$\(node -p/)
  assert.match(workflow, /const packageName = process\.env\.PACKAGE_NAME/)
  assert.equal(workflow.includes('dsh-relay-balance'), false)
})

test('package targets only the audited DSH alpha.5 Remote Client surface', () => {
  assert.equal(packageJson.engines.dsh, '0.1.2-alpha.5')
  assert.deepEqual(packageJson.dsh.client.inject, [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), false)
  assert.equal(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'), false)
})
