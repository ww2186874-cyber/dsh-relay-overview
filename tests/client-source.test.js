import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { renderClientBundle } from '../scripts/build-client.js'

const source = await readFile(new URL('../src/client-module.js', import.meta.url), 'utf8')
const built = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function evaluateSource(react = {}, globals = {}) {
  const clientExports = {}
  vm.runInNewContext(source, {
    require(specifier) {
      if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
      return react
    },
    exports: clientExports,
    ...globals,
  })
  return clientExports
}

function evaluateBundle() {
  let factory
  vm.runInNewContext(built, {
    window: {
      __ModuleLoader__: {
        load(definition) {
          assert.equal(definition.id, 'dsh-relay-balance')
          factory = definition.factory
        },
      },
    },
  })
  assert.equal(typeof factory, 'function')
  return factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected require: ${specifier}`)
    return {}
  })
}

function timerHarness() {
  const timers = new Map()
  let nextId = 1
  return {
    set(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    clear(id) { timers.delete(id) },
    fireFirst() {
      const entry = timers.entries().next().value
      assert.ok(entry)
      const [id, timer] = entry
      timers.delete(id)
      timer.callback()
      return timer.delay
    },
    count() { return timers.size },
  }
}

const clientExports = evaluateSource()

test('generated client artifact exactly matches the source-of-truth build rule', () => {
  assert.equal(built, renderClientBundle(source))
  assert.equal(built.includes('\r'), false)
})

test('actual generated bundle exports generic Relay helpers', () => {
  const bundled = evaluateBundle()
  assert.equal(bundled.toneOf(9.99, 'quota'), 'danger')
  assert.equal(bundled.toneOf(10, 'quota'), 'warning')
  assert.equal(bundled.toneOf(30.01, 'quota'), 'healthy')
  assert.equal(bundled.toneOf(null, 'wallet'), 'neutral')
  assert.equal(bundled.money(12.345, 'USD'), '$12.35')
  assert.equal(typeof bundled.createBalanceRequestManager, 'function')
})

test('request manager deduplicates refreshes and aborts cleanup without a false error', async () => {
  const requests = []
  const successes = []
  const errors = []
  const loading = []
  const timers = timerHarness()
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl(_url, init) {
      return new Promise((resolve, reject) => {
        requests.push({ init, resolve, reject })
        init.signal.addEventListener('abort', () => {
          const error = new Error('hidden cancellation')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading: () => loading.push(true),
    onSuccess: (data) => successes.push(data),
    onError: (message) => errors.push(message),
  })

  const first = manager.refresh()
  const duplicate = manager.refresh()
  assert.equal(first, duplicate)
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.equal(requests[0].init.signal.aborted, false)
  assert.equal(timers.count(), 1)

  manager.abort()
  assert.equal(requests[0].init.signal.aborted, true)
  const second = manager.refresh()
  assert.notEqual(second, first)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  assert.equal(await first, null)
  assert.deepEqual(errors, [])

  assert.equal(manager.refresh(), second, 'an older request must not clear a newer record')
  const data = { mode: 'quota', remaining: 1, total: 2, percent: 50, unit: 'USD' }
  requests[1].resolve({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
  assert.deepEqual(await second, data)
  assert.deepEqual(successes, [data])
  assert.equal(loading.length, 2)
  assert.equal(timers.count(), 0)
})

test('client timeout aborts a hung request, reports it, and permits retry', async () => {
  const requests = []
  const errors = []
  const timers = timerHarness()
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl(_url, init) {
      return new Promise((_resolve, reject) => {
        requests.push(init)
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading() {},
    onSuccess() {},
    onError: (message) => errors.push(message),
  })
  const first = manager.refresh()
  await Promise.resolve()
  assert.equal(timers.fireFirst(), 20_000)
  assert.equal(await first, null)
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(errors, ['中转额度查询超时'])

  const second = manager.refresh()
  await Promise.resolve()
  assert.notEqual(second, first)
  assert.equal(requests.length, 2)
  manager.abort()
  await second
  assert.deepEqual(errors, ['中转额度查询超时'])
})

test('timeout stays authoritative when a fetch implementation ignores abort and returns late', async () => {
  let resolveFetch
  const errors = []
  const successes = []
  const timers = timerHarness()
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl: async () => new Promise((resolve) => { resolveFetch = resolve }),
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading() {},
    onSuccess: (data) => successes.push(data),
    onError: (message) => errors.push(message),
  })
  const operation = manager.refresh()
  await Promise.resolve()
  timers.fireFirst()
  resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, data: { mode: 'wallet', remaining: 1 } }) })
  assert.equal(await operation, null)
  assert.deepEqual(successes, [])
  assert.deepEqual(errors, ['中转额度查询超时'])
})

test('request manager reports genuine local route failures', async () => {
  const errors = []
  const timers = timerHarness()
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl: async () => { throw new Error('visible network failure') },
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading() {},
    onSuccess() {},
    onError: (message) => errors.push(message),
  })
  assert.equal(await manager.refresh(), null)
  assert.deepEqual(errors, ['visible network failure'])
})

test('refresh lifecycle installs load, minute, and visibility refresh and cleans up', () => {
  let refreshes = 0
  let aborts = 0
  let intervalCallback
  let intervalDelay
  let cleared
  let visibilityHandler
  let removedHandler
  let refreshEventHandler
  let removedRefreshEventHandler
  const manager = { refresh() { refreshes += 1 }, abort() { aborts += 1 } }
  const windowObject = {
    setInterval(callback, delay) { intervalCallback = callback; intervalDelay = delay; return 42 },
    clearInterval(id) { cleared = id },
    addEventListener(type, callback) { assert.equal(type, 'relay-balance:refresh'); refreshEventHandler = callback },
    removeEventListener(type, callback) { assert.equal(type, 'relay-balance:refresh'); removedRefreshEventHandler = callback },
  }
  const documentObject = {
    visibilityState: 'visible',
    addEventListener(type, callback) { assert.equal(type, 'visibilitychange'); visibilityHandler = callback },
    removeEventListener(type, callback) { assert.equal(type, 'visibilitychange'); removedHandler = callback },
  }

  const dispose = clientExports.installRefreshLifecycle(manager, windowObject, documentObject)
  assert.equal(refreshes, 1)
  assert.equal(intervalDelay, 60_000)
  intervalCallback()
  visibilityHandler()
  refreshEventHandler()
  assert.equal(refreshes, 4)
  documentObject.visibilityState = 'hidden'
  intervalCallback()
  visibilityHandler()
  assert.equal(refreshes, 4)
  dispose()
  assert.equal(cleared, 42)
  assert.equal(removedHandler, visibilityHandler)
  assert.equal(removedRefreshEventHandler, refreshEventHandler)
  assert.equal(aborts, 1)
})

function renderIndicator(state, wide, globals = {}) {
  const react = {
    useState: () => [state, () => {}],
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    useEffect() {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }
  return evaluateSource(react, globals).BalanceIndicator({ wide })
}

test('subscription timing text contains only expiry and reset information', () => {
  const now = Date.parse('2026-08-22T19:44:06Z')
  assert.equal(clientExports.balanceTimingText({
    mode: 'subscription',
    expiresAt: '2026-09-18T19:39:22.033831+08:00',
    resetAt: '2026-08-26T13:56:11.496Z',
  }, now), '剩余26天（2026/09/18 19:39） 3d18h后重置')
  assert.equal(clientExports.balanceTimingText({ mode: 'quota', expiresAt: '2026-09-18T19:39:22+08:00', resetAt: '2026-08-26T13:56:11Z' }, now), null)
  assert.equal(clientExports.balanceTimingText({ mode: 'subscription', expiresAt: null, resetAt: null }, now), null)
})

test('timing tooltip prefers the card right and remains inside the viewport', () => {
  const beside = clientExports.timingTooltipPosition(
    { right: 268, top: 378, height: 50 },
    { width: 280, height: 33 },
    { width: 748, height: 484 },
  )
  assert.equal(beside.left, 276)
  assert.equal(beside.top, 386.5)

  const clamped = clientExports.timingTooltipPosition(
    { right: 730, top: 470, height: 30 },
    { width: 280, height: 33 },
    { width: 748, height: 484 },
  )
  assert.equal(clamped.left, 460)
  assert.equal(clamped.top, 443)
})

test('quota rendering uses a percentage while wallet rendering does not invent one', () => {
  const quotaState = {
    data: { displayName: 'My Relay', mode: 'quota', scope: 'total', remaining: 40, total: 100, spent: 60, percent: 40, unit: 'USD', planName: '' },
    loading: false,
    error: 'temporary failure',
  }
  const walletState = {
    data: { displayName: 'My Relay', mode: 'wallet', scope: null, remaining: 40, total: null, spent: 12, percent: null, unit: 'USD', planName: '' },
    loading: false,
    error: null,
  }
  const quotaWide = renderIndicator(quotaState, true)
  const quotaRail = renderIndicator(quotaState, false)
  const walletWide = renderIndicator(walletState, true)
  const walletRail = renderIndicator(walletState, false)

  assert.match(quotaWide.props.className, /relay-balance--wide/)
  assert.match(quotaRail.props.className, /has-percent/)
  assert.equal(quotaRail.children[0].children[0], '40')
  assert.equal(quotaWide.children[0].children[0].children[0], '$40.00/$100.00')
  assert.equal(quotaWide.children[0].children[2].children[0], '40.0%')
  assert.equal(quotaWide.children[1].children[0].props.style.width, '40%')
  assert.doesNotMatch(quotaWide.children[0].children[0].children[0], /My Relay|剩余|限额/)
  assert.equal(quotaWide.props.title, undefined)
  assert.equal(quotaWide.children[1].props.title, undefined)

  assert.doesNotMatch(walletRail.props.className, /has-percent/)
  assert.equal(walletRail.children[0].children[0], '$40')
  assert.equal(walletWide.children[0].children[0].children[0], '$40.00')
  assert.equal(walletWide.children[0].children[1], null)
  assert.equal(walletWide.children[0].children[2], null)
  assert.equal(walletWide.children[1], null)
})

test('expanded subscription portals a larger timing tooltip to the card right', () => {
  const now = Date.parse('2026-08-22T19:44:06Z')
  const state = {
    data: {
      displayName: 'Relay', mode: 'subscription', scope: 'weekly', remaining: 290, total: 500,
      spent: 210, percent: 58, unit: 'USD', planName: 'Pro',
      expiresAt: '2026-09-18T19:39:22.033831+08:00', resetAt: '2026-08-26T13:56:11.496Z',
    },
    loading: false,
    error: null,
  }
  const tags = []
  const documentObject = {
    body: {
      appendChild(tag) { tags.push(tag) },
    },
    createElement(type) {
      assert.equal(type, 'span')
      const tag = {
        style: {}, dataset: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value },
        getBoundingClientRect() { return { width: 280, height: 33 } },
        remove() {
          const index = tags.indexOf(this)
          if (index >= 0) tags.splice(index, 1)
        },
      }
      return tag
    },
  }
  const fakeDate = { now: () => now, parse: Date.parse }
  const wide = renderIndicator(state, true, {
    Date: fakeDate,
    document: documentObject,
    window: { innerWidth: 748, innerHeight: 484 },
  })
  const rail = renderIndicator(state, false, { Date: fakeDate })
  const expected = '剩余26天（2026/09/18 19:39） 3d18h后重置'
  const card = { right: 268, top: 378, height: 50 }

  assert.equal(wide.props.title, undefined)
  assert.equal(wide.children.length, 2)
  assert.equal(typeof wide.props.onMouseEnter, 'function')
  assert.equal(typeof wide.props.onMouseLeave, 'function')
  wide.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => card } })
  assert.equal(tags.length, 1)
  assert.equal(tags[0].className, 'relay-balance__timing')
  assert.equal(tags[0].attributes.role, 'tooltip')
  assert.equal(tags[0].textContent, expected)
  assert.equal(tags[0].style.left, '276px')
  assert.equal(tags[0].style.top, '386.5px')
  assert.equal(tags[0].dataset.visible, 'true')
  wide.props.onMouseLeave()
  assert.equal(tags.length, 0)

  assert.equal(rail.props.title, undefined)
  assert.equal(rail.props.onMouseEnter, undefined)
  assert.match(source, /position:fixed/)
  assert.match(source, /font:500 13px\/19px/)
  assert.match(source, /document\.body\.appendChild\(tag\)/)
  assert.equal(source.includes('title: timingText'), false)
})

test('unlimited rendering is explicit and remains accessible', () => {
  const state = {
    data: { displayName: 'Relay', mode: 'unlimited', scope: null, remaining: null, total: null, spent: 5, percent: null, unit: 'USD', planName: 'Pro' },
    loading: false,
    error: null,
  }
  const wide = renderIndicator(state, true)
  const rail = renderIndicator(state, false)
  assert.equal(wide.children[0].children[0].children[0], '∞')
  assert.equal(wide.children[0].children[2], null)
  assert.equal(wide.children[1], null)
  assert.equal(rail.children[0].children[0], '∞')
  assert.match(wide.props['aria-label'], /不限额/)
})

test('client source preserves lifecycle, generic Slot identity, and rc8 layout compatibility', () => {
  assert.match(source, /CLIENT_TIMEOUT_MS = 20_000/)
  assert.match(source, /visibilitychange/)
  assert.match(source, /manager\.abort\(\)/)
  assert.match(source, /current === record/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.footer\.action'/)
  assert.match(source, /function BalanceIndicator\(\{ wide \}\)/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.relay-balance--wide\)/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.relay-balance--rail\)/)
  assert.equal(source.includes('nbapi'), false)
  assert.equal(source.includes('NBAPI'), false)
  assert.equal(source.includes('hHd-Xa_'), false)
})

test('client uses write-only credential APIs and never calls an upstream URL directly', () => {
  for (const text of [source, built]) {
    assert.equal(text.includes('TEST_ONLY_SECRET_DO_NOT_USE'), false)
    assert.equal(text.includes('apiKeyEnv'), false)
    assert.equal(text.includes('authorization'), false)
    assert.equal(text.includes('Bearer '), false)
    assert.equal(text.includes('localStorage'), false)
    assert.match(text, /\/relay-balance\/status/)
    assert.match(text, /\/relay-balance\/test/)
    assert.match(text, /\/relay-balance\/save/)
    assert.match(text, /api\.credentials\.describe/)
    assert.equal(text.includes('api.credentials.set'), false)
    assert.match(text, /type: 'password'/)
    assert.match(text, /callRelayConnection\(fetch/)
  }
})

test('settings helper sends test and save payloads only to local Host routes', async () => {
  const seen = []
  const data = { mode: 'quota', remaining: 40, total: 100, percent: 40, unit: 'USD' }
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
  }
  assert.deepEqual(await clientExports.callRelayConnection(fetchImpl, '/relay-balance/test', {
    baseURL: 'https://relay.test/v1', apiKey: 'SECRET',
  }), data)
  assert.deepEqual(await clientExports.callRelayConnection(fetchImpl, '/relay-balance/save', {
    baseURL: 'https://relay.test/v1', apiKey: 'SECRET', expectedRevision: 7,
  }), data)
  assert.deepEqual(seen.map((entry) => entry.url), ['/relay-balance/test', '/relay-balance/save'])
  assert.ok(seen.every((entry) => entry.init.method === 'POST' && entry.init.credentials === 'same-origin'))
  assert.equal(JSON.parse(seen[1].init.body).expectedRevision, 7)
})

test('Client apply owns styles and registers both sidebar and settings entries', () => {
  const appended = []
  const removed = []
  const documentObject = {
    createElement(type) {
      assert.equal(type, 'style')
      return { dataset: {}, textContent: '', remove() { removed.push(this) } }
    },
    head: { appendChild(node) { appended.push(node) } },
  }
  let styleDispose
  const injected = new Map()
  const registrations = []
  const scope = { getSnapshot() {}, subscribe() {} }
  const client = evaluateSource({}, { document: documentObject })
  client.apply({
    effect(factory, description) {
      assert.equal(description, 'relay-balance: styles')
      styleDispose = factory()
    },
    settingsScope: {
      bind(options) { assert.equal(options.namespace, 'dsh-relay-balance'); return scope },
    },
    connection: { api: { credentials: { describe() {} } } },
    slots: {
      inject(name, factory) { injected.set(name, factory) },
      register(options, value) { registrations.push({ options, value }); return () => {} },
    },
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.plugin, 'dsh-relay-balance')
  assert.match(appended[0].textContent, /\.relay-balance/)
  assert.match(appended[0].textContent, /\.relay-settings/)
  injected.get('sidebar.footer.action')()
  injected.get('settings.section')()
  assert.equal(registrations[0].options.id, 'relay-balance')
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.label, '中转额度')
  assert.equal(registrations[0].value, client.BalanceIndicator)
  assert.equal(registrations[1].options.name, 'settings.section')
  assert.equal(registrations[1].options.label, 'Relay Balance')
  assert.equal(typeof registrations[1].value, 'function')
  styleDispose()
  assert.deepEqual(removed, appended)
})

test('Client compatibility check rejects incomplete required services', () => {
  assert.throws(() => clientExports.apply({ slots: {}, effect() {} }), /slots\.inject.*slots\.register/)
  assert.throws(() => clientExports.apply({ slots: { inject() {}, register() {} }, effect() {} }), /settingsScope\.bind/)
})
