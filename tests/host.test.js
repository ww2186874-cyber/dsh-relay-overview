import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildUsageUrls,
  createBalanceReader,
  createStatusHandler,
  normalizePluginConfig,
  normalizeSub2ApiUsage,
  resolveRelayConfig,
} from '../lib/index.js'

const MAX_RESPONSE_BYTES = 1_048_576
const TEST_SECRET = 'TEST_ONLY_SECRET_DO_NOT_USE'
const TEST_BASE_URL = 'https://relay.test.invalid/v1'
const TEST_CREDENTIAL_REF = 'TEST_ONLY_CREDENTIAL_REF'
const FIXED_TIME = '2026-08-20T00:00:00.000Z'
const CONFIG = { providerId: 'test-relay', displayName: '测试中转', usagePath: 'auto', allowRemote: false }
const WALLET = {
  mode: 'unrestricted',
  isValid: true,
  unit: 'USD',
  planName: '钱包余额',
  remaining: 80,
  balance: 80,
  usage: { total: { actual_cost: 20 } },
}
const QUOTA = {
  mode: 'quota_limited',
  isValid: true,
  unit: 'USD',
  remaining: 80,
  quota: { limit: 100, used: 20, remaining: 80, unit: 'USD' },
  usage: { total: { actual_cost: 20 } },
}

function settingsValue() {
  return { providers: { 'test-relay': { baseURL: TEST_BASE_URL, apiKeyEnv: TEST_CREDENTIAL_REF } } }
}

function readerOptions(overrides = {}) {
  return {
    settings: { get: () => settingsValue() },
    credentials: { resolve: async () => ({ value: TEST_SECRET }) },
    config: CONFIG,
    now: () => new Date(FIXED_TIME),
    ...overrides,
  }
}

function jsonWithExactBytes(target) {
  const empty = JSON.stringify({ ...WALLET, padding: '' })
  const needed = target - Buffer.byteLength(empty)
  assert.ok(needed >= 0)
  const text = JSON.stringify({ ...WALLET, padding: 'x'.repeat(needed) })
  assert.equal(Buffer.byteLength(text), target)
  return text
}

function streamResponse(chunks, options = {}) {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      const value = chunks.shift()
      if (value === undefined) controller.close()
      else controller.enqueue(value)
    },
    cancel() { cancelled = true },
  })
  return {
    response: new Response(body, { status: options.status ?? 200, headers: options.headers }),
    wasCancelled: () => cancelled,
  }
}

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers },
    end(body) { this.body = body },
  }
}

async function publicResponse(readBalance, request = {}) {
  const response = responseRecorder()
  const { headers = {}, socket = {}, ...rest } = request
  await createStatusHandler(readBalance)({
    method: 'GET',
    ...rest,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress: '127.0.0.1', encrypted: false, ...socket },
  }, response)
  return response
}

function assertSafeError(error, code) {
  assert.equal(error?.code, code)
  const message = String(error?.message)
  assert.equal(message.includes(TEST_SECRET), false)
  assert.equal(message.includes(TEST_CREDENTIAL_REF), false)
  assert.equal(message.includes('sensitive-upstream-body'), false)
  return true
}

test('validates deploy configuration and resolves the selected provider', () => {
  assert.deepEqual(normalizePluginConfig(CONFIG), CONFIG)
  assert.throws(() => normalizePluginConfig({ ...CONFIG, providerId: '../bad' }), /providerId/)
  assert.throws(() => normalizePluginConfig({ ...CONFIG, usagePath: 'relative' }), /usagePath/)
  assert.deepEqual(resolveRelayConfig(settingsValue(), CONFIG), {
    ...CONFIG,
    usageURLs: [`${TEST_BASE_URL}/usage`, 'https://relay.test.invalid/usage'],
    apiKeyEnv: TEST_CREDENTIAL_REF,
  })
  assert.throws(() => resolveRelayConfig({ providers: {} }, CONFIG), /test-relay/)
})

test('builds safe Sub2API usage candidates and rejects unsafe base URLs', () => {
  assert.deepEqual(buildUsageUrls('https://relay.test.invalid/v1'), [
    'https://relay.test.invalid/v1/usage',
    'https://relay.test.invalid/usage',
  ])
  assert.deepEqual(buildUsageUrls('https://relay.test.invalid/api', '/v1/usage'), ['https://relay.test.invalid/v1/usage'])
  assert.throws(() => buildUsageUrls('http://relay.test.invalid/v1'), /HTTPS/)
  assert.throws(() => buildUsageUrls('https://user:pass@relay.test.invalid/v1'), /不得包含凭据/)
  assert.throws(() => buildUsageUrls('https://relay.test.invalid/v1?token=bad'), /查询参数/)
})

