const ROUTE_PATH = '/nbapi-balance/status'
const PROVIDER_NAMESPACE = 'llm-pi-ai'
const PROVIDER_ID = 'nbcodex'
const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 1_048_576

export const name = 'dsh-nbapi-balance'
export const inject = ['settings', 'credentials', 'webServer']

class PublicBalanceError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message)
    this.name = 'PublicBalanceError'
    this.code = code
    this.statusCode = statusCode
  }
}

function requireMethod(owner, serviceName, methodName) {
  if (typeof owner?.[methodName] !== 'function') {
    throw new Error(`dsh-nbapi-balance requires ${serviceName}.${methodName}()`)
  }
}

function finiteNonNegative(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PublicBalanceError('invalid-upstream-data', `NBAPI 返回的 ${field} 无效`)
  }
  return value
}

export function normalizeUsage(payload, fetchedAt = new Date().toISOString()) {
  if (typeof payload !== 'object' || payload === null || payload.isValid !== true) {
    throw new PublicBalanceError('invalid-upstream-data', 'NBAPI 返回了无效的额度数据')
  }

  const remaining = finiteNonNegative(payload.remaining, 'remaining')
  const usage = payload.usage
  const totalUsage = typeof usage === 'object' && usage !== null ? usage.total : undefined
  const spent = finiteNonNegative(
    typeof totalUsage === 'object' && totalUsage !== null ? totalUsage.actual_cost : undefined,
    'usage.total.actual_cost',
  )
  const total = remaining + spent
  if (!Number.isFinite(total) || total <= 0) {
    throw new PublicBalanceError('invalid-upstream-data', 'NBAPI 返回的总额度无效')
  }

  const unit = typeof payload.unit === 'string' && payload.unit.trim() !== ''
    ? payload.unit.trim().toUpperCase()
    : 'USD'
  const planName = typeof payload.planName === 'string' ? payload.planName.trim() : ''
  const percent = Math.min(100, Math.max(0, remaining / total * 100))

  return { remaining, spent, total, percent, unit, planName, fetchedAt }
}

export function resolveProviderConfig(settingsValue) {
  const providers = typeof settingsValue === 'object' && settingsValue !== null
    ? settingsValue.providers
    : undefined
  const provider = typeof providers === 'object' && providers !== null
    ? providers[PROVIDER_ID]
    : undefined
  if (typeof provider !== 'object' || provider === null) {
    throw new PublicBalanceError('provider-not-configured', '未找到 NB Codex 供应商配置', 503)
  }

  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.trim().replace(/\/+$/, '') : ''
  const apiKeyEnv = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : ''
  if (baseURL === '' || apiKeyEnv === '') {
    throw new PublicBalanceError('provider-not-configured', 'NB Codex 配置缺少 baseURL 或 apiKeyEnv', 503)
  }

  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new PublicBalanceError('provider-not-configured', 'NB Codex baseURL 无效', 503)
  }
  if (parsed.protocol !== 'https:') {
    throw new PublicBalanceError('provider-not-configured', 'NB Codex baseURL 必须使用 HTTPS', 503)
  }

  return { usageURL: `${baseURL}/usage`, apiKeyEnv }
}

function responseTooLarge() {
  return new PublicBalanceError('upstream-response-too-large', 'NBAPI 响应过大')
}

function invalidUtf8() {
  return new PublicBalanceError('invalid-upstream-data', 'NBAPI 返回了无效的 UTF-8 数据')
}

function responseReadUnavailable() {
  return new PublicBalanceError('upstream-unavailable', '暂时无法读取 NBAPI 响应')
}

function decodeUtf8(decoder, chunk, options) {
  try {
    return decoder.decode(chunk, options)
  } catch {
    throw invalidUtf8()
  }
}

async function cancelBody(body) {
  if (typeof body?.cancel !== 'function') return
  try {
    await body.cancel()
  } catch {
    // Cancellation is best-effort and must not replace the public error.
  }
}

