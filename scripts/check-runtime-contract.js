import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_DSH_VERSION = '0.1.2-alpha.5'
const EXPECTED_REACT_VERSION = '18.3.1'
const EXPECTED_SCHEMASTERY_VERSION = '3.18.2'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function runtimeRoot() {
  const explicit = process.argv.slice(2).find((argument) => argument !== '--') || process.env.DSH_RUNTIME_ROOT
  if (!explicit) throw new Error('pass the DSH runtime root as the first argument or set DSH_RUNTIME_ROOT')
  const root = resolve(explicit)
  if (!(await exists(join(root, 'package.json'))) || !(await exists(join(root, 'node_modules', '.pnpm')))) {
    throw new Error(`not a DSH runtime root: ${root}`)
  }
  return root
}

async function packageRoots(runtime, packageName, expectedVersion = EXPECTED_DSH_VERSION) {
  const pnpmRoot = join(runtime, 'node_modules', '.pnpm')
  const roots = []
  for (const entry of await readdir(pnpmRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(pnpmRoot, entry.name, 'node_modules', ...packageName.split('/'))
    if (await exists(join(candidate, 'package.json'))) roots.push(candidate)
  }
  if (roots.length === 0) throw new Error(`runtime package ${packageName} was not found`)
  for (const path of roots) {
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (manifest.version !== expectedVersion) {
      throw new Error(`${packageName} is ${String(manifest.version)} at ${path}; expected ${expectedVersion}`)
    }
  }
  return [...new Set(roots)].sort()
}

async function allText(path, predicate) {
  const chunks = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && predicate(entry.name)) chunks.push(await readFile(child, 'utf8'))
    }
  }
  await visit(path)
  return chunks.join('\n')
}

function requireText(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label} contract no longer contains ${JSON.stringify(needle)}`)
}

const runtime = await runtimeRoot()
const runtimeManifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'))
if (runtimeManifest.dependencies?.['@deepseek-ai/dsh'] !== EXPECTED_DSH_VERSION) {
  throw new Error(`runtime declares @deepseek-ai/dsh ${String(runtimeManifest.dependencies?.['@deepseek-ai/dsh'])}; expected ${EXPECTED_DSH_VERSION}`)
}
for (const packageName of ['react', 'react-dom']) {
  if (runtimeManifest.dependencies?.[packageName] !== EXPECTED_REACT_VERSION) {
    throw new Error(`runtime declares ${packageName} ${String(runtimeManifest.dependencies?.[packageName])}; expected ${EXPECTED_REACT_VERSION}`)
  }
  await packageRoots(runtime, packageName, EXPECTED_REACT_VERSION)
}
await packageRoots(runtime, '@deepseek-ai/schemastery', EXPECTED_SCHEMASTERY_VERSION)

const pluginManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
if (pluginManifest.engines?.dsh !== EXPECTED_DSH_VERSION) {
  throw new Error(`plugin declares engines.dsh ${String(pluginManifest.engines?.dsh)}; expected ${EXPECTED_DSH_VERSION}`)
}
if (pluginManifest.dependencies?.['@deepseek-ai/schemastery'] !== `^${EXPECTED_SCHEMASTERY_VERSION}`) {
  throw new Error(`plugin must target @deepseek-ai/schemastery ^${EXPECTED_SCHEMASTERY_VERSION}`)
}
const expectedClientInject = [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-sidebar',
]
if (JSON.stringify(pluginManifest.dsh?.client?.inject) !== JSON.stringify(expectedClientInject)) {
  throw new Error(`plugin Client inject graph differs from the audited Alpha 5 graph: ${JSON.stringify(pluginManifest.dsh?.client?.inject)}`)
}

const typeChecks = [
  ['@deepseek-ai/dsh-settings', [
    'register<const Namespace extends string, T>',
    'get<const Namespace extends string>',
    'update<const Namespace extends string>',
    'expectedRevision?: number',
  ]],
  ['@deepseek-ai/dsh-credentials', [
    'abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>',
    'abstract describe(ref: CredentialRef): Promise<CredentialInfo>',
    'abstract set(ref: CredentialRef, value: string): Promise<void>',
    'abstract unset(ref: CredentialRef): Promise<void>',
  ]],
  ['@deepseek-ai/dsh-host-webserver', [
    "export type WebRouteKind = 'exact' | 'prefix'",
    'handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>',
    'register(route: WebRoute): () => void',
  ]],
  ['@deepseek-ai/dsh-client-ui-renderer', [
    "readonly register: SlotCore['register']",
    'inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void',
  ]],
  ['@deepseek-ai/dsh-client-ui-settings', [
    "'settings.section'",
    'owner: SettingsSectionOwnerProps',
    'close: () => void',
    'bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T>',
    "status: 'loading' | 'ready' | 'unavailable'",
  ]],
  ['@deepseek-ai/dsh-client-ui-sidebar', [
    "'sidebar.footer.action'",
    'owner: SidebarFooterActionOwnerProps',
    'export interface SidebarFooterActionOwnerProps',
    'wide: boolean',
  ]],
  ['@deepseek-ai/dsh-api-settings-controller', [
    'describe(refs: string[]): Promise<Record<string, CredentialInfo>>',
  ]],
  ['@deepseek-ai/dsh-api-remotes', [
    'remote: ClientRemote',
    'export type { RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult, }',
  ]],
]

for (const [packageName, needles] of typeChecks) {
  for (const path of await packageRoots(runtime, packageName)) {
    const text = await allText(join(path, 'lib', 'types'), (name) => name.endsWith('.d.ts'))
    for (const needle of needles) requireText(text, needle, `${packageName} (${path})`)
  }
}

for (const path of await packageRoots(runtime, '@deepseek-ai/dsh-client-ui-renderer')) {
  const text = await readFile(join(path, 'lib', 'client.js'), 'utf8')
  requireText(text, '"data-slot": slotKey', `Slot renderer DOM anchor (${path})`)
}
for (const path of await packageRoots(runtime, '@deepseek-ai/dsh-client-modules')) {
  const text = await readFile(join(path, 'lib', 'client.js'), 'utf8')
  for (const needle of ['registration.factory', 'row.inject', 'materialize(id)', 'invalidate(id, rev)', 'atRevision(row.url, rev ?? row.rev)']) {
    requireText(text, needle, `Client module loader (${path})`)
  }
}

console.log(`runtime contract verified: DSH ${EXPECTED_DSH_VERSION}`)
console.log(`Host Settings, Credential, WebRoute, Client Remote, Slot, loader, React, and Schemastery contracts verified for ${runtime}`)
