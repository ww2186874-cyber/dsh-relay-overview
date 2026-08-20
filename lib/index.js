import z from '@deepseek-ai/schemastery'

const ROUTE_PATH = '/relay-balance/status'
const PROVIDER_NAMESPACE = 'llm-pi-ai'
const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_CONFIG = Object.freeze({ providerId: 'sub2api', displayName: 'Relay', usagePath: 'auto', allowRemote: false })

export const name = 'dsh-relay-balance'
export const inject = ['settings', 'credentials', 'webServer']
export const Config = z.object({
  providerId: z.string().default(DEFAULT_CONFIG.providerId),
  displayName: z.string().default(DEFAULT_CONFIG.displayName),
  usagePath: z.string().default(DEFAULT_CONFIG.usagePath),
  allowRemote: z.boolean().default(DEFAULT_CONFIG.allowRemote),
})

class PublicBalanceError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message)
    this.name = 'PublicBalanceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function requireMethod(owner, serviceName, methodName) {
  if (typeof owner?.[methodName] !== 'function') throw new Error(`dsh-relay-balance requires ${serviceName}.${methodName}()`)
}

export function normalizePluginConfig(value = {}) {
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : ''
  const usagePath = typeof value.usagePath === 'string' ? value.usagePath.trim() : ''
  const allowRemote = value.allowRemote === true
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(providerId)) throw new Error('dsh-relay-balance config.providerId must contain only letters, digits, dot, underscore, or hyphen')
  if (displayName === '' || displayName.length > 64) throw new Error('dsh-relay-balance config.displayName must contain 1-64 characters')
  if (usagePath !== 'auto' && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(usagePath)) {
    throw new Error("dsh-relay-balance config.usagePath must be 'auto' or an absolute URL path without query or fragment")
  }
  return { providerId, displayName, usagePath, allowRemote }
}

function publicInvalidData(message = '中转站返回了无效的额度数据') {
  return new PublicBalanceError('invalid-upstream-data', message)
}

function finiteNonNegative(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw publicInvalidData(`中转站返回的 ${field} 无效`)
  return value
}

function optionalFiniteNonNegative(value, field) {
  if (value === undefined || value === null) return null
  return finiteNonNegative(value, field)
}

function record(value) {
  return typeof value === 'object' && value !== null ? value : null
}

function unitOf(payload) {
  const value = typeof payload.unit === 'string' ? payload.unit.trim() : ''
  return value === '' ? 'USD' : value.toUpperCase().slice(0, 12)
}

function planOf(payload) {
  return typeof payload.planName === 'string' ? payload.planName.trim().slice(0, 100) : ''
}

function percentOf(remaining, total) {
  return Math.min(100, Math.max(0, remaining / total * 100))
}

function usageSpent(payload) {
  const total = record(record(payload.usage)?.total)
  return optionalFiniteNonNegative(total?.actual_cost, 'usage.total.actual_cost')
}

function quotaView(payload) {
  const quota = record(payload.quota)
  if (quota === null) return null
  const total = finiteNonNegative(quota.limit, 'quota.limit')
  if (total <= 0) throw publicInvalidData('中转站返回的 quota.limit 无效')
  const remaining = finiteNonNegative(quota.remaining ?? payload.remaining, 'quota.remaining')
  const reportedSpent = optionalFiniteNonNegative(quota.used, 'quota.used')
  if (remaining > total) throw publicInvalidData('中转站返回的 quota.remaining 超过了 quota.limit')
  const spent = reportedSpent ?? Math.max(0, total - remaining)
  const tolerance = Math.max(1e-8, total * 1e-9)
  const expectedRemaining = Math.max(0, total - spent)
  if (Math.abs(expectedRemaining - remaining) > tolerance) {
    throw publicInvalidData('中转站返回的 quota.used、quota.remaining 与 quota.limit 不一致')
  }
  return { mode: 'quota', remaining, spent, total, percent: percentOf(remaining, total), scope: 'total', resetAt: null }
}

