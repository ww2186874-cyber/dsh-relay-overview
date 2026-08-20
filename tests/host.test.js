import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createBalanceReader, createStatusHandler, normalizeUsage, resolveProviderConfig } from '../lib/index.js'

const MAX_RESPONSE_BYTES = 1_048_576
const TEST_SECRET = 'TEST_ONLY_SECRET_DO_NOT_USE'
const TEST_BASE_URL = 'https://relay.test.invalid/v1'
const TEST_CREDENTIAL_REF = 'TEST_ONLY_CREDENTIAL_REF'
const FIXED_TIME = '2026-08-20T00:00:00.000Z'
const SAMPLE = {
  isValid: true,
  unit: 'USD',
  planName: '测试套餐',
  remaining: 80,
  usage: { total: { actual_cost: 20 } },
}

function settingsValue() {
  return { providers: { nbcodex: { baseURL: TEST_BASE_URL, apiKeyEnv: TEST_CREDENTIAL_REF } } }
}

function readerOptions(overrides = {}) {
  return {
    settings: { get: () => settingsValue() },
    credentials: { resolve: async () => ({ value: TEST_SECRET }) },
    now: () => new Date(FIXED_TIME),
    ...overrides,
  }
}

function jsonWithExactBytes(target) {
  const empty = JSON.stringify({ ...SAMPLE, padding: '' })
  const needed = target - Buffer.byteLength(empty)
  assert.ok(needed >= 0)
  const text = JSON.stringify({ ...SAMPLE, padding: 'x'.repeat(needed) })
  assert.equal(Buffer.byteLength(text), target)
  return text
}