function declaredResponseBytes(response) {
  let raw
  try {
    raw = response.headers?.get?.('content-length')
  } catch {
    return undefined
  }
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
    try {
      text = await response.text()
    } catch {
      await cancelBody(response.body)
      throw responseReadUnavailable()
    }
    let byteLength
    try {
      byteLength = new TextEncoder().encode(text).byteLength
    } catch {
      await cancelBody(response.body)
      throw responseReadUnavailable()
    }
    if (byteLength > MAX_RESPONSE_BYTES) {
      await cancelBody(response.body)
      throw responseTooLarge()
    }
    return text
  }

  let reader
  try {
    reader = response.body.getReader()
  } catch {
    throw responseReadUnavailable()
  }
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
    try {
      await reader.cancel()
    } catch {
      // Cancellation is best-effort and must not replace the public error.
    }
    if (error instanceof PublicBalanceError) throw error
    throw responseReadUnavailable()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A released or invalid test reader needs no further cleanup.
    }
  }
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
}

function mapUpstreamFailure(error) {
  if (error instanceof PublicBalanceError) return error
  if (isTimeoutError(error)) return new PublicBalanceError('upstream-timeout', 'NBAPI 查询超时', 504)
  return new PublicBalanceError('upstream-unavailable', '暂时无法连接 NBAPI')
}

export function createBalanceReader({ settings, credentials, fetchImpl = fetch, now = () => new Date() }) {
  requireMethod(settings, 'settings', 'get')
  requireMethod(credentials, 'credentials', 'resolve')

  return async function readBalance() {
    let settingsValue
    try {
      settingsValue = settings.get(PROVIDER_NAMESPACE)
    } catch {
      throw new PublicBalanceError('provider-config-unavailable', '暂时无法读取 NB Codex 供应商配置', 503)
    }
    const { usageURL, apiKeyEnv } = resolveProviderConfig(settingsValue)

    let resolved
    try {
      resolved = await credentials.resolve(apiKeyEnv)
    } catch {
      throw new PublicBalanceError('credential-unavailable', 'NBAPI 凭据暂时不可用', 503)
    }
    const apiKey = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (apiKey === '') {
      throw new PublicBalanceError('credential-not-configured', 'NBAPI 凭据尚未配置', 503)
    }

    let response
    try {
      response = await fetchImpl(usageURL, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw mapUpstreamFailure(error)
    }

    if (response?.redirected === true || (response?.status >= 300 && response?.status <= 399)) {
      await cancelBody(response?.body)
      throw new PublicBalanceError('upstream-redirect-rejected', 'NBAPI 重定向已被拒绝')
    }
    if (response?.ok !== true) {
      await cancelBody(response?.body)
      const authFailure = response?.status === 401 || response?.status === 403
      throw new PublicBalanceError(
        authFailure ? 'upstream-auth-failed' : 'upstream-http-error',
        authFailure ? 'NBAPI 鉴权失败' : `NBAPI 查询失败（HTTP ${Number.isInteger(response?.status) ? response.status : '未知'}）`,
      )
    }

    let text
    try {
      text = await readLimitedText(response)
    } catch (error) {
      throw mapUpstreamFailure(error)
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new PublicBalanceError('invalid-upstream-data', 'NBAPI 返回了无法解析的数据')
    }
    return normalizeUsage(payload, now().toISOString())
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
  } catch {
    return true
  }
}

export function createStatusHandler(readBalance) {
  return async function statusHandler(req, res) {
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
      const safe = error instanceof PublicBalanceError
        ? error
        : new PublicBalanceError('internal-error', '余额查询暂时不可用', 500)
      json(res, safe.statusCode, { ok: false, error: { code: safe.code, message: safe.message } })
    }
  }
}

export function apply(ctx) {
  requireMethod(ctx.settings, 'settings', 'get')
  requireMethod(ctx.credentials, 'credentials', 'resolve')
  requireMethod(ctx.webServer, 'webServer', 'register')
  const readBalance = createBalanceReader({ settings: ctx.settings, credentials: ctx.credentials })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createStatusHandler(readBalance) }),
    'nbapi-balance: status route',
  )
}