function rateLimitView(payload) {
  if (!Array.isArray(payload.rate_limits)) return null
  const candidates = []
  for (const entryValue of payload.rate_limits) {
    const entry = record(entryValue)
    if (entry === null) continue
    const total = optionalFiniteNonNegative(entry.limit, 'rate_limits.limit')
    if (total === null || total <= 0) continue
    const spent = optionalFiniteNonNegative(entry.used, 'rate_limits.used') ?? 0
    const remaining = optionalFiniteNonNegative(entry.remaining, 'rate_limits.remaining') ?? Math.max(0, total - spent)
    if (remaining > total) throw publicInvalidData('中转站返回的 rate_limits.remaining 超过了 limit')
    const scope = typeof entry.window === 'string' && ['5h', '1d', '7d'].includes(entry.window) ? entry.window : 'window'
    const resetAt = typeof entry.reset_at === 'string' ? entry.reset_at : null
    candidates.push({ mode: 'rate-limit', remaining, spent, total, percent: percentOf(remaining, total), scope, resetAt })
  }
  return candidates.sort((a, b) => a.remaining - b.remaining || a.percent - b.percent)[0] ?? null
}

function subscriptionView(payload) {
  const subscription = record(payload.subscription)
  if (subscription === null) return null
  const specs = [
    ['daily', 'daily_usage_usd', 'daily_limit_usd'],
    ['weekly', 'weekly_usage_usd', 'weekly_limit_usd'],
    ['monthly', 'monthly_usage_usd', 'monthly_limit_usd'],
  ]
  const candidates = []
  for (const [scope, usageField, limitField] of specs) {
    const rawLimit = subscription[limitField]
    if (rawLimit === undefined || rawLimit === null || rawLimit === 0) continue
    const total = finiteNonNegative(rawLimit, `subscription.${limitField}`)
    if (total <= 0) continue
    const spent = finiteNonNegative(subscription[usageField] ?? 0, `subscription.${usageField}`)
    const remaining = Math.max(0, total - spent)
    candidates.push({ mode: 'subscription', remaining, spent, total, percent: percentOf(remaining, total), scope, resetAt: null })
  }
  if (candidates.length === 0) return { mode: 'unlimited', remaining: null, spent: usageSpent(payload), total: null, percent: null, scope: null, resetAt: null }
  return candidates.sort((a, b) => a.remaining - b.remaining || a.percent - b.percent)[0]
}

function walletView(payload) {
  const remaining = finiteNonNegative(payload.balance ?? payload.remaining, 'remaining')
  return { mode: 'wallet', remaining, spent: usageSpent(payload), total: null, percent: null, scope: null, resetAt: null }
}

export function normalizeSub2ApiUsage(payload, options = {}) {
  if (record(payload) === null || payload.isValid !== true) throw publicInvalidData()
  const mode = typeof payload.mode === 'string' ? payload.mode : ''
  let view
  if (mode === 'quota_limited' || record(payload.quota) !== null) {
    const limited = [quotaView(payload), rateLimitView(payload)].filter((candidate) => candidate !== null)
    view = limited.sort((a, b) => a.remaining - b.remaining || a.percent - b.percent)[0] ?? null
    if (view === null) throw publicInvalidData('中转站未返回可用的 Key 配额或速率额度')
  } else if (record(payload.subscription) !== null) {
    view = subscriptionView(payload)
  } else if (payload.remaining === -1) {
    view = { mode: 'unlimited', remaining: null, spent: usageSpent(payload), total: null, percent: null, scope: null, resetAt: null }
  } else {
    view = walletView(payload)
  }

  const fetchedAt = typeof options.fetchedAt === 'string' ? options.fetchedAt : new Date().toISOString()
  const displayName = typeof options.displayName === 'string' && options.displayName.trim() !== '' ? options.displayName.trim().slice(0, 64) : DEFAULT_CONFIG.displayName
  return { adapter: 'sub2api', displayName, planName: planOf(payload), unit: unitOf(payload), ...view, fetchedAt }
}

function appendPath(url, suffix) {
  const next = new URL(url.href)
  next.pathname = `${next.pathname.replace(/\/+$/, '')}${suffix}` || suffix
  return next
}