function streamResponse(chunks, options = {}) {
  let cancelled = false
  let reads = 0
  const body = new ReadableStream({
    pull(controller) {
      if (reads >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[reads])
      reads += 1
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(body, { status: options.status ?? 200, headers: options.headers }),
    wasCancelled: () => cancelled,
    reads: () => reads,
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

async function publicResponse(readBalance) {
  const response = responseRecorder()
  await createStatusHandler(readBalance)({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, response)
  return response
}

function assertSafeError(error, code) {
  assert.equal(error?.code, code)
  assert.equal(String(error?.message).includes(TEST_SECRET), false)
  assert.equal(String(error?.message).includes(TEST_CREDENTIAL_REF), false)
  assert.equal(String(error?.message).includes('sensitive-upstream-body'), false)
  return true
}

test('normalizes current NBAPI usage shape', () => {
  const result = normalizeUsage(SAMPLE, FIXED_TIME)
  assert.equal(result.total, 100)
  assert.equal(result.remaining, 80)
  assert.equal(result.spent, 20)
  assert.equal(result.percent, 80)
  assert.equal(result.unit, 'USD')
  assert.equal(result.planName, SAMPLE.planName)
})

test('rejects invalid totals and malformed payloads', () => {
  assert.throws(() => normalizeUsage({ ...SAMPLE, remaining: -1 }), /remaining/)
  assert.throws(() => normalizeUsage({ ...SAMPLE, remaining: 0, usage: { total: { actual_cost: 0 } } }), /总额度/)
  assert.throws(() => normalizeUsage({ ...SAMPLE, isValid: false }), /无效/)
  assert.throws(() => normalizeUsage({ ...SAMPLE, usage: {} }), /actual_cost/)
})

test('resolves only the configured HTTPS NB Codex provider', () => {
  assert.deepEqual(resolveProviderConfig(settingsValue()), {
    usageURL: `${TEST_BASE_URL}/usage`,
    apiKeyEnv: TEST_CREDENTIAL_REF,
  })
  assert.throws(() => resolveProviderConfig({ providers: { nbcodex: { baseURL: 'http://relay.test.invalid/v1', apiKeyEnv: 'PLACEHOLDER' } } }), /HTTPS/)
})

test('reader handles a normal response, rejects redirects, and resolves credentials per operation', async () => {
  let credentialReads = 0
  let fetchReads = 0
  const reader = createBalanceReader(readerOptions({
    credentials: { resolve: async (ref) => {
      assert.equal(ref, TEST_CREDENTIAL_REF)
      credentialReads += 1
      return { value: TEST_SECRET, source: 'test' }
    } },
    fetchImpl: async (url, init) => {
      fetchReads += 1
      assert.equal(url, `${TEST_BASE_URL}/usage`)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, `Bearer ${TEST_SECRET}`)
      assert.ok(init.signal instanceof AbortSignal)
      return new Response(JSON.stringify(SAMPLE), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }))
  const one = await reader()
  const two = await reader()
  assert.equal(credentialReads, 2)
  assert.equal(fetchReads, 2)
  assert.deepEqual(Object.keys(one), ['remaining', 'spent', 'total', 'percent', 'unit', 'planName', 'fetchedAt'])
  assert.deepEqual(one, two)
  assert.equal(JSON.stringify(one).includes(TEST_SECRET), false)
})

test('rejects declared Content-Length above one MiB before reading', async () => {
  let bodyRead = false
  let bodyCancelled = false
  const response = {
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: (name) => name === 'content-length' ? String(MAX_RESPONSE_BYTES + 1) : null },
    body: { cancel: async () => { bodyCancelled = true } },
    text: async () => { bodyRead = true; return JSON.stringify(SAMPLE) },
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-response-too-large'))
  assert.equal(bodyRead, false)
  assert.equal(bodyCancelled, true)
})

test('cancels a no-Content-Length stream as soon as it exceeds one MiB', async () => {
  const chunks = [
    new Uint8Array(MAX_RESPONSE_BYTES),
    new Uint8Array([0x78]),
    new Uint8Array([0x79]),
  ]
  let reads = 0
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks[reads]
            reads += 1
            return value === undefined ? { done: true } : { done: false, value }
          },
          async cancel() { cancelled = true },
          releaseLock() {},
        }
      },
    },
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-response-too-large'))
  assert.equal(cancelled, true)
  assert.equal(reads, 2)
})

test('accepts a valid JSON response exactly at the one MiB byte limit', async () => {
  const text = jsonWithExactBytes(MAX_RESPONSE_BYTES)
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => new Response(text, { status: 200 }) }))
  const result = await reader()
  assert.equal(result.total, SAMPLE.remaining + SAMPLE.usage.total.actual_cost)
})

test('decodes UTF-8 safely when a multibyte character crosses chunk boundaries', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify(SAMPLE))
  const multibyteStart = encoded.findIndex((value) => value >= 0xe0)
  assert.ok(multibyteStart > 0)
  const streamed = streamResponse([
    encoded.slice(0, multibyteStart + 1),
    encoded.slice(multibyteStart + 1, multibyteStart + 2),
    encoded.slice(multibyteStart + 2),
  ])
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => streamed.response }))
  const result = await reader()
  assert.equal(result.planName, SAMPLE.planName)
  assert.equal(streamed.wasCancelled(), false)
})

test('rejects malformed streamed UTF-8 without exposing bytes', async () => {
  const prefix = new TextEncoder().encode('{"isValid":true,"remaining":1,"usage":{"total":{"actual_cost":1}},"planName":"')
  const suffix = new TextEncoder().encode('"}')
  const streamed = streamResponse([prefix, new Uint8Array([0xc3, 0x28]), suffix])
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => streamed.response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'invalid-upstream-data'))
  assert.equal(streamed.wasCancelled(), true)
})

