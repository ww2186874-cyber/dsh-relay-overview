import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

const STATUS_ROUTE_PATH = '/relay-balance/status'
const TEST_ROUTE_PATH = '/relay-balance/test'
const SAVE_ROUTE_PATH = '/relay-balance/save'
const PROVIDER_NAMESPACE = 'llm-pi-ai'
const SETTINGS_NAMESPACE = 'dsh-relay-balance'
const MANAGED_CREDENTIAL_PREFIX = 'DSH_RELAY_BALANCE_'
const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 1_048_576
const MAX_REQUEST_BYTES = 65_536
const DEFAULT_CONFIG = Object.freeze({
  providerId: 'sub2api',
  displayName: 'Relay',
  baseURL: '',
  credentialRef: '',
  usagePath: 'auto',
  allowRemote: false,
})

export const name = 'dsh-relay-balance'
export const inject = ['settings', 'credentials', 'webServer']
export const Config = z.object({
  providerId: z.string().default(DEFAULT_CONFIG.providerId),
  displayName: z.string().default(DEFAULT_CONFIG.displayName),
  baseURL: z.string().default(DEFAULT_CONFIG.baseURL),
  credentialRef: z.string().default(DEFAULT_CONFIG.credentialRef),
  usagePath: z.string().default(DEFAULT_CONFIG.usagePath),
  allowRemote: z.boolean().default(DEFAULT_CONFIG.allowRemote),
})

export const RelaySettings = z.object({
  baseURL: z.string().default(''),
  credentialRef: z.string().default(''),
  usagePath: z.string().default('auto'),
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

function normalizeUsagePath(value) {
  const usagePath = typeof value === 'string' ? value.trim() : ''
  if (usagePath !== 'auto' && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(usagePath)) {
    throw new Error("dsh-relay-balance usagePath must be 'auto' or an absolute URL path without query or fragment")
  }
  return usagePath
}

function normalizeCredentialRef(value) {
  const credentialRef = typeof value === 'string' ? value.trim() : ''
  if (credentialRef !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)) {
    throw new Error('dsh-relay-balance credentialRef must be a POSIX-style environment variable name')
  }
  return credentialRef
}

export function normalizePluginConfig(value = {}) {
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : ''
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : ''
  const baseURL = typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
  const credentialRef = normalizeCredentialRef(value.credentialRef)
  const usagePath = normalizeUsagePath(value.usagePath)
  const allowRemote = value.allowRemote === true
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(providerId)) throw new Error('dsh-relay-balance config.providerId must contain only letters, digits, dot, underscore, or hyphen')
  if (displayName === '' || displayName.length > 64) throw new Error('dsh-relay-balance config.displayName must contain 1-64 characters')
  if (baseURL !== '') buildUsageUrls(baseURL, usagePath)
  if ((baseURL === '') !== (credentialRef === '')) throw new Error('dsh-relay-balance config.baseURL and config.credentialRef must be set together')
  return { providerId, displayName, baseURL, credentialRef, usagePath, allowRemote }
}

export function normalizeRelaySettings(value = {}) {
  const baseURL = typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
  const credentialRef = normalizeCredentialRef(value.credentialRef)
  const usagePath = normalizeUsagePath(value.usagePath)
  if (baseURL !== '') buildUsageUrls(baseURL, usagePath)
  if ((baseURL === '') !== (credentialRef === '')) throw new Error('Relay URL 和 API Key 必须一起配置')
  return { baseURL, credentialRef, usagePath }
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

function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
    : null
  if (match !== null) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    const offsetHour = match[8] === undefined ? 0 : Number(match[8])
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    const validCalendar = month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)
    const validClock = hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
    if (validCalendar && validClock && Number.isFinite(Date.parse(value))) return value
  }
  throw publicInvalidData(`中转站返回的 ${field} 无效`)
}

