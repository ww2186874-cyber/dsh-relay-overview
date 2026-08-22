import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  apply,
  buildUsageUrls,
  createBalanceReader,
  createConnectionTester,
  createConnectionTestHandler,
  createConnectionSaver,
  createConnectionSaveHandler,
  createStatusHandler,
  normalizePluginConfig,
  normalizeRelaySettings,
  normalizeSub2ApiUsage,
  resolveRelayConfig,
} from '../lib/index.js'

const MAX_RESPONSE_BYTES = 1_048_576
const TEST_SECRET = 'TEST_ONLY_SECRET_DO_NOT_USE'
const TEST_BASE_URL = 'https://relay.test.invalid/v1'
const TEST_CREDENTIAL_REF = 'TEST_ONLY_CREDENTIAL_REF'
const FIXED_TIME = '2026-08-20T00:00:00.000Z'
const CONFIG = { providerId: 'test-relay', displayName: '测试中转', baseURL: '', credentialRef: '', usagePath: 'auto', allowRemote: false }
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

function managedRefs(baseURL) {
  const digest = createHash('sha256').update(new URL(baseURL).origin).digest('hex').slice(0, 32).toUpperCase()
  return [`DSH_RELAY_BALANCE_${digest}_A`, `DSH_RELAY_BALANCE_${digest}_B`]
}

function readerOptions(overrides = {}) {
  return {
    settings: { get: (ns) => ns === 'llm-pi-ai' ? settingsValue() : undefined },
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

test('validates deploy configuration and resolves plugin, composition, and legacy provider sources', () => {
  assert.deepEqual(normalizePluginConfig(CONFIG), CONFIG)
  assert.throws(() => normalizePluginConfig({ ...CONFIG, providerId: '../bad' }), /providerId/)
  assert.throws(() => normalizePluginConfig({ ...CONFIG, usagePath: 'relative' }), /usagePath/)
  assert.throws(() => normalizePluginConfig({ ...CONFIG, baseURL: TEST_BASE_URL }), /set together/)
  assert.deepEqual(normalizeRelaySettings({ baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' }), {
    baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto',
  })
  assert.deepEqual(resolveRelayConfig(settingsValue(), CONFIG), {
    displayName: CONFIG.displayName,
    usageURLs: [`${TEST_BASE_URL}/usage`, 'https://relay.test.invalid/usage'],
    credentialRef: TEST_CREDENTIAL_REF,
    source: 'provider',
  })
  assert.deepEqual(resolveRelayConfig(settingsValue(), CONFIG, {
    baseURL: 'https://direct.test.invalid/v1', credentialRef: 'DIRECT_KEY', usagePath: 'auto',
  }), {
    displayName: CONFIG.displayName,
    usageURLs: ['https://direct.test.invalid/v1/usage', 'https://direct.test.invalid/usage'],
    credentialRef: 'DIRECT_KEY',
    source: 'plugin',
  })
  assert.throws(() => resolveRelayConfig({ providers: {} }, CONFIG), /Relay Balance 设置/)
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
      weekly_window_start: '2026-08-19T21:56:11.496236+08:00',
      monthly_usage_usd: 20,
      monthly_limit_usd: 100,
      expires_at: '2026-09-18T19:39:22.033831+08:00',
    },
  }, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'subscription')
  assert.equal(result.scope, 'weekly')
  assert.equal(result.remaining, 5)
  assert.equal(result.total, 50)
  assert.equal(result.percent, 10)
  assert.equal(result.resetAt, '2026-08-26T13:56:11.496Z')
  assert.equal(result.expiresAt, '2026-09-18T19:39:22.033831+08:00')
})