test('maps reader TypeError to sanitized upstream-unavailable instead of invalid UTF-8', async () => {
  const transportMessage = `TEST_ONLY_STREAM_FAILURE_${TEST_SECRET}`
  let cancellations = 0
  const makeResponse = () => ({
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() { throw new TypeError(transportMessage) },
          async cancel() { cancellations += 1 },
          releaseLock() {},
        }
      },
    },
  })
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => makeResponse() }))
  await assert.rejects(reader(), (error) => {
    assert.notEqual(error?.code, 'invalid-upstream-data')
    assert.equal(error?.message, '暂时无法读取 NBAPI 响应')
    return assertSafeError(error, 'upstream-unavailable')
  })

  const response = await publicResponse(reader)
  const body = JSON.parse(response.body)
  assert.equal(response.statusCode, 502)
  assert.equal(body.error.code, 'upstream-unavailable')
  assert.equal(body.error.message, '暂时无法读取 NBAPI 响应')
  assert.equal(response.body.includes(transportMessage), false)
  assert.equal(response.body.includes(TEST_SECRET), false)
  assert.equal(cancellations, 2)
})

test('supports test responses without a readable body while enforcing UTF-8 bytes', async () => {
  const response = {
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify(SAMPLE),
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  assert.equal((await reader()).planName, SAMPLE.planName)
})

test('cancels a non-reader fallback body when decoded text is oversized', async () => {
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    redirected: false,
    headers: { get: () => null },
    body: { cancel: async () => { cancelled = true } },
    text: async () => 'x'.repeat(MAX_RESPONSE_BYTES + 1),
  }
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => response }))
  await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-response-too-large'))
  assert.equal(cancelled, true)
})

test('keeps redirect:error and defensively rejects redirected and 3xx responses', async () => {
  const genericFetchFailure = new TypeError(`redirect rejected: https://redirect.test.invalid/${TEST_SECRET}`)
  const generic = createBalanceReader(readerOptions({ fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error')
    throw genericFetchFailure
  } }))
  await assert.rejects(generic(), (error) => assertSafeError(error, 'upstream-unavailable'))

  const redirected = createBalanceReader(readerOptions({ fetchImpl: async () => ({
    ok: true,
    status: 200,
    redirected: true,
    headers: { get: () => null },
    body: null,
    text: async () => `sensitive-upstream-body-${TEST_SECRET}`,
  }) }))
  await assert.rejects(redirected(), (error) => assertSafeError(error, 'upstream-redirect-rejected'))

  let threeHundredCancelled = false
  const threeHundred = createBalanceReader(readerOptions({ fetchImpl: async () => ({
    ok: false,
    status: 302,
    redirected: false,
    headers: { get: () => null },
    body: { cancel: async () => { threeHundredCancelled = true } },
  }) }))
  await assert.rejects(threeHundred(), (error) => assertSafeError(error, 'upstream-redirect-rejected'))
  assert.equal(threeHundredCancelled, true)
})

test('maps timeout failures to a fixed safe public error', async () => {
  const timeout = new Error(`timeout ${TEST_SECRET}`)
  timeout.name = 'TimeoutError'
  const reader = createBalanceReader(readerOptions({ fetchImpl: async () => { throw timeout } }))
  await assert.rejects(reader(), (error) => {
    assert.equal(error?.statusCode, 504)
    return assertSafeError(error, 'upstream-timeout')
  })
})

test('401 and 403 failures do not expose upstream bodies', async () => {
  for (const status of [401, 403]) {
    const reader = createBalanceReader(readerOptions({
      fetchImpl: async () => new Response(`sensitive-upstream-body-${TEST_SECRET}`, { status }),
    }))
    await assert.rejects(reader(), (error) => assertSafeError(error, 'upstream-auth-failed'))
  }
})

test('invalid JSON and credential failures are sanitized', async () => {
  const invalid = createBalanceReader(readerOptions({
    fetchImpl: async () => new Response(`sensitive-upstream-body-${TEST_SECRET}`, { status: 200 }),
  }))
  await assert.rejects(invalid(), (error) => assertSafeError(error, 'invalid-upstream-data'))

  const missing = createBalanceReader(readerOptions({
    credentials: { resolve: async () => undefined },
    fetchImpl: async () => { throw new Error('must not run') },
  }))
  await assert.rejects(missing(), (error) => assertSafeError(error, 'credential-not-configured'))

  const failed = createBalanceReader(readerOptions({
    credentials: { resolve: async () => { throw new Error(TEST_SECRET) } },
    fetchImpl: async () => { throw new Error('must not run') },
  }))
  await assert.rejects(failed(), (error) => assertSafeError(error, 'credential-unavailable'))
})