function addDuration(timestamp, durationMs, field) {
  const milliseconds = Date.parse(timestamp)
  const result = milliseconds + durationMs
  if (!Number.isFinite(result)) throw publicInvalidData(`中转站返回的 ${field} 无效`)
  return new Date(result).toISOString()
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
  const expiresAt = optionalTimestamp(subscription.expires_at, 'subscription.expires_at')
  const specs = [
    ['daily', 'daily_usage_usd', 'daily_limit_usd', null, null],
    ['weekly', 'weekly_usage_usd', 'weekly_limit_usd', 'weekly_window_start', 7 * 24 * 60 * 60 * 1000],
    ['monthly', 'monthly_usage_usd', 'monthly_limit_usd', 'monthly_window_start', 30 * 24 * 60 * 60 * 1000],
  ]
  const candidates = []
  for (const [scope, usageField, limitField, windowField, durationMs] of specs) {
    const rawLimit = subscription[limitField]
    if (rawLimit === undefined || rawLimit === null || rawLimit === 0) continue
    const total = finiteNonNegative(rawLimit, `subscription.${limitField}`)
    if (total <= 0) continue
    const spent = finiteNonNegative(subscription[usageField] ?? 0, `subscription.${usageField}`)
    const remaining = Math.max(0, total - spent)
    const windowStart = windowField === null ? null : optionalTimestamp(subscription[windowField], `subscription.${windowField}`)
    const derivedResetAt = windowStart === null ? null : addDuration(windowStart, durationMs, `subscription.${windowField}`)
    const resetAt = derivedResetAt !== null && (expiresAt === null || Date.parse(derivedResetAt) < Date.parse(expiresAt))
      ? derivedResetAt
      : null
    candidates.push({ mode: 'subscription', remaining, spent, total, percent: percentOf(remaining, total), scope, resetAt, expiresAt })
  }
  if (candidates.length === 0) return { mode: 'unlimited', remaining: null, spent: usageSpent(payload), total: null, percent: null, scope: null, resetAt: null, expiresAt }
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

function originOf(baseURL) {
  return new URL(buildUsageUrls(baseURL, 'auto')[0]).origin
}

function managedCredentialRefs(baseURL) {
  const digest = createHash('sha256').update(originOf(baseURL)).digest('hex').slice(0, 32).toUpperCase()
  return [`${MANAGED_CREDENTIAL_PREFIX}${digest}_A`, `${MANAGED_CREDENTIAL_PREFIX}${digest}_B`]
}

function isManagedCredentialFor(baseURL, credentialRef) {
  return managedCredentialRefs(baseURL).includes(credentialRef)
}

export function resolveRelayConfig(providerSettings, config = DEFAULT_CONFIG, relaySettings = {}) {
  const normalized = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  const direct = normalizeRelaySettings({ usagePath: normalized.usagePath, ...relaySettings })
  if (direct.baseURL !== '') {
    return {
      displayName: normalized.displayName,
      usageURLs: buildUsageUrls(direct.baseURL, direct.usagePath),
      credentialRef: direct.credentialRef,
      source: 'plugin',
    }
  }
  if (normalized.baseURL !== '') {
    return {
      displayName: normalized.displayName,
      usageURLs: buildUsageUrls(normalized.baseURL, normalized.usagePath),
      credentialRef: normalized.credentialRef,
      source: 'composition',
    }
  }
  const providers = record(providerSettings)?.providers
  const provider = record(providers)?.[normalized.providerId]
  if (record(provider) === null) throw new PublicBalanceError('provider-not-configured', '请在 Relay Balance 设置中填写中转 URL 和 API Key', 503)
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.trim() : ''
  const credentialRef = typeof provider.apiKeyEnv === 'string' ? normalizeCredentialRef(provider.apiKeyEnv) : ''
  if (baseURL === '' || credentialRef === '') throw new PublicBalanceError('provider-not-configured', '请在 Relay Balance 设置中填写中转 URL 和 API Key', 503)
  return {
    displayName: normalized.displayName,
    usageURLs: buildUsageUrls(baseURL, normalized.usagePath),
    credentialRef,
    source: 'provider',
  }
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

function readCurrentRelayConfig(settings, normalizedConfig) {
  let providerSettings
  let relaySettings
  try {
    providerSettings = settings.get(PROVIDER_NAMESPACE)
    relaySettings = settings.get(SETTINGS_NAMESPACE)
  } catch {
    throw new PublicBalanceError('provider-config-unavailable', '暂时无法读取 Relay 配置', 503)
  }
  return resolveRelayConfig(providerSettings, normalizedConfig, relaySettings)
}

async function resolveApiKey(credentials, credentialRef) {
  let resolved
  try { resolved = await credentials.resolve(credentialRef) } catch { throw new PublicBalanceError('credential-unavailable', 'Relay 凭据暂时不可用', 503) }
  const apiKey = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
  if (apiKey === '') throw new PublicBalanceError('credential-not-configured', '请填写 API Key', 503)
  return apiKey
}

function normalizeApiKey(value) {
  if (typeof value !== 'string') return ''
  if (value === '') return ''
  const apiKey = value.trim()
  if (apiKey === '' || apiKey.length > 4096 || !/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new PublicBalanceError('invalid-request', 'API Key 格式无效', 400)
  }
  return apiKey
}

async function queryUsage({ usageURLs, apiKey, displayName, fetchImpl, now }) {
  const response = await fetchUsageResponse(usageURLs, apiKey, fetchImpl)
  let text
  try { text = await readLimitedText(response) } catch (error) { throw mapUpstreamFailure(error) }
  let payload
  try { payload = JSON.parse(text) } catch { throw publicInvalidData('中转站返回了无法解析的数据') }
  return normalizeSub2ApiUsage(payload, { displayName, fetchedAt: now().toISOString() })
}

export function createBalanceReader({ settings, credentials, config = DEFAULT_CONFIG, fetchImpl = fetch, now = () => new Date() }) {
  requireMethod(settings, 'settings', 'get')
  requireMethod(credentials, 'credentials', 'resolve')
  const normalizedConfig = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  let current = null

  async function readOnce() {
    const resolvedConfig = readCurrentRelayConfig(settings, normalizedConfig)
    const apiKey = await resolveApiKey(credentials, resolvedConfig.credentialRef)
    return queryUsage({ ...resolvedConfig, apiKey, fetchImpl, now })
  }

  return function readBalance() {
    if (current !== null) return current
    const operation = readOnce().finally(() => { if (current === operation) current = null })
    current = operation
    return operation
  }
}

export function createConnectionTester({ settings, credentials, config = DEFAULT_CONFIG, fetchImpl = fetch, now = () => new Date() }) {
  requireMethod(settings, 'settings', 'get')
  requireMethod(credentials, 'credentials', 'resolve')
  const normalizedConfig = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  return async function testConnection(input) {
    const baseURL = typeof input?.baseURL === 'string' ? input.baseURL.trim() : ''
    if (baseURL === '') throw new PublicBalanceError('invalid-request', '请填写中转 URL', 400)
    let candidate
    try {
      candidate = normalizeRelaySettings({
        baseURL,
        credentialRef: managedCredentialRefs(baseURL)[0],
        usagePath: input?.usagePath ?? 'auto',
      })
    } catch (error) {
      if (error instanceof PublicBalanceError) throw new PublicBalanceError('invalid-request', error.message, 400)
      throw new PublicBalanceError('invalid-request', '中转 URL 或额度接口无效', 400)
    }
    const usageURLs = buildUsageUrls(candidate.baseURL, candidate.usagePath)
    let apiKey = normalizeApiKey(input?.apiKey)
    if (apiKey === '') {
      const currentConfig = readCurrentRelayConfig(settings, normalizedConfig)
      const currentOrigin = new URL(currentConfig.usageURLs[0]).origin
      const candidateOrigin = new URL(usageURLs[0]).origin
      if (currentOrigin !== candidateOrigin) {
        throw new PublicBalanceError('api-key-required', '更换中转站时必须填写新的 API Key', 400)
      }
      apiKey = await resolveApiKey(credentials, currentConfig.credentialRef)
    }
    return queryUsage({
      usageURLs,
      apiKey,
      displayName: normalizedConfig.displayName,
      fetchImpl,
      now,
    })
  }
}

export function createConnectionSaver({ settings, credentials, testConnection }) {
  requireMethod(settings, 'settings', 'get')
  requireMethod(settings, 'settings', 'update')
  requireMethod(credentials, 'credentials', 'describe')
  requireMethod(credentials, 'credentials', 'set')
  requireMethod(credentials, 'credentials', 'unset')
  if (typeof testConnection !== 'function') throw new Error('dsh-relay-balance requires a connection tester')
  let queue = Promise.resolve()

  async function saveOnce(input) {
    const baseURL = typeof input?.baseURL === 'string' ? input.baseURL.trim() : ''
    const usagePath = typeof input?.usagePath === 'string' ? input.usagePath : 'auto'
    const apiKey = normalizeApiKey(input?.apiKey)
    const expectedRevision = input?.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new PublicBalanceError('invalid-request', '设置版本无效，请刷新后重试', 400)
    }
    const data = await testConnection({ baseURL, usagePath, apiKey })
    const current = normalizeRelaySettings(settings.get(SETTINGS_NAMESPACE) || {})
    let nextRef = current.credentialRef
    let stagedRef = ''
    if (apiKey !== '') {
      const refs = managedCredentialRefs(baseURL)
      const choices = refs.filter((ref) => ref !== current.credentialRef)
      let described
      try { described = await Promise.all(choices.map(async (ref) => [ref, await credentials.describe(ref)])) } catch {
        throw new PublicBalanceError('credential-unavailable', '暂时无法读取 Credential 状态', 503)
      }
      stagedRef = described.find(([, info]) => info?.writable === true)?.[0] || ''
      if (stagedRef === '') throw new PublicBalanceError('credential-read-only', '当前 Credential 存储不可写', 503)
      try { await credentials.set(stagedRef, apiKey) } catch { throw new PublicBalanceError('credential-unavailable', 'API Key 保存失败', 503) }
      nextRef = stagedRef
    }
    try {
      await settings.update(SETTINGS_NAMESPACE, { baseURL, credentialRef: nextRef, usagePath }, expectedRevision)
    } catch (error) {
      const conflict = error?.code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError'
      if (stagedRef !== '' && conflict) {
        try { await credentials.unset(stagedRef) } catch { /* Inactive staging data is safe to overwrite later. */ }
      }
      if (conflict) throw new PublicBalanceError('settings-conflict', '设置已变化，请刷新后重试', 409)
      throw new PublicBalanceError('settings-unavailable', '设置保存结果不确定，请刷新后确认', 503)
    }
    const oldRefs = current.baseURL === '' ? [] : managedCredentialRefs(current.baseURL)
    if (stagedRef !== '' && current.credentialRef !== stagedRef && oldRefs.includes(current.credentialRef)) {
      try { await credentials.unset(current.credentialRef) } catch { /* An orphaned old slot is inactive and reused on a later rotation. */ }
    }
    return data
  }

  return function saveConnection(input) {
    const operation = queue.then(() => saveOnce(input))
    queue = operation.catch(() => undefined)
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

async function readJsonBody(req) {
  const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].toLowerCase() : ''
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) throw new PublicBalanceError('invalid-request', '请求必须使用 JSON', 400)
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_REQUEST_BYTES) {
    throw new PublicBalanceError('request-too-large', '请求内容过大', 413)
  }
  const chunks = []
  let received = 0
  try {
    for await (const chunkValue of req) {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
      received += chunk.byteLength
      if (received > MAX_REQUEST_BYTES) throw new PublicBalanceError('request-too-large', '请求内容过大', 413)
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof PublicBalanceError) throw error
    throw new PublicBalanceError('invalid-request', '无法读取请求内容', 400)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PublicBalanceError('invalid-request', '请求 JSON 无效', 400) }
  if (record(value) === null || Array.isArray(value)) throw new PublicBalanceError('invalid-request', '请求 JSON 无效', 400)
  return value
}