test('derives a subscription monthly reset from its 30-day rolling window', () => {
  const result = normalizeSub2ApiUsage({
    mode: 'unrestricted',
    isValid: true,
    subscription: {
      monthly_usage_usd: 10,
      monthly_limit_usd: 100,
      monthly_window_start: '2026-02-01T00:00:00Z',
      expires_at: '2026-04-01T00:00:00Z',
    },
  }, { fetchedAt: FIXED_TIME })
  assert.equal(result.mode, 'subscription')
  assert.equal(result.scope, 'monthly')
  assert.equal(result.resetAt, '2026-03-03T00:00:00.000Z')
  assert.equal(result.expiresAt, '2026-04-01T00:00:00Z')
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
  assert.throws(() => normalizeSub2ApiUsage({
    mode: 'unrestricted', isValid: true,
    subscription: { weekly_usage_usd: 1, weekly_limit_usd: 10, weekly_window_start: 'not-a-time' },
  }), /weekly_window_start/)
  assert.throws(() => normalizeSub2ApiUsage({
    mode: 'unrestricted', isValid: true,
    subscription: { weekly_usage_usd: 1, weekly_limit_usd: 10, expires_at: '2026-09-18' },
  }), /expires_at/)
  assert.throws(() => normalizeSub2ApiUsage({
    mode: 'unrestricted', isValid: true,
    subscription: { weekly_usage_usd: 1, weekly_limit_usd: 10, weekly_window_start: '2026-02-30T00:00:00Z' },
  }), /weekly_window_start/)
  assert.throws(() => normalizeSub2ApiUsage({
    mode: 'unrestricted', isValid: true,
    subscription: { weekly_usage_usd: 1, weekly_limit_usd: 10, expires_at: '2026-01-01T24:00:00Z' },
  }), /expires_at/)
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

test('connection tester accepts a draft key without storing or exposing it', async () => {
  let resolved = 0
  const tester = createConnectionTester(readerOptions({
    credentials: { resolve: async () => { resolved += 1; return { value: 'OLD_KEY' } } },
    fetchImpl: async (url, init) => {
      assert.equal(url, `${TEST_BASE_URL}/usage`)
      assert.equal(init.headers.authorization, `Bearer ${TEST_SECRET}`)
      return new Response(JSON.stringify(QUOTA), { status: 200 })
    },
  }))
  const data = await tester({ baseURL: TEST_BASE_URL, usagePath: 'auto', apiKey: TEST_SECRET })
  assert.equal(data.remaining, 80)
  assert.equal(resolved, 0)
  assert.equal(JSON.stringify(data).includes(TEST_SECRET), false)
  await assert.rejects(tester({ baseURL: 'http://unsafe.test.invalid', apiKey: TEST_SECRET }), /HTTPS/)

  const reuseTester = createConnectionTester(readerOptions({
    credentials: { resolve: async () => ({ value: 'OLD_KEY' }) },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer OLD_KEY')
      return new Response(JSON.stringify(QUOTA), { status: 200 })
    },
  }))
  assert.equal((await reuseTester({ baseURL: TEST_BASE_URL, apiKey: '' })).remaining, 80)
  await assert.rejects(reuseTester({ baseURL: 'https://different.test.invalid/v1', apiKey: '' }), (error) => {
    assert.equal(error.code, 'api-key-required')
    assert.equal(error.statusCode, 400)
    return true
  })
})

test('connection saver stages an origin-bound key, fences settings, and cleans inactive keys', async () => {
  const refs = managedRefs('https://new-relay.test.invalid/v1')
  let current = { baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' }
  const calls = []
  const settings = {
    get(ns) { return ns === 'dsh-relay-balance' ? current : undefined },
    async update(ns, patch, revision) {
      calls.push(['settings', ns, patch, revision])
      current = { ...current, ...patch }
    },
  }
  const credentials = {
    async describe(ref) { calls.push(['describe', ref]); return { configured: false, writable: true } },
    async set(ref, value) { calls.push(['set', ref, value]) },
    async unset(ref) { calls.push(['unset', ref]) },
  }
  const saved = await createConnectionSaver({
    settings,
    credentials,
    testConnection: async (input) => {
      calls.push(['test', input.baseURL, input.apiKey])
      return normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME })
    },
  })({ baseURL: 'https://new-relay.test.invalid/v1', apiKey: TEST_SECRET, usagePath: 'auto', expectedRevision: 5 })
  assert.equal(saved.remaining, 80)
  assert.equal(current.baseURL, 'https://new-relay.test.invalid/v1')
  assert.equal(current.credentialRef, refs[0])
  assert.deepEqual(calls.find((entry) => entry[0] === 'set'), ['set', refs[0], TEST_SECRET])
  const settingsCall = calls.find((entry) => entry[0] === 'settings')
  assert.equal(settingsCall[3], 5)
  assert.equal(settingsCall[2].credentialRef, refs[0])
  assert.equal(JSON.stringify(saved).includes(TEST_SECRET), false)
})

test('connection saver rolls back confirmed settings failures without breaking an active key', async () => {
  const refs = managedRefs(TEST_BASE_URL)
  const calls = []
  const current = { baseURL: TEST_BASE_URL, credentialRef: refs[0], usagePath: 'auto' }
  const saver = createConnectionSaver({
    settings: {
      get() { return current },
      async update() { const error = new Error('conflict'); error.code = 'SETTINGS_CONFLICT'; throw error },
    },
    credentials: {
      async describe() { return { configured: false, writable: true } },
      async set(ref) { calls.push(['set', ref]) },
      async unset(ref) { calls.push(['unset', ref]) },
    },
    testConnection: async () => normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME }),
  })
  await assert.rejects(saver({ baseURL: TEST_BASE_URL, apiKey: 'NEW_KEY', usagePath: 'auto', expectedRevision: 8 }), (error) => error.code === 'settings-conflict')
  assert.deepEqual(calls, [['set', refs[1]], ['unset', refs[1]]])
  assert.equal(current.credentialRef, refs[0])
})