test('normalizes a real key quota without inventing its total', () => {
  const result = normalizeSub2ApiUsage(QUOTA, { displayName: CONFIG.displayName, fetchedAt: FIXED_TIME })
  assert.deepEqual(result, {
    adapter: 'sub2api',
    displayName: CONFIG.displayName,
    planName: '',
    unit: 'USD',
    mode: 'quota',
    remaining: 80,
    spent: 20,
    total: 100,
    percent: 80,
    scope: 'total',
    resetAt: null,
    fetchedAt: FIXED_TIME,
  })
})

test('uses the tightest key limit when quota and rolling limits coexist', () => {
  const result = normalizeSub2ApiUsage({
    ...QUOTA,
    rate_limits: [
      { window: '5h', limit: 10, used: 8, remaining: 2, reset_at: '2026-08-20T01:00:00Z' },
      { window: '1d', limit: 50, used: 5, remaining: 45 },
    ],
  }, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'rate-limit')
  assert.equal(result.scope, '5h')
  assert.equal(result.remaining, 2)
  assert.equal(result.total, 10)
  assert.equal(result.percent, 20)
  assert.equal(result.resetAt, '2026-08-20T01:00:00Z')
})

test('keeps wallet balance separate from current-key cumulative spend', () => {
  const result = normalizeSub2ApiUsage(WALLET, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'wallet')
  assert.equal(result.remaining, 80)
  assert.equal(result.spent, 20)
  assert.equal(result.total, null)
  assert.equal(result.percent, null)
})

test('normalizes subscription windows using the smallest remaining allowance', () => {
  const result = normalizeSub2ApiUsage({
    mode: 'unrestricted',
    isValid: true,
    planName: 'Pro',
    remaining: 5,
    unit: 'USD',
    subscription: {
      daily_usage_usd: 2,
      daily_limit_usd: 10,
      weekly_usage_usd: 45,
      weekly_limit_usd: 50,
      monthly_usage_usd: 20,
      monthly_limit_usd: 100,
    },
  }, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'subscription')
  assert.equal(result.scope, 'weekly')
  assert.equal(result.remaining, 5)
  assert.equal(result.total, 50)
  assert.equal(result.percent, 10)
})

test('represents unlimited subscriptions without a fabricated percentage', () => {
  const result = normalizeSub2ApiUsage({
    mode: 'unrestricted', isValid: true, remaining: -1, unit: 'USD',
    subscription: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null },
    usage: { total: { actual_cost: 12 } },
  }, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'unlimited')
  assert.equal(result.remaining, null)
  assert.equal(result.total, null)
  assert.equal(result.percent, null)
  assert.equal(result.spent, 12)
})

test('rejects malformed Sub2API responses and inconsistent limits', () => {
  assert.throws(() => normalizeSub2ApiUsage({ ...WALLET, isValid: false }), /无效/)
  assert.throws(() => normalizeSub2ApiUsage({ ...WALLET, remaining: -2, balance: -2 }), /remaining/)
  assert.throws(() => normalizeSub2ApiUsage({ ...QUOTA, quota: { limit: 10, used: 1, remaining: 11 } }), /超过/)
  assert.throws(() => normalizeSub2ApiUsage({ ...QUOTA, quota: { limit: 100, used: 1000, remaining: 80 } }), /不一致/)
  assert.throws(() => normalizeSub2ApiUsage({ ...QUOTA, quota: { limit: 100, used: 19, remaining: 80 } }), /不一致/)
  assert.doesNotThrow(() => normalizeSub2ApiUsage({ ...QUOTA, quota: { limit: 100, used: 20 + 1e-10, remaining: 80 } }))
  const overage = normalizeSub2ApiUsage({ ...QUOTA, quota: { limit: 100, used: 101, remaining: 0 } })
  assert.equal(overage.spent, 101)
  assert.equal(overage.percent, 0)
  assert.throws(() => normalizeSub2ApiUsage({ mode: 'quota_limited', isValid: true }), /未返回/)
})

test('reader uses selected provider, resolves credentials per operation, and exposes no secret', async () => {
  let credentialReads = 0
  let fetchReads = 0
  const reader = createBalanceReader(readerOptions({
    credentials: { resolve: async (ref) => {
      assert.equal(ref, TEST_CREDENTIAL_REF)
      credentialReads += 1
      return { value: TEST_SECRET }
    } },
    fetchImpl: async (url, init) => {
      fetchReads += 1
      assert.equal(url, `${TEST_BASE_URL}/usage`)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, `Bearer ${TEST_SECRET}`)
      assert.ok(init.signal instanceof AbortSignal)
      return new Response(JSON.stringify(QUOTA), { status: 200 })
    },
  }))
  const first = await reader()
  const second = await reader()
  assert.equal(credentialReads, 2)
  assert.equal(fetchReads, 2)
  assert.equal(first.displayName, CONFIG.displayName)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first).includes(TEST_SECRET), false)
})