export function buildUsageUrls(baseURL, usagePath = 'auto') {
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new PublicBalanceError('provider-not-configured', 'Relay baseURL 无效', 503)
  }
  if (parsed.protocol !== 'https:') throw new PublicBalanceError('provider-not-configured', 'Relay baseURL 必须使用 HTTPS', 503)
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new PublicBalanceError('provider-not-configured', 'Relay baseURL 不得包含凭据、查询参数或片段', 503)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  if (usagePath !== 'auto') {
    const direct = new URL(parsed.origin)
    direct.pathname = usagePath
    return [direct.href]
  }
  const candidates = [appendPath(parsed, '/usage').href]
  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const fallback = new URL(parsed.href)
  fallback.pathname = /\/v1$/i.test(normalizedPath) ? `${normalizedPath.replace(/\/v1$/i, '') || ''}/usage` : `${normalizedPath}/v1/usage`
  candidates.push(fallback.href)
  return [...new Set(candidates)]
}

export function resolveRelayConfig(settingsValue, config = DEFAULT_CONFIG) {
  const normalized = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  const providers = record(settingsValue)?.providers
  const provider = record(providers)?.[normalized.providerId]
  if (record(provider) === null) throw new PublicBalanceError('provider-not-configured', `未找到 Relay Provider：${normalized.providerId}`, 503)
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.trim() : ''
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
  if (baseURL === '' || apiKeyEnv === '') throw new PublicBalanceError('provider-not-configured', 'Relay Provider 缺少 baseURL 或 apiKeyEnv', 503)
  return { ...normalized, usageURLs: buildUsageUrls(baseURL, normalized.usagePath), apiKeyEnv }
}

function responseTooLarge() { return new PublicBalanceError('upstream-response-too-large', '中转站响应过大') }
function invalidUtf8() { return publicInvalidData('中转站返回了无效的 UTF-8 数据') }
function responseReadUnavailable() { return new PublicBalanceError('upstream-unavailable', '暂时无法读取中转站响应') }

function decodeUtf8(decoder, chunk, options) {
  try { return decoder.decode(chunk, options) } catch { throw invalidUtf8() }
}

async function cancelBody(body) {
  if (typeof body?.cancel !== 'function') return
  try { await body.cancel() } catch { /* Best-effort only. */ }
}

function declaredResponseBytes(response) {
  let raw
  try { raw = response.headers?.get?.('content-length') } catch { return undefined }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

async function readLimitedText(response) {
  const declared = declaredResponseBytes(response)
  if (declared !== undefined && declared > MAX_RESPONSE_BYTES) {
    await cancelBody(response.body)
    throw responseTooLarge()
  }
  if (response.body === null || response.body === undefined || typeof response.body.getReader !== 'function') {
    if (typeof response.text !== 'function') throw responseReadUnavailable()
    let text
    try { text = await response.text() } catch { await cancelBody(response.body); throw responseReadUnavailable() }
    let byteLength
    try { byteLength = new TextEncoder().encode(text).byteLength } catch { await cancelBody(response.body); throw responseReadUnavailable() }
    if (byteLength > MAX_RESPONSE_BYTES) { await cancelBody(response.body); throw responseTooLarge() }
    return text
  }

  let reader
  try { reader = response.body.getReader() } catch { throw responseReadUnavailable() }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      received += chunk.byteLength
      if (received > MAX_RESPONSE_BYTES) throw responseTooLarge()
      parts.push(decodeUtf8(decoder, chunk, { stream: true }))
    }
    parts.push(decodeUtf8(decoder))
    return parts.join('')
  } catch (error) {
    try { await reader.cancel() } catch { /* Best-effort only. */ }
    if (error instanceof PublicBalanceError) throw error
    throw responseReadUnavailable()
  } finally {
    try { reader.releaseLock() } catch { /* A released or test reader needs no cleanup. */ }
  }
}

function isTimeoutError(error) { return error?.name === 'TimeoutError' || error?.name === 'AbortError' }
function mapUpstreamFailure(error) {
  if (error instanceof PublicBalanceError) return error
  if (isTimeoutError(error)) return new PublicBalanceError('upstream-timeout', '中转额度查询超时', 504)
  return new PublicBalanceError('upstream-unavailable', '暂时无法连接中转站')
}