test('connection saver serializes competing saves so a loser cannot overwrite the active slot', async () => {
  const refs = managedRefs(TEST_BASE_URL)
  let current = { baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' }
  let revision = 0
  let active = 0
  let maxActive = 0
  const values = new Map()
  const settings = {
    get() { return current },
    async update(_ns, patch, expected) {
      if (expected !== revision) { const error = new Error('conflict'); error.code = 'SETTINGS_CONFLICT'; throw error }
      current = { ...current, ...patch }
      revision += 1
    },
  }
  const saver = createConnectionSaver({
    settings,
    credentials: {
      async describe() { return { configured: false, writable: true } },
      async set(ref, value) { values.set(ref, value) },
      async unset(ref) { values.delete(ref) },
    },
    testConnection: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME })
    },
  })
  const [first, second] = await Promise.allSettled([
    saver({ baseURL: TEST_BASE_URL, apiKey: 'FIRST_KEY', usagePath: 'auto', expectedRevision: 0 }),
    saver({ baseURL: TEST_BASE_URL, apiKey: 'SECOND_KEY', usagePath: 'auto', expectedRevision: 0 }),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason.code, 'settings-conflict')
  assert.equal(maxActive, 1)
  assert.equal(current.credentialRef, refs[0])
  assert.equal(values.get(refs[0]), 'FIRST_KEY')
  assert.equal(values.has(refs[1]), false)
})

test('connection saver retains staged data when settings outcome is ambiguous', async () => {
  const refs = managedRefs(TEST_BASE_URL)
  const values = new Map()
  const saver = createConnectionSaver({
    settings: {
      get() { return { baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' } },
      async update() { throw new Error('listener failed after persistence') },
    },
    credentials: {
      async describe() { return { configured: false, writable: true } },
      async set(ref, value) { values.set(ref, value) },
      async unset(ref) { values.delete(ref) },
    },
    testConnection: async () => normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME }),
  })
  await assert.rejects(saver({ baseURL: TEST_BASE_URL, apiKey: 'STAGED_KEY', usagePath: 'auto', expectedRevision: 3 }), (error) => error.code === 'settings-unavailable')
  assert.equal(values.get(refs[0]), 'STAGED_KEY')
})

test('connection test route accepts only direct-loopback same-origin JSON POSTs', async () => {
  const body = JSON.stringify({ baseURL: TEST_BASE_URL, usagePath: 'auto', apiKey: TEST_SECRET })
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  const response = responseRecorder()
  await createConnectionTestHandler(async (input) => {
    assert.equal(input.apiKey, TEST_SECRET)
    return normalizeSub2ApiUsage(QUOTA, { fetchedAt: FIXED_TIME })
  })(request, response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.includes(TEST_SECRET), false)

  const remote = responseRecorder()
  await createConnectionTestHandler(async () => null)({ ...request, socket: { remoteAddress: '192.0.2.10' } }, remote)
  assert.equal(remote.statusCode, 403)
})

test('apply registers settings and all local routes', () => {
  const registered = []
  let namespace
  let settingsOptions
  const ctx = {
    settings: {
      get(ns) { return ns === 'llm-pi-ai' ? settingsValue() : undefined },
      register(ns, _schema, options) { namespace = ns; settingsOptions = options; return {} },
      update() {},
    },
    credentials: { resolve() {}, describe() {}, set() {}, unset() {} },
    webServer: { register(options) { registered.push(options); return () => {} } },
    effect(callback) { return callback() },
  }
  apply(ctx, CONFIG)
  assert.equal(namespace, 'dsh-relay-balance')
  assert.deepEqual(settingsOptions.base, { baseURL: TEST_BASE_URL, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' })
  assert.doesNotThrow(() => settingsOptions.validate({ baseURL: `${TEST_BASE_URL}/nested`, credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' }))
  assert.throws(() => settingsOptions.validate({ baseURL: 'https://different.test.invalid/v1', credentialRef: TEST_CREDENTIAL_REF, usagePath: 'auto' }), /新 API Key/)
  assert.doesNotThrow(() => settingsOptions.validate({ baseURL: 'https://different.test.invalid/v1', credentialRef: managedRefs('https://different.test.invalid/v1')[0], usagePath: 'auto' }))
  assert.throws(() => settingsOptions.validate({ baseURL: 'https://different.test.invalid/v1', credentialRef: managedRefs(TEST_BASE_URL)[0], usagePath: 'auto' }), /插件管理/)
  assert.deepEqual(registered.map((route) => route.path), ['/relay-balance/status', '/relay-balance/test', '/relay-balance/save'])
  assert.ok(registered.every((route) => route.kind === 'exact'))
  assert.throws(() => createBalanceReader({ settings: {}, credentials: { resolve() {} } }), /settings\.get/)
  assert.throws(() => apply({ settings: { get() {}, register() {}, update() {} }, credentials: { resolve() {}, describe() {}, set() {}, unset() {} }, webServer: {} }, CONFIG), /webServer\.register/)
})