test('status handler emits success, 405, cross-site 403, and sanitized errors', async () => {
  const success = await publicResponse(async () => normalizeUsage(SAMPLE, FIXED_TIME))
  assert.equal(success.statusCode, 200)
  assert.equal(JSON.parse(success.body).ok, true)
  assert.match(success.headers['cache-control'], /no-store/)

  const method = responseRecorder()
  await createStatusHandler(async () => null)({ method: 'POST', headers: {} }, method)
  assert.equal(method.statusCode, 405)
  assert.equal(method.headers.allow, 'GET')

  const crossSite = responseRecorder()
  await createStatusHandler(async () => normalizeUsage(SAMPLE))({
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'https://cross-site.test.invalid', 'sec-fetch-site': 'cross-site' },
    socket: { encrypted: false },
  }, crossSite)
  assert.equal(crossSite.statusCode, 403)

  const schemeMismatch = responseRecorder()
  await createStatusHandler(async () => normalizeUsage(SAMPLE))({
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    socket: { encrypted: false },
  }, schemeMismatch)
  assert.equal(schemeMismatch.statusCode, 403)

  const sameOrigin = responseRecorder()
  await createStatusHandler(async () => normalizeUsage(SAMPLE, FIXED_TIME))({
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    socket: { encrypted: false },
  }, sameOrigin)
  assert.equal(sameOrigin.statusCode, 200)

  const failure = await publicResponse(async () => { throw new Error(`sensitive-upstream-body-${TEST_SECRET}`) })
  assert.equal(failure.statusCode, 500)
  assert.equal(failure.body.includes(TEST_SECRET), false)
  assert.equal(failure.body.includes('sensitive-upstream-body'), false)
})

test('all representative public error responses exclude the test sentinel', async () => {
  const redirectError = new TypeError(`redirect rejected: https://redirect.test.invalid/${TEST_SECRET}`)
  const cases = [
    createBalanceReader(readerOptions({ fetchImpl: async () => new Response(TEST_SECRET, { status: 401 }) })),
    createBalanceReader(readerOptions({ fetchImpl: async () => new Response(TEST_SECRET, { status: 403 }) })),
    createBalanceReader(readerOptions({ fetchImpl: async () => new Response(TEST_SECRET, { status: 200 }) })),
    createBalanceReader(readerOptions({ fetchImpl: async () => { throw redirectError } })),
    createBalanceReader(readerOptions({ fetchImpl: async () => { throw new Error(TEST_SECRET) } })),
    createBalanceReader(readerOptions({ credentials: { resolve: async () => { throw new Error(TEST_SECRET) } } })),
    createBalanceReader(readerOptions({ fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: false,
      headers: { get: () => String(MAX_RESPONSE_BYTES + 1) },
      body: { cancel: async () => {} },
    }) })),
  ]
  for (const reader of cases) {
    const response = await publicResponse(reader)
    assert.equal(response.body.includes(TEST_SECRET), false)
    assert.equal(response.body.includes(TEST_CREDENTIAL_REF), false)
    assert.equal(response.body.includes('redirect.test.invalid'), false)
  }
})

test('required Host service methods fail with clear compatibility errors', () => {
  assert.throws(() => createBalanceReader({ settings: {}, credentials: { resolve() {} } }), /settings\.get/)
  assert.throws(() => createBalanceReader({ settings: { get() {} }, credentials: {} }), /credentials\.resolve/)
  assert.throws(() => apply({
    settings: { get() {} },
    credentials: { resolve() {} },
    webServer: {},
  }), /webServer\.register/)
})
