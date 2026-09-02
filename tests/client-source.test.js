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
          assert.equal(definition.id, 'dsh-relay-overview')
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

function historyFixture() {
  const start = Date.parse('2026-07-22T00:00:00.000Z')
  const days = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    actualCost: 0,
    requests: 0,
    totalTokens: 0,
  }))
  days[27] = { date: '2026-08-18', actualCost: 0.0042, requests: 2, totalTokens: 320 }
  days[29] = { date: '2026-08-20', actualCost: 1.25, requests: 12, totalTokens: 45_000 }
  return {
    unit: 'USD', timeZone: 'Asia/Shanghai', from: '2026-07-22', through: '2026-08-20',
    days,
    summary: { actualCost: 999, requests: 999, totalTokens: 999 },
    modelUsage: {
      totalRequests: 14,
      models: [
        { model: 'claude-sonnet-4-6', requests: 6 },
        { model: 'gpt-5', requests: 3 },
        { model: 'gemini-2.5-pro', requests: 2 },
        { model: 'deepseek-v3', requests: 1 },
        { model: 'grok-4', requests: 1 },
      ],
      otherRequests: 1,
    },
    fetchedAt: '2026-08-20T00:00:00.000Z',
  }
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

test('history decoder accepts exactly 30 consecutive dates and recomputes public summaries', () => {
  const decoded = clientExports.decodeHistoryData(historyFixture())
  assert.equal(decoded.days.length, 30)
  assert.deepEqual({ ...decoded.summary }, { actualCost: 1.2542, requests: 14, totalTokens: 45_320 })
  assert.deepEqual(JSON.parse(JSON.stringify(decoded.modelUsage)), historyFixture().modelUsage)
  assert.throws(() => clientExports.decodeHistoryData({ ...historyFixture(), timeZone: 'UTC' }), /无效/)
  assert.throws(() => clientExports.decodeHistoryData({ ...historyFixture(), days: historyFixture().days.slice(1) }), /无效/)
  assert.equal(clientExports.decodeHistoryData({ ...historyFixture(), modelUsage: { totalRequests: 14, models: [], otherRequests: 0 } }).modelUsage, null)
  assert.equal(clientExports.decodeHistoryData({
    ...historyFixture(),
    modelUsage: { totalRequests: 2, models: [{ model: 'dup', requests: 1 }, { model: 'dup', requests: 1 }], otherRequests: 0 },
  }).modelUsage, null)
  assert.equal(clientExports.decodeHistoryData({ ...historyFixture(), modelUsage: null }).modelUsage, null)
  const gap = historyFixture()
  gap.days[12] = { ...gap.days[12], date: '2026-08-01' }
  assert.throws(() => clientExports.decodeHistoryData(gap), /无效/)
})

test('history helpers provide compact precision, four ranked levels, and viewport-safe tooltips', () => {
  assert.equal(clientExports.historyMoney(0, 'USD'), '$0')
  assert.equal(clientExports.historyMoney(0.0042, 'USD'), '$0.0042')
  assert.equal(clientExports.historyMoney(1.25, 'USD'), '$1.25')
  assert.equal(clientExports.compactMetric(128_000), '128K')
  assert.equal(clientExports.compactMetric(1_250_000), '1.3M')
  const scale = clientExports.heatScale([
    { actualCost: 0 }, { actualCost: 1 }, { actualCost: 2 }, { actualCost: 3 }, { actualCost: 4 },
  ])
  assert.deepEqual(Array.from(scale), [1, 2, 3, 4])
  assert.deepEqual([0, 1, 2, 3, 4].map((value) => clientExports.heatLevel(value, scale)), [0, 1, 2, 3, 4])
  assert.equal(clientExports.heatLevel(7, [7]), 4)
  assert.deepEqual({ ...clientExports.heatmapTooltipPosition(
    { left: 100, top: 100, bottom: 116, width: 16 },
    { width: 180, height: 48 },
    { width: 400, height: 300 },
  ) }, { left: 18, top: 44 })
  assert.deepEqual({ ...clientExports.heatmapTooltipPosition(
    { left: 5, top: 4, bottom: 20, width: 16 },
    { width: 180, height: 48 },
    { width: 200, height: 100 },
  ) }, { left: 8, top: 28 })
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

test('history request manager uses only the same-origin Host route and deduplicates refreshes', async () => {
  const seen = []
  const successes = []
  const errors = []
  const timers = timerHarness()
  const manager = clientExports.createHistoryRequestManager({
    fetchImpl(url, init) {
      seen.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, data: historyFixture() }) })
    },
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading() {},
    onSuccess: (data) => successes.push(data),
    onError: (message) => errors.push(message),
  })
  const first = manager.refresh()
  assert.equal(manager.refresh(), first)
  const data = await first
  assert.equal(data.days.length, 30)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/relay-overview/history')
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.credentials, 'same-origin')
  assert.equal(seen[0].init.cache, 'no-store')
  assert.equal(successes.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(timers.count(), 0)
})