test('reader single-flights concurrent status requests', async () => {
  let resolveFetch
  let credentialReads = 0
  let fetchReads = 0
  const reader = createBalanceReader(readerOptions({
    credentials: { resolve: async () => { credentialReads += 1; return { value: TEST_SECRET } } },
    fetchImpl: async () => {
      fetchReads += 1
      return new Promise((resolve) => { resolveFetch = resolve })
    },
  }))
  const first = reader()
  const duplicate = reader()
  assert.equal(first, duplicate)
  await Promise.resolve()
  await Promise.resolve()
  resolveFetch(new Response(JSON.stringify(QUOTA), { status: 200 }))
  assert.equal((await first).total, 100)
  assert.equal(credentialReads, 1)
  assert.equal(fetchReads, 1)
})

test('auto endpoint detection retries only a 404 candidate', async () => {
  const urls = []
  const reader = createBalanceReader(readerOptions({
    fetchImpl: async (url) => {
      urls.push(url)
      return urls.length === 1
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(WALLET), { status: 200 })
    },
  }))
  assert.equal((await reader()).mode, 'wallet')
  assert.deepEqual(urls, [`${TEST_BASE_URL}/usage`, 'https://relay.test.invalid/usage'])
})

test('rejects declared Content-Length above one MiB before reading', async () => {
  let bodyRead = false
  let bodyCancelled = false
  const response = {
    ok: true, status: 200, redirected: false,
    headers: { get: (name) => name === 'content-length' ? String(MAX_RESPONSE_BYTES + 1) : null },
    body: { cancel: async () => { bodyCancelled = true } },
    text: async () => { bodyRead = true; return JSON.stringify(WALLET) },
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-response-too-large'))
  assert.equal(bodyRead, false)
  assert.equal(bodyCancelled, true)
})

test('cancels a stream as soon as it exceeds one MiB', async () => {
  const chunks = [new Uint8Array(MAX_RESPONSE_BYTES), new Uint8Array([0x78]), new Uint8Array([0x79])]
  let reads = 0
  let cancelled = false
  const response = {
    ok: true, status: 200, redirected: false, headers: { get: () => null },
    body: { getReader() { return {
      async read() { const value = chunks[reads++]; return value === undefined ? { done: true } : { done: false, value } },
      async cancel() { cancelled = true }, releaseLock() {},
    } } },
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-response-too-large'))
  assert.equal(cancelled, true)
  assert.equal(reads, 2)
})

test('accepts valid JSON exactly at the one MiB byte limit', async () => {
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => new Response(jsonWithExactBytes(MAX_RESPONSE_BYTES), { status: 200 }) }))
  assert.equal((await reader()).remaining, WALLET.remaining)
})

test('decodes chunked UTF-8 and rejects only actual decoder failures', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ ...WALLET, planName: '测试套餐' }))
  const multibyteStart = encoded.findIndex((value) => value >= 0xe0)
  const good = streamResponse([
    encoded.slice(0, multibyteStart + 1), encoded.slice(multibyteStart + 1, multibyteStart + 2), encoded.slice(multibyteStart + 2),
  ])
  assert.equal((await createBalanceReader(readerOptions({ fetchImpl: async () => good.response }))()).planName, '测试套餐')

  const bad = streamResponse([
    new TextEncoder().encode('{"isValid":true,"remaining":1,"planName":"'),
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode('keep-stream-open'),
  ])
  await assert.rejects(createBalanceReader(readerOptions({ fetchImpl: async () => bad.response }))(), (error) => assertSafeError(error, 'invalid-upstream-data'))
  assert.equal(bad.wasCancelled(), true)
})

test('maps reader transport errors to sanitized upstream-unavailable', async () => {
  const transportMessage = `TEST_ONLY_STREAM_FAILURE_${TEST_SECRET}`
  const response = {
    ok: true, status: 200, redirected: false, headers: { get: () => null },
    body: { getReader() { return {
      async read() { throw new TypeError(transportMessage) }, async cancel() {}, releaseLock() {},
    } } },
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => {
    assert.equal(error?.message, '暂时无法读取中转站响应')
    return assertSafeError(error, 'upstream-unavailable')
  })
})