function safePublicError(error) {
  return error instanceof PublicBalanceError ? error : new PublicBalanceError('internal-error', '中转额度查询暂时不可用', 500)
}

export function createConnectionTestHandler(testConnection) {
  return async function connectionTestHandler(req, res) {
    if (!isDirectLoopbackRequest(req)) {
      json(res, 403, { ok: false, error: { code: 'remote-access-disabled', message: 'Relay 设置仅允许本机访问' } })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '仅支持 POST 请求' } }, { allow: 'POST' })
      return
    }
    if (isCrossSite(req)) {
      json(res, 403, { ok: false, error: { code: 'forbidden', message: '拒绝跨站请求' } })
      return
    }
    try {
      const data = await testConnection(await readJsonBody(req))
      json(res, 200, { ok: true, data })
    } catch (error) {
      const safe = safePublicError(error)
      json(res, safe.statusCode, { ok: false, error: { code: safe.code, message: safe.message } })
    }
  }
}

export function createConnectionSaveHandler(saveConnection) {
  return createConnectionTestHandler(saveConnection)
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
      const safe = safePublicError(error)
      json(res, safe.statusCode, { ok: false, error: { code: safe.code, message: safe.message } })
    }
  }
}

function validateStoredRelaySettings(value, base) {
  const normalized = normalizeRelaySettings(value)
  if (normalized.baseURL === '') return
  if (isManagedCredentialFor(normalized.baseURL, normalized.credentialRef)) return
  if (normalized.credentialRef !== base.credentialRef || base.baseURL === '') {
    throw new Error('Relay credentialRef 只能使用插件管理的 Credential')
  }
  const currentOrigin = new URL(base.baseURL).origin
  const nextOrigin = new URL(normalized.baseURL).origin
  if (currentOrigin !== nextOrigin) throw new Error('更换中转站时必须使用插件管理的新 API Key')
}