test('history request manager rejects malformed local data and permits retry', async () => {
  const errors = []
  let invalid = true
  const timers = timerHarness()
  const manager = clientExports.createHistoryRequestManager({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: invalid ? { days: [] } : historyFixture() }) }),
    createController: () => new AbortController(),
    setTimeoutImpl: timers.set,
    clearTimeoutImpl: timers.clear,
    onLoading() {}, onSuccess() {}, onError: (message) => errors.push(message),
  })
  assert.equal(await manager.refresh(), null)
  assert.deepEqual(errors, ['每日使用数据无效'])
  invalid = false
  assert.equal((await manager.refresh()).days.length, 30)
})

test('history timeout aborts a hung request while manual cleanup stays silent', async () => {
  const requests = []
  const errors = []
  const timers = timerHarness()
  const manager = clientExports.createHistoryRequestManager({
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
    onLoading() {}, onSuccess() {}, onError: (message) => errors.push(message),
  })
  const timedOut = manager.refresh()
  await Promise.resolve()
  assert.equal(timers.fireFirst(), 20_000)
  assert.equal(await timedOut, null)
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(errors, ['每日使用查询超时'])

  const disposed = manager.refresh()
  await Promise.resolve()
  manager.abort()
  assert.equal(await disposed, null)
  assert.equal(requests[1].signal.aborted, true)
  assert.deepEqual(errors, ['每日使用查询超时'])
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

test('history refresh lifecycle loads on entry, listens for saved-config refresh, and cleans up', () => {
  let refreshes = 0
  let aborts = 0
  let refreshHandler
  let removedHandler
  const manager = { refresh() { refreshes += 1 }, abort() { aborts += 1 } }
  const windowObject = {
    addEventListener(type, callback) { assert.equal(type, 'relay-overview:refresh'); refreshHandler = callback },
    removeEventListener(type, callback) { assert.equal(type, 'relay-overview:refresh'); removedHandler = callback },
  }
  const dispose = clientExports.installHistoryRefreshLifecycle(manager, windowObject)
  assert.equal(refreshes, 1)
  refreshHandler()
  assert.equal(refreshes, 2)
  dispose()
  assert.equal(removedHandler, refreshHandler)
  assert.equal(aborts, 1)
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
    addEventListener(type, callback) { assert.equal(type, 'relay-overview:refresh'); refreshEventHandler = callback },
    removeEventListener(type, callback) { assert.equal(type, 'relay-overview:refresh'); removedRefreshEventHandler = callback },
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

function renderWithState(componentName, state, props = {}, globals = {}) {
  let nextId = 0
  const react = {
    useState: () => [state, () => {}],
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    useEffect() {},
    useId: () => `relay-test-${++nextId}`,
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps || {}, children }),
  }
  return evaluateSource(react, globals)[componentName](props)
}

function renderIndicator(state, wide, globals = {}) {
  return renderWithState('BalanceIndicator', state, { wide }, globals)
}

function renderHeatmap(state, enabled = true, globals = {}) {
  return renderWithState('DailyUsageHeatmap', state, { enabled }, globals)
}

function renderModelUsage(usage, callbacks = {}) {
  return renderWithState('ModelUsageDonut', null, { usage, ...callbacks })
}

test('heatmap renders a Sunday-first 30-day grid, compact summary, zero days, and today outline', () => {
  const data = clientExports.decodeHistoryData(historyFixture())
  const heatmap = renderHeatmap({ data, loading: false, error: null })
  assert.match(heatmap.props.className, /relay-history/)
  assert.equal(heatmap.children[0].children[0].children[0], '近 30 天使用情况')
  assert.equal(heatmap.children[0].children[1].children[0].children[0], '$1.25 · 14 次 · 45.3K Token')
  const content = heatmap.children[1]
  const grid = content.children[0].children[0]
  const cells = grid.children[0]
  assert.equal(cells.length, 33, 'Wednesday range start needs three Sunday-first leading blanks plus 30 days')
  assert.equal(cells.slice(0, 3).every((cell) => cell.props.className === 'relay-history__blank'), true)
  const firstDay = cells[3]
  const sparseZeroDay = cells[4]
  const today = cells.at(-1)
  assert.match(firstDay.props.className, /relay-history__day--0/)
  assert.match(sparseZeroDay.props['aria-label'], /扣费 \$0，0 次请求，0 Token/)
  assert.match(today.props.className, /relay-history__day--4 is-today/)
  assert.match(today.props['aria-label'], /2026年8月20日，扣费 \$1\.25，12 次请求，45K Token/)
  assert.equal(typeof today.props.onPointerEnter, 'function')
  assert.equal(typeof today.props.onPointerDown, 'function')
  assert.equal(typeof today.props.onFocus, 'function')
  assert.equal(grid.props.role, 'group')
  assert.equal(typeof content.children[1].type, 'function')
  assert.equal(content.children[1].type.name, 'ModelUsageDonut')
  assert.deepEqual(JSON.parse(JSON.stringify(content.children[1].props.usage)), historyFixture().modelUsage)

  const waiting = renderHeatmap({ data: null, loading: false, error: null }, false)
  assert.equal(waiting.children[0].children[1].children[0].children[0], '等待配置')
  assert.equal(waiting.children[0].children[1].children[1].props.disabled, true)
  assert.equal(waiting.children[1].children[0], '保存中转 URL 和 API Key 后即可查看。')
  assert.match(source, /grid-template-rows:repeat\(7,24px\)/)
  assert.match(source, /grid-auto-columns:24px/)
  assert.match(source, /\.relay-history__day::before\{content:"";box-sizing:border-box;width:16px;height:16px/)
  assert.match(source, /--relay-history-accent:#3b82f6/)
  assert.match(source, /border-radius:3px;background:var\(--dsw-alias-border-l1\)/)
  assert.match(source, /\.relay-history__day--1::before\{background:color-mix\(in srgb,var\(--relay-history-accent\) 34%/)
  assert.match(source, /\.relay-history__day--2::before\{background:color-mix\(in srgb,var\(--relay-history-accent\) 52%/)
  assert.match(source, /\.relay-history__day--3::before\{background:color-mix\(in srgb,var\(--relay-history-accent\) 72%/)
  assert.match(source, /\.relay-history__day--4::before\{background:color-mix\(in srgb,var\(--relay-history-accent\) 92%/)
  assert.match(source, /\.relay-history__day--4::before\{background:Highlight;opacity:1\}/)
  assert.match(source, /\.relay-history__content\{display:grid;grid-template-columns:[^}]+align-items:center;gap:16px/)
  assert.match(source, /\.relay-history__calendar\{[^}]+justify-content:center/)
  assert.match(source, /@media \(max-width:620px\)\{\.relay-history__content\{grid-template-columns:1fr/)
})

test('model usage donut renders top five plus other with accessible pointer, touch, and keyboard details', () => {
  const usage = clientExports.decodeHistoryData(historyFixture()).modelUsage
  const events = []
  const donut = renderModelUsage(usage, {
    onDetailEvent: (action, _event, key, title, detail) => events.push({ action, key, title, detail }),
  })
  assert.equal(donut.props['aria-label'], '模型调用量')
  assert.equal(donut.props['aria-labelledby'], undefined)
  assert.equal(donut.children.some((child) => child?.type === 'h4'), false)
  const body = donut.children[0]
  const chart = body.children[0]
  const svg = chart.children[0]
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(svg.props.focusable, 'false')
  const segments = svg.children[1]
  assert.equal(segments.length, 6)
  assert.equal(segments[0].props.tabIndex, undefined)
  assert.equal(typeof segments[0].props.onPointerEnter, 'function')
  assert.equal(typeof segments[0].props.onPointerDown, 'function')
  assert.match(segments[0].props.style.strokeDasharray, /^42\.857/)
  assert.equal(segments[0].props.style.strokeDashoffset, 0)
  assert.match(segments[1].props.style.strokeDashoffset.toString(), /^-42\.857/)
  assert.equal(chart.children[1].children[0].children[0], '14')
  const legend = body.children[1].children[0]
  assert.equal(legend.length, 6)
  assert.equal(legend[5].children[0].children[1].children[0], '其他模型')
  assert.match(legend[5].children[0].props['aria-label'], /其他模型，1 次调用，占 7\.1%/)
  assert.equal(typeof legend[0].children[0].props.onFocus, 'function')
  assert.equal(typeof legend[0].children[0].props.onPointerDown, 'function')
  legend[0].children[0].props.onFocus({})
  assert.deepEqual(events[0], { action: 'show', key: 'model-0', title: 'claude-sonnet-4-6', detail: '6 次调用 · 43%' })
  legend[0].children[0].props.onBlur({})
  assert.equal(events[1].action, 'hide')
  let prevented = false
  let stopped = false
  segments[0].props.onPointerDown({ pointerType: 'touch', preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(events[2].action, 'toggle')
  assert.equal(prevented, true)
  assert.equal(stopped, true)

  const one = renderModelUsage({ totalRequests: 1_000_001, models: [{ model: 'dominant', requests: 1_000_000 }], otherRequests: 1 })
  const oneSegments = one.children[0].children[0].children[0].children[1]
  assert.match(oneSegments[0].props.style.strokeDasharray, /^99\.9999/)
  assert.match(one.children[0].children[1].children[0][1].children[0].props['aria-label'], /占 <0\.1%/)
  const single = renderModelUsage({ totalRequests: 1, models: [{ model: 'only', requests: 1 }], otherRequests: 0 })
  assert.equal(single.children[0].children[0].children[0].children[1][0].props.style.strokeDasharray, '100 0')

  const unavailable = renderModelUsage(null)
  assert.equal(unavailable.children[0].children[0], '中转站未提供模型统计')
  const empty = renderModelUsage({ totalRequests: 0, models: [], otherRequests: 0 })
  assert.equal(empty.children[0].children[0], '近 30 天暂无模型调用')
  assert.match(source, /\.relay-model\{[^}]+min-height:168px[^}]+justify-content:center/)
  assert.match(source, /\.relay-model__body\{[^}]+align-items:center/)
  assert.doesNotMatch(source, /\.relay-model h4\{/)
  assert.match(source, /\.relay-model__segment--1\{stroke:#3b82f6\}/)
  assert.match(source, /\.relay-model__segment--6\{stroke:#64748b\}/)
  assert.match(source, /\.relay-model__legend-button:focus-visible\{outline:2px solid var\(--relay-history-accent\)/)
  assert.match(source, /@media \(max-width:380px\)\{\.relay-model__body\{grid-template-columns:1fr/)
  assert.match(source, /\.relay-model__segment,\.relay-model__swatch\{forced-color-adjust:none\}/)
})

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

  assert.match(quotaWide.props.className, /relay-overview--wide/)
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

test('expanded and collapsed subscriptions portal a larger timing tooltip to the card right', () => {
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
  const rail = renderIndicator(state, false, {
    Date: fakeDate,
    document: documentObject,
    window: { innerWidth: 748, innerHeight: 484 },
  })
  const expected = '剩余26天（2026/09/18 19:39） 3d18h后重置'
  const card = { right: 268, top: 378, height: 50 }

  assert.equal(wide.props.title, undefined)
  assert.equal(wide.children.length, 2)
  assert.equal(typeof wide.props.onMouseEnter, 'function')
  assert.equal(typeof wide.props.onMouseLeave, 'function')
  wide.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => card } })
  assert.equal(tags.length, 1)
  assert.equal(tags[0].className, 'relay-overview__timing')
  assert.equal(tags[0].attributes.role, 'tooltip')
  assert.equal(tags[0].textContent, expected)
  assert.equal(tags[0].style.left, '276px')
  assert.equal(tags[0].style.top, '386.5px')
  assert.equal(tags[0].dataset.visible, 'true')
  wide.props.onMouseLeave()
  assert.equal(tags.length, 0)

  assert.equal(rail.props.title, undefined)
  assert.equal(typeof rail.props.onMouseEnter, 'function')
  assert.equal(typeof rail.props.onMouseLeave, 'function')
  rail.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ right: 56, top: 400, height: 32 }) } })
  assert.equal(tags.length, 1)
  assert.equal(tags[0].textContent, expected)
  assert.equal(tags[0].style.left, '64px')
  assert.equal(tags[0].style.top, '399.5px')
  rail.props.onMouseLeave()
  assert.equal(tags.length, 0)

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

test('client source preserves lifecycle, generic Slot identity, and Alpha5 Slot layout compatibility', () => {
  assert.match(source, /CLIENT_TIMEOUT_MS = 20_000/)
  assert.match(source, /visibilitychange/)
  assert.match(source, /manager\.abort\(\)/)
  assert.match(source, /current === record/)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.footer\.action'/)
  assert.match(source, /function BalanceIndicator\(\{ wide \}\)/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.relay-overview--wide\)/)
  assert.match(source, /:has\(> \[data-slot="sidebar\.footer\.action"\] > \.relay-overview--rail\)/)
  assert.equal(source.includes('nbapi'), false)
  assert.equal(source.includes('NBAPI'), false)
  assert.equal(source.includes('hHd-Xa_'), false)
})

test('client only describes credentials through Remote and never calls an upstream URL directly', () => {
  for (const text of [source, built]) {
    assert.equal(text.includes('TEST_ONLY_SECRET_DO_NOT_USE'), false)
    assert.equal(text.includes('apiKeyEnv'), false)
    assert.equal(text.includes('authorization'), false)
    assert.equal(text.includes('Bearer '), false)
    assert.equal(text.includes('localStorage'), false)
    assert.match(text, /\/relay-overview\/status/)
    assert.match(text, /\/relay-overview\/history/)
    assert.match(text, /\/relay-overview\/test/)
    assert.match(text, /\/relay-overview\/save/)
    assert.match(text, /remote\.credentials/)
    assert.match(text, /credentials\.describe\(refs\)/)
    assert.equal(text.includes('remote.credentials.set'), false)
    assert.equal(text.includes('connection.api.credentials'), false)
    assert.equal(text.includes('ctx.connection'), false)
    assert.match(text, /type: 'password'/)
    assert.match(text, /callRelayConnection\(fetch/)
  }
})

test('credential Remote receives positional refs and handles success, failure, and rejection', async () => {
  const refs = ['DSH_RELAY_OVERVIEW_TEST_A']
  const value = {
    DSH_RELAY_OVERVIEW_TEST_A: {
      configured: true,
      writable: true,
      source: 'local',
    },
  }
  const seen = []
  assert.equal(await clientExports.describeCredentialInfo({
    async describe(input) {
      seen.push(input)
      return { ok: true, value }
    },
  }, refs), value)
  assert.deepEqual(seen, [refs])

  await assert.rejects(() => clientExports.describeCredentialInfo({
    async describe() {
      return {
        ok: false,
        error: {
          code: 'gateway/internal',
          message: 'Credential provider is unavailable',
          details: {},
        },
      }
    },
  }, refs), /Credential provider is unavailable/)
  await assert.rejects(() => clientExports.describeCredentialInfo({
    async describe() { throw new Error('Remote namespace is not mounted') },
  }, refs), /Remote namespace is not mounted/)
  assert.throws(() => clientExports.credentialDescribeValue({ ok: true, value: [] }), /无法查询 Credential 状态/)
})

test('settings helper sends test and save payloads only to local Host routes', async () => {
  const seen = []
  const data = { mode: 'quota', remaining: 40, total: 100, percent: 40, unit: 'USD' }
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
  }
  assert.deepEqual(await clientExports.callRelayConnection(fetchImpl, '/relay-overview/test', {
    baseURL: 'https://relay.test/v1', apiKey: 'SECRET',
  }), data)
  assert.deepEqual(await clientExports.callRelayConnection(fetchImpl, '/relay-overview/save', {
    baseURL: 'https://relay.test/v1', apiKey: 'SECRET', expectedRevision: 7,
  }), data)
  assert.deepEqual(seen.map((entry) => entry.url), ['/relay-overview/test', '/relay-overview/save'])
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
      assert.equal(description, 'relay-overview: styles')
      styleDispose = factory()
    },
    settingsScope: {
      bind(options) { assert.equal(options.namespace, 'dsh-relay-overview'); return scope },
    },
    remote: { credentials: { describe() {} } },
    slots: {
      inject(name, factory) { injected.set(name, factory) },
      register(options, value) { registrations.push({ options, value }); return () => {} },
    },
  })
  assert.deepEqual(Array.from(client.inject), ['slots', 'remote', 'remote.credentials', 'settingsScope'])
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.plugin, 'dsh-relay-overview')
  assert.match(appended[0].textContent, /\.relay-overview/)
  assert.match(appended[0].textContent, /\.relay-settings/)
  injected.get('sidebar.footer.action')()
  injected.get('settings.section')()
  assert.equal(registrations[0].options.id, 'relay-overview')
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.label, '中转概览')
  assert.equal(registrations[0].value, client.BalanceIndicator)
  assert.equal(registrations[1].options.name, 'settings.section')
  assert.equal(registrations[1].options.label, '中转概览')
  assert.equal(typeof registrations[1].value, 'function')
  assert.match(source, /React\.createElement\('h2', null, '中转概览'\)/)
  assert.equal(source.includes("'Relay Balance'"), false)
  styleDispose()
  assert.deepEqual(removed, appended)
})

test('Client compatibility check rejects incomplete required services', () => {
  assert.throws(() => clientExports.apply({ slots: {}, effect() {} }), /slots\.inject.*slots\.register/)
  assert.throws(() => clientExports.apply({ slots: { inject() {}, register() {} }, effect() {} }), /settingsScope\.bind/)
  assert.throws(() => clientExports.apply({
    slots: { inject() {}, register() {} },
    settingsScope: { bind() {} },
    effect() {},
  }), /remote\.credentials/)
  assert.throws(() => clientExports.apply({
    slots: { inject() {}, register() {} },
    settingsScope: { bind() {} },
    remote: {},
    effect() {},
  }), /remote\.credentials/)
})