test('keeps redirect:error and defensively rejects redirected and 3xx responses', async () => {
  const generic = createBalanceReader(readerOptions({ fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error')
    throw new TypeError(`redirect rejected ${TEST_SECRET}`)
  } }))
  await assert.rejects(generic(), (error) => assertSafeError(error, 'upstream-unavailable'))

  const redirected = createBalanceReader(readerOptions({ fetchImpl: async () => ({
    ok: true, status: 200, redirected: true, headers: { get: () => null }, body: null,
    text: async () => `sensitive-upstream-body-${TEST_SECRET}`,
  }) }))
  await assert.rejects(redirected(), (error) => assertSafeError(error, 'upstream-redirect-rejected'))

  const threeHundred = createBalanceReader(readerOptions({ fetchImpl: async () => new Response(null, { status: 302 }) }))
  await assert.rejects(threeHundred(), (error) => assertSafeError(error, 'upstream-redirect-rejected'))
})

test('maps timeout, auth, malformed JSON, and credential failures safely', async () => {
  const timeout = new Error(`timeout ${TEST_SECRET}`)
  timeout.name = 'TimeoutError'
  await assert.rejects(createBalanceReader(readerOptions({ fetchImpl: async () => { throw timeout } }))(), (error) => assertSafeError(error, 'upstream-timeout'))
  await assert.rejects(createBalanceReader(readerOptions({ fetchImpl: async () => new Response(TEST_SECRET, { status: 401 }) }))(), (error) => assertSafeError(error, 'upstream-auth-failed'))
  await assert.rejects(createBalanceReader(readerOptions({ fetchImpl: async () => new Response(`sensitive-upstream-body-${TEST_SECRET}`, { status: 200 }) }))(), (error) => assertSafeError(error, 'invalid-upstream-data'))
  await assert.rejects(createBalanceReader(readerOptions({ credentials: { resolve: async () => undefined } }))(), (error) => assertSafeError(error, 'credential-not-configured'))
  await assert.rejects(createBalanceReader(readerOptions({ credentials: { resolve: async () => { throw new Error(TEST_SECRET) } } }))(), (error) => assertSafeError(error, 'credential-unavailable'))
})

test('status handler emits success, 405, same-origin checks, and sanitized errors', async () => {
  const success = await publicResponse(async () => normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME }))
  assert.equal(success.statusCode, 200)
  assert.equal(JSON.parse(success.body).ok, true)
  assert.match(success.headers['cache-control'], /no-store/)

  const method = responseRecorder()
  await createStatusHandler(async () => null)({
    method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' },
  }, method)
  assert.equal(method.statusCode, 405)
  assert.equal(method.headers.allow, 'GET')

  const remote = await publicResponse(async () => null, { socket: { remoteAddress: '192.0.2.10' } })
  assert.equal(remote.statusCode, 403)
  assert.equal(JSON.parse(remote.body).error.code, 'remote-access-disabled')

  const proxied = await publicResponse(async () => null, {
    headers: { 'x-forwarded-for': '192.0.2.10' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  assert.equal(proxied.statusCode, 403)

  const reboundAuthority = await publicResponse(async () => null, {
    headers: { host: 'attacker.test.invalid' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  assert.equal(reboundAuthority.statusCode, 403)

  const remoteAllowedResponse = responseRecorder()
  await createStatusHandler(async () => normalizeSub2ApiUsage(QUOTA), { allowRemote: true })({
    method: 'GET', headers: { host: 'relay.test.invalid' }, socket: { remoteAddress: '192.0.2.10' },
  }, remoteAllowedResponse)
  assert.equal(remoteAllowedResponse.statusCode, 200)

  const crossSite = await publicResponse(async () => null, {
    headers: { host: '127.0.0.1:3080', origin: 'https://cross-site.test.invalid', 'sec-fetch-site': 'cross-site' },
    socket: { encrypted: false },
  })
  assert.equal(crossSite.statusCode, 403)

  const sameOrigin = await publicResponse(async () => normalizeSub2ApiUsage(QUOTA), {
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    socket: { encrypted: false },
  })
  assert.equal(sameOrigin.statusCode, 200)

  const failure = await publicResponse(async () => { throw new Error(`sensitive-upstream-body-${TEST_SECRET}`) })
  assert.equal(failure.statusCode, 500)
  assert.equal(failure.body.includes(TEST_SECRET), false)
})

test('apply registers the generic route and validates required Host services', () => {
  let registered
  const ctx = {
    settings: { get() { return settingsValue() } },
    credentials: { resolve() {} },
    webServer: { register(options) { registered = options; return () => {} } },
    effect(callback) { return callback() },
  }
  apply(ctx, CONFIG)
  assert.equal(registered.path, '/relay-balance/status')
  assert.equal(registered.kind, 'exact')
  assert.throws(() => createBalanceReader({ settings: {}, credentials: { resolve() {} } }), /settings\.get/)
  assert.throws(() => apply({ settings: { get() {} }, credentials: { resolve() {} }, webServer: {} }, CONFIG), /webServer\.register/)
})
