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
          assert.equal(definition.id, 'dsh-nbapi-balance')
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

const clientExports = evaluateSource()

test('generated client artifact exactly matches the source-of-truth build rule', () => {
  assert.equal(built, renderClientBundle(source))
  assert.equal(built.includes('\r'), false)
})

test('actual generated bundle exports the approved helpers', () => {
  const bundledExports = evaluateBundle()
  assert.equal(bundledExports.toneOf(9.99), 'danger')
  assert.equal(bundledExports.toneOf(10), 'warning')
  assert.equal(bundledExports.toneOf(30), 'warning')
  assert.equal(bundledExports.toneOf(30.01), 'healthy')
  assert.equal(bundledExports.money(12.345, 'USD'), '$12.35')
  assert.equal(typeof bundledExports.createBalanceRequestManager, 'function')
})

test('client request manager deduplicates refreshes and aborts without a false error', async () => {
  const requests = []
  const loading = []
  const successes = []
  const errors = []
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl(_url, init) {
      return new Promise((resolve, reject) => {
        const request = { init, resolve, reject }
        requests.push(request)
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted request must stay hidden')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    createController: () => new AbortController(),
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

  manager.abort()
  assert.equal(requests[0].init.signal.aborted, true)
  const second = manager.refresh()
  assert.notEqual(second, first)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  assert.equal(await first, null)
  assert.deepEqual(errors, [])

  assert.equal(manager.refresh(), second, 'an older request must not clear the newer record')
  const data = { remaining: 1, total: 2, percent: 50, unit: 'USD' }
  requests[1].resolve({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
  assert.deepEqual(await second, data)
  assert.deepEqual(successes, [data])
  assert.equal(loading.length, 2)
})

test('client request manager reports genuine network failures', async () => {
  const errors = []
  const manager = clientExports.createBalanceRequestManager({
    fetchImpl: async () => { throw new Error('visible network failure') },
    createController: () => new AbortController(),
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
  const manager = {
    refresh() { refreshes += 1 },
    abort() { aborts += 1 },
  }
  const windowObject = {
    setInterval(callback, delay) { intervalCallback = callback; intervalDelay = delay; return 42 },
    clearInterval(id) { cleared = id },
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
  assert.equal(refreshes, 3)
  documentObject.visibilityState = 'hidden'
  intervalCallback()
  visibilityHandler()
  assert.equal(refreshes, 3)

  dispose()
  assert.equal(cleared, 42)
  assert.equal(removedHandler, visibilityHandler)
  assert.equal(aborts, 1)
})

test('BalanceIndicator renders distinct wide and rail structures and stale data', () => {
  function render(state, wide) {
    const react = {
      useState: () => [state, () => {}],
      useRef: (value) => ({ current: value }),
      useCallback: (callback) => callback,
      useEffect() {},
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    }
    return evaluateSource(react).BalanceIndicator({ wide })
  }

  const staleState = {
    data: { remaining: 40, total: 100, percent: 40, unit: 'USD', planName: '测试套餐' },
    loading: false,
    error: 'temporary failure',
  }
  const wide = render(staleState, true)
  const rail = render(staleState, false)
  assert.match(wide.props.className, /nbapi-balance--wide/)
  assert.match(rail.props.className, /nbapi-balance--rail/)
  assert.equal(typeof wide.props.onClick, 'function')
  assert.equal(typeof rail.props.onClick, 'function')
  assert.match(wide.props.title, /数据可能已过期/)
  assert.match(wide.children[1].children[0], /剩余 \$40\.00 \/ 总额 \$100\.00/)
  assert.equal(rail.children[0].children[0], '40')
  assert.match(wide.children[0].children[2].props.className, /stale/)
})

test('client source preserves refresh, stale-data, cleanup, Slot, and wide behavior', () => {
  assert.match(source, /60_000/)
  assert.match(source, /visibilitychange/)
  assert.match(source, /installRefreshLifecycle\(manager\.current, window, document\)/)
  assert.match(source, /manager\.abort\(\)/)
  assert.match(source, /new AbortController\(\)/)
  assert.match(source, /current === record/)
  assert.match(source, /if \(!controller\.signal\.aborted\) onError/)
  assert.match(source, /previous\) => \(\{ \.\.\.previous, loading: false, error: message \}\)/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.footer\.action'/)
  assert.match(source, /function BalanceIndicator\(\{ wide \}\)/)
  assert.match(source, /if \(!wide\)/)
  assert.match(source, /conic-gradient/)
  assert.match(source, /flex:0 0 100%/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.nbapi-balance--wide\)\{flex-wrap:wrap/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.nbapi-balance--rail\)\{flex-direction:column;align-items:center/)
  assert.equal(/hHd-Xa_|_[A-Za-z0-9]{5,}_/.test(source), false)
})

test('client contains no credential metadata or direct upstream access', () => {
  for (const text of [source, built]) {
    assert.equal(text.includes('TEST_ONLY_SECRET_DO_NOT_USE'), false)
    assert.equal(text.includes('TEST_ONLY_CREDENTIAL_REF'), false)
    assert.equal(text.includes('apiKeyEnv'), false)
    assert.equal(text.includes('authorization'), false)
    assert.equal(text.includes('Bearer '), false)
    assert.equal(/https:\/\//i.test(text), false)
    assert.match(text, /\/nbapi-balance\/status/)
  }
})

test('Client compatibility check clearly rejects an incomplete slots service', () => {
  assert.throws(() => clientExports.apply({ slots: {}, effect() {} }), /slots\.inject.*slots\.register/)
})

test('real client helpers match the approved threshold and amount policy', () => {
  assert.equal(clientExports.toneOf(9.99), 'danger')
  assert.equal(clientExports.toneOf(10), 'warning')
  assert.equal(clientExports.toneOf(30), 'warning')
  assert.equal(clientExports.toneOf(30.01), 'healthy')
  assert.equal(clientExports.money(12.345, 'USD'), '$12.35')
  assert.equal(clientExports.money(12.5, 'CNY'), '12.50 CNY')
})