async function fetchUsageResponse(usageURLs, apiKey, fetchImpl) {
  for (let index = 0; index < usageURLs.length; index += 1) {
    let response
    try {
      response = await fetchImpl(usageURLs[index], {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw mapUpstreamFailure(error)
    }
    if (response?.redirected === true || (response?.status >= 300 && response?.status <= 399)) {
      await cancelBody(response?.body)
      throw new PublicBalanceError('upstream-redirect-rejected', '中转站重定向已被拒绝')
    }
    if (response?.ok === true) return response
    await cancelBody(response?.body)
    if (response?.status === 404 && index + 1 < usageURLs.length) continue
    const authFailure = response?.status === 401 || response?.status === 403
    throw new PublicBalanceError(
      authFailure ? 'upstream-auth-failed' : 'upstream-http-error',
      authFailure ? '中转站鉴权失败' : `中转额度查询失败（HTTP ${Number.isInteger(response?.status) ? response.status : '未知'}）`,
    )
  }
  throw new PublicBalanceError('upstream-http-error', '中转额度查询失败')
}

export function createBalanceReader({ settings, credentials, config = DEFAULT_CONFIG, fetchImpl = fetch, now = () => new Date() }) {
  requireMethod(settings, 'settings', 'get')
  requireMethod(credentials, 'credentials', 'resolve')
  const normalizedConfig = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  let current = null

  async function readOnce() {
    let settingsValue
    try { settingsValue = settings.get(PROVIDER_NAMESPACE) } catch { throw new PublicBalanceError('provider-config-unavailable', '暂时无法读取 Relay Provider 配置', 503) }
    const resolvedConfig = resolveRelayConfig(settingsValue, normalizedConfig)
    let resolved
    try { resolved = await credentials.resolve(resolvedConfig.apiKeyEnv) } catch { throw new PublicBalanceError('credential-unavailable', 'Relay 凭据暂时不可用', 503) }
    const apiKey = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (apiKey === '') throw new PublicBalanceError('credential-not-configured', 'Relay 凭据尚未配置', 503)

    const response = await fetchUsageResponse(resolvedConfig.usageURLs, apiKey, fetchImpl)
    let text
    try { text = await readLimitedText(response) } catch (error) { throw mapUpstreamFailure(error) }
    let payload
    try { payload = JSON.parse(text) } catch { throw publicInvalidData('中转站返回了无法解析的数据') }
    return normalizeSub2ApiUsage(payload, { displayName: resolvedConfig.displayName, fetchedAt: now().toISOString() })
  }

  return function readBalance() {
    if (current !== null) return current
    const operation = readOnce().finally(() => { if (current === operation) current = null })
    current = operation
    return operation
  }
}

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(payload)
}

function isCrossSite(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    const requestProtocol = req.socket?.encrypted === true ? 'https:' : 'http:'
    return parsed.host !== host || parsed.protocol !== requestProtocol
  } catch { return true }
}

function isLoopbackAddress(address) {
  return typeof address === 'string'
    && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./i.test(address))
}

function isLoopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority.trim() === '') return false
  try {
    const hostname = new URL(`http://${authority}`).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
  } catch {
    return false
  }
}

function hasForwardingHeaders(req) {
  return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']
    .some((name) => req.headers[name] !== undefined)
}

function isDirectLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
    && isLoopbackAuthority(req.headers.host)
    && !hasForwardingHeaders(req)
}

export function createStatusHandler(readBalance, options = {}) {
  const allowRemote = options.allowRemote === true
  return async function statusHandler(req, res) {
    if (!allowRemote && !isDirectLoopbackRequest(req)) {
      json(res, 403, { ok: false, error: { code: 'remote-access-disabled', message: 'Relay 额度接口仅允许本机访问' } })
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '仅支持 GET 请求' } }, { allow: 'GET' })
      return
    }
    if (isCrossSite(req)) {
      json(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝跨站请求' } })
      return
    }
    try {
      json(res, 200, { ok: true, data: await readBalance() })
    } catch (error) {
      const safe = error instanceof PublicBalanceError ? error : new PublicBalanceError('internal-error', '中转额度查询暂时不可用', 500)
      json(res, safe.statusCode, { ok: false, error: { code: safe.code, message: safe.message } })
    }
  }
}

export function apply(ctx, config) {
  requireMethod(ctx.settings, 'settings', 'get')
  requireMethod(ctx.credentials, 'credentials', 'resolve')
  requireMethod(ctx.webServer, 'webServer', 'register')
  const normalizedConfig = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  const readBalance = createBalanceReader({ settings: ctx.settings, credentials: ctx.credentials, config: normalizedConfig })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: createStatusHandler(readBalance, { allowRemote: normalizedConfig.allowRemote }),
  }), 'relay-balance: status route')
}