function relaySettingsBase(settings, normalizedConfig) {
  if (normalizedConfig.baseURL !== '') {
    return { baseURL: normalizedConfig.baseURL, credentialRef: normalizedConfig.credentialRef, usagePath: normalizedConfig.usagePath }
  }
  let providerSettings
  try { providerSettings = settings.get(PROVIDER_NAMESPACE) } catch { return { baseURL: '', credentialRef: '', usagePath: normalizedConfig.usagePath } }
  const provider = record(record(providerSettings)?.providers)?.[normalizedConfig.providerId]
  if (record(provider) === null) return { baseURL: '', credentialRef: '', usagePath: normalizedConfig.usagePath }
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.trim() : ''
  const credentialRef = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
  try { return normalizeRelaySettings({ baseURL, credentialRef, usagePath: normalizedConfig.usagePath }) } catch { return { baseURL: '', credentialRef: '', usagePath: normalizedConfig.usagePath } }
}

export function apply(ctx, config) {
  requireMethod(ctx.settings, 'settings', 'get')
  requireMethod(ctx.settings, 'settings', 'register')
  requireMethod(ctx.settings, 'settings', 'update')
  requireMethod(ctx.credentials, 'credentials', 'resolve')
  requireMethod(ctx.credentials, 'credentials', 'describe')
  requireMethod(ctx.credentials, 'credentials', 'set')
  requireMethod(ctx.credentials, 'credentials', 'unset')
  requireMethod(ctx.webServer, 'webServer', 'register')
  const normalizedConfig = normalizePluginConfig({ ...DEFAULT_CONFIG, ...config })
  const base = relaySettingsBase(ctx.settings, normalizedConfig)
  ctx.settings.register(SETTINGS_NAMESPACE, RelaySettings, {
    base,
    validate: (value) => validateStoredRelaySettings(value, base),
  })
  const readBalance = createBalanceReader({ settings: ctx.settings, credentials: ctx.credentials, config: normalizedConfig })
  const testConnection = createConnectionTester({ settings: ctx.settings, credentials: ctx.credentials, config: normalizedConfig })
  const saveConnection = createConnectionSaver({ settings: ctx.settings, credentials: ctx.credentials, testConnection })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE_PATH,
    handler: createStatusHandler(readBalance, { allowRemote: normalizedConfig.allowRemote }),
  }), 'relay-balance: status route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TEST_ROUTE_PATH,
    handler: createConnectionTestHandler(testConnection),
  }), 'relay-balance: connection test route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SAVE_ROUTE_PATH,
    handler: createConnectionSaveHandler(saveConnection),
  }), 'relay-balance: connection save route')
}
