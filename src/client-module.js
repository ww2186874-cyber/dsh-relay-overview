const React = require('react')

const ROUTE_PATH = '/relay-balance/status'
const HISTORY_ROUTE_PATH = '/relay-balance/history'
const TEST_ROUTE_PATH = '/relay-balance/test'
const SAVE_ROUTE_PATH = '/relay-balance/save'
const SETTINGS_NAMESPACE = 'dsh-relay-balance'
const REFRESH_EVENT = 'relay-balance:refresh'
const REFRESH_MS = 60_000
const CLIENT_TIMEOUT_MS = 20_000
const HISTORY_DAYS = 30

function toneOf(percent, mode) {
  if (mode === 'unlimited') return 'healthy'
  if (!Number.isFinite(percent)) return 'neutral'
  if (percent < 10) return 'danger'
  if (percent <= 30) return 'warning'
  return 'healthy'
}

function money(value, unit) {
  if (!Number.isFinite(value)) return '—'
  return unit === 'USD' ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${unit}`
}

function compactMoney(value, unit) {
  if (!Number.isFinite(value)) return '∞'
  const prefix = unit === 'USD' ? '$' : ''
  if (value >= 1000) return `${prefix}${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  if (value >= 100) return `${prefix}${Math.round(value)}`
  return `${prefix}${value.toFixed(value >= 10 ? 0 : 1)}`
}

function trimDecimal(value, digits) {
  return value.toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

function compactMetric(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000, value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 10_000) return `${trimDecimal(value / 1_000, value >= 100_000 ? 0 : 1)}K`
  return Math.round(value).toLocaleString('en-US')
}

function historyMoney(value, unit) {
  if (!Number.isFinite(value) || value < 0) return '—'
  let amount
  if (value === 0) amount = '0'
  else if (value < 0.0001) amount = trimDecimal(value, 6)
  else if (value < 0.01) amount = trimDecimal(value, 4)
  else if (value < 1) amount = trimDecimal(value, 3)
  else if (value < 1000) amount = value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  else if (value < 1_000_000) amount = `${trimDecimal(value / 1000, value >= 10_000 ? 0 : 1)}K`
  else amount = `${trimDecimal(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  return unit === 'USD' ? `$${amount}` : `${amount} ${unit}`
}

function historyDateText(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match === null ? value : `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
}

function decodeModelUsage(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || !Number.isSafeInteger(value.totalRequests) || value.totalRequests < 0
    || !Array.isArray(value.models) || value.models.length > 5
    || !Number.isSafeInteger(value.otherRequests) || value.otherRequests < 0) {
    throw new Error('模型调用数据无效')
  }
  const names = new Set()
  const models = value.models.map((entry) => {
    const model = typeof entry?.model === 'string' ? entry.model : ''
    if (model === '' || model.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(model) || names.has(model)
      || !Number.isSafeInteger(entry.requests) || entry.requests <= 0) {
      throw new Error('模型调用数据无效')
    }
    names.add(model)
    return { model, requests: entry.requests }
  })
  const represented = models.reduce((total, entry) => total + entry.requests, value.otherRequests)
  if (!Number.isSafeInteger(represented) || represented !== value.totalRequests) throw new Error('模型调用数据无效')
  return { totalRequests: value.totalRequests, models, otherRequests: value.otherRequests }
}

function modelUsageSlices(usage) {
  if (usage === null || usage.totalRequests <= 0) return []
  const slices = usage.models.map((entry, index) => ({ key: `model-${index}`, label: entry.model, requests: entry.requests }))
  if (usage.otherRequests > 0) slices.push({ key: 'other', label: '其他模型', requests: usage.otherRequests })
  let offset = 0
  return slices.map((entry) => {
    const percentage = entry.requests / usage.totalRequests * 100
    const result = { ...entry, percentage, offset }
    offset += percentage
    return result
  })
}

function decodeHistoryData(value) {
  if (typeof value !== 'object' || value === null || value.timeZone !== 'Asia/Shanghai' || !Array.isArray(value.days) || value.days.length !== HISTORY_DAYS) {
    throw new Error('每日使用数据无效')
  }
  const days = value.days.map((day, index) => {
    if (typeof day !== 'object' || day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
      || !Number.isFinite(day.actualCost) || day.actualCost < 0
      || !Number.isSafeInteger(day.requests) || day.requests < 0
      || !Number.isSafeInteger(day.totalTokens) || day.totalTokens < 0) {
      throw new Error('每日使用数据无效')
    }
    const milliseconds = Date.parse(`${day.date}T00:00:00.000Z`)
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== day.date) throw new Error('每日使用数据无效')
    if (index > 0) {
      const previous = Date.parse(`${value.days[index - 1].date}T00:00:00.000Z`)
      if (milliseconds - previous !== 86_400_000) throw new Error('每日使用数据无效')
    }
    return { date: day.date, actualCost: day.actualCost, requests: day.requests, totalTokens: day.totalTokens }
  })
  if (value.from !== days[0].date || value.through !== days[days.length - 1].date) throw new Error('每日使用数据无效')
  const summary = days.reduce((total, day) => ({
    actualCost: total.actualCost + day.actualCost,
    requests: total.requests + day.requests,
    totalTokens: total.totalTokens + day.totalTokens,
  }), { actualCost: 0, requests: 0, totalTokens: 0 })
  if (!Number.isFinite(summary.actualCost) || !Number.isSafeInteger(summary.requests) || !Number.isSafeInteger(summary.totalTokens)) {
    throw new Error('每日使用数据无效')
  }
  return {
    unit: typeof value.unit === 'string' && value.unit !== '' ? value.unit : 'USD',
    timeZone: value.timeZone,
    from: value.from,
    through: value.through,
    days,
    summary,
    modelUsage: (() => { try { return decodeModelUsage(value.modelUsage) } catch { return null } })(),
    fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : '',
  }
}

function heatScale(days) {
  return [...new Set(days.map((day) => day.actualCost).filter((value) => value > 0).sort((a, b) => a - b))]
}

function heatLevel(value, scale) {
  if (!Number.isFinite(value) || value <= 0 || scale.length === 0) return 0
  if (scale.length === 1) return 4
  let index = scale.findIndex((threshold) => value <= threshold)
  if (index < 0) index = scale.length - 1
  return Math.max(1, Math.min(4, 1 + Math.round(index / (scale.length - 1) * 3)))
}

function weekdayOf(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay()
}

function heatmapTooltipPosition(cellRect, tooltipSize, viewport) {
  const gap = 8
  const edge = 8
  const maxLeft = Math.max(edge, viewport.width - tooltipSize.width - edge)
  const left = Math.min(maxLeft, Math.max(edge, cellRect.left + (cellRect.width - tooltipSize.width) / 2))
  const above = cellRect.top - tooltipSize.height - gap
  const top = above >= edge ? above : Math.min(Math.max(edge, viewport.height - tooltipSize.height - edge), cellRect.bottom + gap)
  return { left, top }
}

function percentText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
}

function timestampMilliseconds(value) {
  if (typeof value !== 'string') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function timestampText(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  return match === null ? null : `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`
}

function balanceTimingText(data, now = Date.now()) {
  if (data?.mode !== 'subscription' || !Number.isFinite(now)) return null
  const expiresAt = timestampMilliseconds(data.expiresAt)
  const resetAt = timestampMilliseconds(data.resetAt)
  const expiryText = timestampText(data.expiresAt)
  if (expiresAt === null || resetAt === null || expiryText === null) return null
  const expiryDays = Math.max(0, Math.floor((expiresAt - now) / 86_400_000))
  const resetHoursTotal = Math.max(0, Math.floor((resetAt - now) / 3_600_000))
  const resetDays = Math.floor(resetHoursTotal / 24)
  const resetHours = resetHoursTotal % 24
  return `剩余${expiryDays}天（${expiryText}） ${resetDays}d${resetHours}h后重置`
}

function timingTooltipPosition(cardRect, tooltipSize, viewport) {
  const gap = 8
  const edge = 8
  const maxLeft = Math.max(edge, viewport.width - tooltipSize.width - edge)
  const maxTop = Math.max(edge, viewport.height - tooltipSize.height - edge)
  return {
    left: Math.min(maxLeft, Math.max(edge, cardRect.right + gap)),
    top: Math.min(maxTop, Math.max(edge, cardRect.top + (cardRect.height - tooltipSize.height) / 2)),
  }
}

function scopeLabel(data) {
  if (data.mode === 'wallet') return '钱包余额'
  if (data.mode === 'unlimited') return '不限额'
  const scopes = {
    total: 'Key 配额',
    '5h': '5 小时额度',
    '1d': '日额度',
    '7d': '7 日额度',
    daily: '日额度',
    weekly: '周额度',
    monthly: '月额度',
    window: '窗口额度',
  }
  return scopes[data.scope] || '可用额度'
}

function amountText(data) {
  const scope = scopeLabel(data)
  if (data.mode === 'wallet') {
    return `${scope} ${money(data.remaining, data.unit)}${Number.isFinite(data.spent) ? ` · 当前 Key 累计消费 ${money(data.spent, data.unit)}` : ''}`
  }
  if (data.mode === 'unlimited') {
    return `${scope}${Number.isFinite(data.spent) ? ` · 当前 Key 累计消费 ${money(data.spent, data.unit)}` : ''}`
  }
  return `${scope} · 剩余 ${money(data.remaining, data.unit)} / 限额 ${money(data.total, data.unit)}`
}

function visualAmountText(data) {
  if (data.mode === 'unlimited') return '∞'
  if (data.mode === 'wallet') return money(data.remaining, data.unit)
  return `${money(data.remaining, data.unit)}/${money(data.total, data.unit)}`
}

function createBalanceRequestManager({
  fetchImpl,
  createController,
  setTimeoutImpl,
  clearTimeoutImpl,
  onLoading,
  onSuccess,
  onError,
}) {
  let current = null

  function refresh() {
    if (current !== null) return current.promise

    const controller = createController()
    const record = { controller, promise: null, timer: null, timedOut: false }
    onLoading()
    record.timer = setTimeoutImpl(() => {
      record.timedOut = true
      controller.abort()
    }, CLIENT_TIMEOUT_MS)
    record.promise = Promise.resolve()
      .then(() => fetchImpl(ROUTE_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      }))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (record.timedOut) throw new Error('client-timeout')
        if (!response.ok || body?.ok !== true || typeof body.data !== 'object' || body.data === null) {
          throw new Error(body?.error?.message || `额度查询失败（HTTP ${response.status}）`)
        }
        return body.data
      })
      .then((data) => {
        if (!controller.signal.aborted) onSuccess(data)
        return data
      })
      .catch((error) => {
        if (record.timedOut) onError('中转额度查询超时')
        else if (!controller.signal.aborted) onError(error?.message || '中转额度查询失败')
        return null
      })
      .finally(() => {
        clearTimeoutImpl(record.timer)
        if (current === record) current = null
      })
    current = record
    return record.promise
  }

  function abort() {
    const record = current
    if (record === null) return
    current = null
    clearTimeoutImpl(record.timer)
    record.controller.abort()
  }

  return { refresh, abort }
}

function createHistoryRequestManager({
  fetchImpl,
  createController,
  setTimeoutImpl,
  clearTimeoutImpl,
  onLoading,
  onSuccess,
  onError,
}) {
  let current = null

  function refresh() {
    if (current !== null) return current.promise
    const controller = createController()
    const record = { controller, promise: null, timer: null, timedOut: false }
    onLoading()
    record.timer = setTimeoutImpl(() => {
      record.timedOut = true
      controller.abort()
    }, CLIENT_TIMEOUT_MS)
    record.promise = Promise.resolve()
      .then(() => fetchImpl(HISTORY_ROUTE_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      }))
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (record.timedOut) throw new Error('client-timeout')
        if (!response.ok || body?.ok !== true || typeof body.data !== 'object' || body.data === null) {
          throw new Error(body?.error?.message || `每日使用查询失败（HTTP ${response.status}）`)
        }
        return decodeHistoryData(body.data)
      })
      .then((data) => {
        if (!controller.signal.aborted) onSuccess(data)
        return data
      })
      .catch((error) => {
        if (record.timedOut) onError('每日使用查询超时')
        else if (!controller.signal.aborted) onError(error?.message || '每日使用查询失败')
        return null
      })
      .finally(() => {
        clearTimeoutImpl(record.timer)
        if (current === record) current = null
      })
    current = record
    return record.promise
  }

  function abort() {
    const record = current
    if (record === null) return
    current = null
    clearTimeoutImpl(record.timer)
    record.controller.abort()
  }

  return { refresh, abort }
}

function installRefreshLifecycle(manager, windowObject, documentObject) {
  manager.refresh()
  const interval = windowObject.setInterval(() => {
    if (documentObject.visibilityState === 'visible') manager.refresh()
  }, REFRESH_MS)
  const onVisibility = () => {
    if (documentObject.visibilityState === 'visible') manager.refresh()
  }
  documentObject.addEventListener('visibilitychange', onVisibility)
  windowObject.addEventListener(REFRESH_EVENT, manager.refresh)
  return () => {
    windowObject.clearInterval(interval)
    documentObject.removeEventListener('visibilitychange', onVisibility)
    windowObject.removeEventListener(REFRESH_EVENT, manager.refresh)
    manager.abort()
  }
}

function installHistoryRefreshLifecycle(manager, windowObject) {
  manager.refresh()
  windowObject.addEventListener(REFRESH_EVENT, manager.refresh)
  return () => {
    windowObject.removeEventListener(REFRESH_EVENT, manager.refresh)
    manager.abort()
  }
}

function decodeRelaySettings(value) {
  if (typeof value !== 'object' || value === null) return undefined
  return {
    baseURL: typeof value.baseURL === 'string' ? value.baseURL : '',
    credentialRef: typeof value.credentialRef === 'string' ? value.credentialRef : '',
    usagePath: typeof value.usagePath === 'string' ? value.usagePath : 'auto',
  }
}

function rpcValue(response) {
  if (response?.result?.ok === true) return response.result.value
  throw new Error(response?.result?.error?.message || '操作失败')
}

async function callRelayConnection(fetchImpl, route, input, signal) {
  const response = await fetchImpl(route, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    body: JSON.stringify(input),
    signal,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.ok !== true || typeof body.data !== 'object' || body.data === null) {
    throw new Error(body?.error?.message || `测试失败（HTTP ${response.status}）`)
  }
  return body.data
}

function modelPercentageText(value) {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  if (value < 0.1) return '<0.1%'
  return `${trimDecimal(value, value >= 10 ? 0 : 1)}%`
}

function detailEventProps(onDetailEvent, key, title, detail, focusable) {
  if (typeof onDetailEvent !== 'function') return {}
  const pointerEnter = (event) => {
    if (event.pointerType !== 'touch') onDetailEvent('show', event, key, title, detail)
  }
  const pointerLeave = (event) => {
    if (event.pointerType !== 'touch') onDetailEvent('hide', event, key, title, detail)
  }
  const pointerDown = (event) => {
    event.stopPropagation()
    if (event.pointerType !== 'touch') return
    event.preventDefault()
    onDetailEvent('toggle', event, key, title, detail)
  }
  return {
    onPointerEnter: pointerEnter,
    onPointerLeave: pointerLeave,
    onPointerDown: pointerDown,
    ...(focusable ? {
      onFocus: (event) => onDetailEvent('show', event, key, title, detail),
      onBlur: (event) => onDetailEvent('hide', event, key, title, detail),
    } : {}),
  }
}

function ModelUsageDonut({ usage, loading = false, onDetailEvent = null }) {
  if (loading) {
    return React.createElement('section', { className: 'relay-model is-loading', 'aria-label': '模型调用量' },
      React.createElement('div', { className: 'relay-model__empty', role: 'status' }, '正在加载模型统计…'))
  }
  if (usage === null || usage.totalRequests <= 0) {
    return React.createElement('section', { className: 'relay-model is-empty', 'aria-label': '模型调用量' },
      React.createElement('div', { className: 'relay-model__empty' }, usage === null ? '中转站未提供模型统计' : '近 30 天暂无模型调用'))
  }
  const slices = modelUsageSlices(usage)
  const segments = slices.map((slice, index) => {
    const percentage = modelPercentageText(slice.percentage)
    const tooltipDetail = `${slice.requests.toLocaleString('en-US')} 次调用 · ${percentage}`
    return React.createElement('circle', {
      key: slice.key,
      className: `relay-model__segment relay-model__segment--${index + 1}`,
      cx: 21,
      cy: 21,
      r: 15.9155,
      pathLength: 100,
      transform: 'rotate(-90 21 21)',
      style: { strokeDasharray: `${slice.percentage} ${100 - slice.percentage}`, strokeDashoffset: slice.offset === 0 ? 0 : -slice.offset },
      ...detailEventProps(onDetailEvent, slice.key, slice.label, tooltipDetail, false),
    })
  })
  const legend = slices.map((slice, index) => {
    const percentage = modelPercentageText(slice.percentage)
    const accessibleDetail = `${slice.label}，${slice.requests.toLocaleString('en-US')} 次调用，占 ${percentage}`
    const tooltipDetail = `${slice.requests.toLocaleString('en-US')} 次调用 · ${percentage}`
    return React.createElement('li', { key: slice.key },
      React.createElement('button', {
        type: 'button',
        className: 'relay-model__legend-button',
        'aria-label': accessibleDetail,
        ...detailEventProps(onDetailEvent, slice.key, slice.label, tooltipDetail, true),
      },
      React.createElement('span', { className: `relay-model__swatch relay-model__swatch--${index + 1}`, 'aria-hidden': 'true' }),
      React.createElement('span', { className: 'relay-model__name' }, slice.label),
      React.createElement('span', { className: 'relay-model__value' }, `${compactMetric(slice.requests)} · ${percentage}`)))
  })
  return React.createElement('section', { className: 'relay-model', 'aria-label': '模型调用量' },
    React.createElement('div', { className: 'relay-model__body' },
      React.createElement('div', { className: 'relay-model__chart' },
        React.createElement('svg', { viewBox: '0 0 42 42', 'aria-hidden': 'true', focusable: 'false' },
          React.createElement('circle', { className: 'relay-model__track', cx: 21, cy: 21, r: 15.9155, pathLength: 100, 'aria-hidden': 'true' }),
          segments),
        React.createElement('span', { className: 'relay-model__center', 'aria-hidden': 'true' },
          React.createElement('strong', null, compactMetric(usage.totalRequests)),
          React.createElement('small', null, '次调用'))),
      React.createElement('ol', { className: 'relay-model__legend', 'aria-label': '模型调用量明细' }, legend)))
}

function DailyUsageHeatmap({ enabled }) {
  const titleId = React.useId()
  const [state, setState] = React.useState({ data: null, loading: enabled, error: null })
  const mounted = React.useRef(false)
  const manager = React.useRef(null)
  const tooltip = React.useRef(null)
  const tooltipTarget = React.useRef(null)

  if (manager.current === null) {
    manager.current = createHistoryRequestManager({
      fetchImpl: (...args) => fetch(...args),
      createController: () => new AbortController(),
      setTimeoutImpl: (...args) => window.setTimeout(...args),
      clearTimeoutImpl: (id) => window.clearTimeout(id),
      onLoading: () => {
        if (mounted.current) setState((previous) => ({ ...previous, loading: true, error: null }))
      },
      onSuccess: (data) => {
        if (mounted.current) setState({ data, loading: false, error: null })
      },
      onError: (message) => {
        if (mounted.current) setState((previous) => ({ ...previous, loading: false, error: message }))
      },
    })
  }

  const hideTooltip = React.useCallback(() => {
    tooltip.current?.remove()
    tooltip.current = null
    tooltipTarget.current = null
  }, [])
  const showDetailTooltip = React.useCallback((event, key, title, detail) => {
    hideTooltip()
    const tag = document.createElement('div')
    tag.className = 'relay-history__tooltip'
    tag.setAttribute('aria-hidden', 'true')
    const titleLine = document.createElement('strong')
    titleLine.textContent = title
    const detailLine = document.createElement('span')
    detailLine.textContent = detail
    tag.append(titleLine, detailLine)
    document.body.appendChild(tag)
    const targetRect = event.currentTarget.getBoundingClientRect()
    const tooltipRect = tag.getBoundingClientRect()
    const position = heatmapTooltipPosition(targetRect, tooltipRect, { width: window.innerWidth, height: window.innerHeight })
    tag.style.left = `${position.left}px`
    tag.style.top = `${position.top}px`
    tag.dataset.visible = 'true'
    tooltip.current = tag
    tooltipTarget.current = key
  }, [hideTooltip])
  const handleDetailEvent = React.useCallback((action, event, key, title, detail) => {
    if (action === 'hide') {
      if (tooltipTarget.current === key) hideTooltip()
      return
    }
    if (action === 'toggle' && tooltipTarget.current === key) {
      hideTooltip()
      return
    }
    showDetailTooltip(event, key, title, detail)
  }, [hideTooltip, showDetailTooltip])
  const refresh = React.useCallback(() => enabled ? manager.current.refresh() : Promise.resolve(null), [enabled])
  React.useEffect(() => {
    mounted.current = true
    if (!enabled) {
      setState({ data: null, loading: false, error: null })
      return () => {
        mounted.current = false
        hideTooltip()
        manager.current.abort()
      }
    }
    setState((previous) => ({ ...previous, loading: true, error: null }))
    const dispose = installHistoryRefreshLifecycle(manager.current, window)
    const dismiss = () => hideTooltip()
    const dismissWithEscape = (event) => { if (event.key === 'Escape') hideTooltip() }
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', dismissWithEscape)
    return () => {
      mounted.current = false
      hideTooltip()
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', dismissWithEscape)
      dispose()
    }
  }, [enabled, hideTooltip, refresh])
  React.useEffect(() => hideTooltip(), [hideTooltip, state.data, state.loading, state.error])

  const data = state.data
  const scale = data === null ? [] : heatScale(data.days)
  const summaryText = data === null
    ? (state.loading ? '正在加载…' : (enabled ? '暂无数据' : '等待配置'))
    : `${historyMoney(data.summary.actualCost, data.unit)} · ${compactMetric(data.summary.requests)} 次 · ${compactMetric(data.summary.totalTokens)} Token`
  const cells = []
  if (data !== null) {
    const leading = weekdayOf(data.days[0].date)
    for (let index = 0; index < leading; index += 1) {
      cells.push(React.createElement('span', { key: `leading-${index}`, className: 'relay-history__blank', 'aria-hidden': 'true' }))
    }
    for (const day of data.days) {
      const accessibleDetail = `${historyDateText(day.date)}，扣费 ${historyMoney(day.actualCost, data.unit)}，${day.requests.toLocaleString('en-US')} 次请求，${compactMetric(day.totalTokens)} Token`
      const tooltipDetail = `${historyMoney(day.actualCost, data.unit)} · ${day.requests.toLocaleString('en-US')} 次 · ${compactMetric(day.totalTokens)} Token`
      cells.push(React.createElement('button', {
        key: day.date,
        type: 'button',
        className: `relay-history__day relay-history__day--${heatLevel(day.actualCost, scale)}${day.date === data.through ? ' is-today' : ''}`,
        'aria-label': accessibleDetail,
        ...detailEventProps(handleDetailEvent, `day-${day.date}`, historyDateText(day.date), tooltipDetail, true),
      }))
    }
  } else if (state.loading) {
    for (let index = 0; index < 35; index += 1) {
      cells.push(React.createElement('span', { key: `loading-${index}`, className: 'relay-history__day relay-history__day--loading', 'aria-hidden': 'true' }))
    }
  }

  return React.createElement('section', { className: `relay-history${state.loading ? ' is-loading' : ''}`, 'aria-labelledby': titleId },
    React.createElement('header', { className: 'relay-history__header' },
      React.createElement('h3', { id: titleId }, '近 30 天使用情况'),
      React.createElement('div', { className: 'relay-history__summary' },
        React.createElement('span', null, summaryText),
        React.createElement('button', {
          type: 'button',
          className: 'relay-history__refresh',
          disabled: state.loading || !enabled,
          'aria-label': state.loading ? '正在刷新每日使用情况' : '刷新每日使用情况',
          onClick: refresh,
        }, '↻'))),
    cells.length > 0
      ? React.createElement('div', { className: 'relay-history__content' },
        React.createElement('div', { className: 'relay-history__calendar' },
          React.createElement('div', { className: 'relay-history__grid', role: 'group', 'aria-label': '最近 30 天每日实际扣费热力图' }, cells)),
        React.createElement(ModelUsageDonut, {
          usage: data?.modelUsage ?? null,
          loading: state.loading && data === null,
          onDetailEvent: handleDetailEvent,
        }))
      : React.createElement('p', { className: 'relay-history__empty' }, enabled ? '暂时没有可显示的每日使用数据。' : '保存中转 URL 和 API Key 后即可查看。'),
    state.error !== null ? React.createElement('p', { className: 'relay-history__error', role: 'status' }, state.error) : null)
}

function RelaySettingsSection({ relaySettings, api }) {
  const subscribe = React.useCallback((listener) => relaySettings.subscribe(listener), [relaySettings])
  const getSnapshot = React.useCallback(() => relaySettings.getSnapshot(), [relaySettings])
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const value = snapshot.value || { baseURL: '', credentialRef: '', usagePath: 'auto' }
  const [baseURL, setBaseURL] = React.useState(value.baseURL)
  const [apiKey, setApiKey] = React.useState('')
  const [credentialInfo, setCredentialInfo] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState(null)
  const operation = React.useRef(null)

  React.useEffect(() => {
    setBaseURL(value.baseURL)
  }, [value.baseURL])
  React.useEffect(() => {
    let active = true
    const refs = value.credentialRef === '' ? [] : [value.credentialRef]
    api.credentials.describe({ refs })
      .then((response) => {
        const result = rpcValue(response)
        if (active) setCredentialInfo(result.credentials)
      })
      .catch(() => { if (active) setCredentialInfo(null) })
    return () => { active = false }
  }, [api, value.credentialRef])
  React.useEffect(() => () => {
    operation.current?.abort()
    operation.current = null
  }, [])

  const configured = credentialInfo?.[value.credentialRef]?.configured === true
  const writable = snapshot.status === 'ready' && snapshot.writable === true
  const controlsDisabled = busy || !writable || credentialInfo === null
  const run = async (save) => {
    const nextURL = baseURL.trim()
    const nextKey = apiKey.trim()
    if (nextURL === '') { setNotice({ ok: false, text: '请填写中转 URL' }); return }
    if (!configured && nextKey === '') { setNotice({ ok: false, text: '请填写 API Key' }); return }
    const controller = new AbortController()
    operation.current?.abort()
    operation.current = controller
    const timeout = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
    setBusy(true)
    setNotice(null)
    try {
      const route = save ? SAVE_ROUTE_PATH : TEST_ROUTE_PATH
      const data = await callRelayConnection(fetch, route, {
        baseURL: nextURL,
        usagePath: 'auto',
        apiKey: nextKey,
        ...(save ? { expectedRevision: snapshot.revision } : {}),
      }, controller.signal)
      if (save) {
        setApiKey('')
        window.dispatchEvent(new Event(REFRESH_EVENT))
      }
      const detail = data.mode === 'unlimited'
        ? '不限额'
        : `${visualAmountText(data)}${Number.isFinite(data.percent) ? ` · ${percentText(data.percent)}` : ''}`
      if (!controller.signal.aborted) setNotice({ ok: true, text: save ? `已保存 · ${detail}` : `连接成功 · ${detail}` })
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ ok: false, text: error?.message || '操作失败' })
      else if (operation.current === controller) setNotice({ ok: false, text: '操作超时，请重试' })
    } finally {
      window.clearTimeout(timeout)
      if (operation.current === controller) {
        operation.current = null
        setBusy(false)
      }
    }
  }

  if (snapshot.status === 'loading') return React.createElement('section', { className: 'relay-settings' }, '正在读取设置…')
  if (snapshot.status === 'unavailable') return React.createElement('section', { className: 'relay-settings' }, '设置服务暂不可用')

  return React.createElement('section', { className: 'relay-settings' },
    React.createElement('header', { className: 'relay-settings__header' },
      React.createElement('h2', null, '中转余额'),
      React.createElement('p', null, '填写中转 URL 和 API Key，即可查询并显示剩余额度。')),
    React.createElement(DailyUsageHeatmap, { enabled: configured && value.baseURL.trim() !== '' }),
    React.createElement('label', { className: 'relay-settings__field' },
      React.createElement('span', null, '中转 URL'),
      React.createElement('input', {
        type: 'url', value: baseURL, disabled: controlsDisabled,
        placeholder: 'https://relay.example/v1', autoComplete: 'url', spellCheck: false,
        onChange: (event) => setBaseURL(event.target.value),
      })),
    React.createElement('label', { className: 'relay-settings__field' },
      React.createElement('span', null, 'API Key'),
      React.createElement('input', {
        type: 'password', value: apiKey, disabled: controlsDisabled,
        placeholder: configured ? '已保存；留空则保持不变' : '请输入 API Key',
        autoComplete: 'new-password', spellCheck: false,
        onChange: (event) => setApiKey(event.target.value),
      }),
      React.createElement('small', null, configured ? 'API Key 已安全保存，不会从 Host 读回浏览器。' : 'API Key 将由 DSH Credential 服务保存。')),
    notice ? React.createElement('p', { className: `relay-settings__notice ${notice.ok ? 'is-success' : 'is-error'}`, role: 'status' }, notice.text) : null,
    React.createElement('div', { className: 'relay-settings__actions' },
      React.createElement('button', { type: 'button', className: 'relay-settings__secondary', disabled: controlsDisabled, onClick: () => run(false) }, busy ? '请稍候…' : '测试连接'),
      React.createElement('button', { type: 'button', className: 'relay-settings__primary', disabled: controlsDisabled, onClick: () => run(true) }, busy ? '请稍候…' : '测试并保存')),
    !writable ? React.createElement('p', { className: 'relay-settings__readonly' }, '当前设置存储不可写。') : null)
}

function BalanceIndicator({ wide }) {
  const [state, setState] = React.useState({ data: null, loading: true, error: null })
  const mounted = React.useRef(false)
  const manager = React.useRef(null)
  const timingTooltip = React.useRef(null)

  if (manager.current === null) {
    manager.current = createBalanceRequestManager({
      fetchImpl: (...args) => fetch(...args),
      createController: () => new AbortController(),
      setTimeoutImpl: (...args) => window.setTimeout(...args),
      clearTimeoutImpl: (id) => window.clearTimeout(id),
      onLoading: () => {
        if (mounted.current) setState((previous) => ({ ...previous, loading: true }))
      },
      onSuccess: (data) => {
        if (mounted.current) setState({ data, loading: false, error: null })
      },
      onError: (message) => {
        if (mounted.current) setState((previous) => ({ ...previous, loading: false, error: message }))
      },
    })
  }

  const refresh = React.useCallback(() => manager.current.refresh(), [])
  React.useEffect(() => {
    mounted.current = true
    const dispose = installRefreshLifecycle(manager.current, window, document)
    return () => {
      mounted.current = false
      dispose()
    }
  }, [refresh])

  const data = state.data
  const percent = typeof data?.percent === 'number' && Number.isFinite(data.percent)
    ? Math.min(100, Math.max(0, data.percent))
    : null
  const tone = data === null ? 'unavailable' : toneOf(percent, data.mode)
  const stale = data !== null && state.error !== null
  const summary = data === null ? '' : amountText(data)
  const visualAmount = data === null ? '' : visualAmountText(data)
  const timingText = data === null ? null : balanceTimingText(data)
  const label = data === null
    ? (state.loading ? '中转额度查询中' : '中转额度不可用')
    : `${summary}${Number.isFinite(percent) ? `，剩余 ${percentText(percent)}` : ''}${stale ? '，数据可能已过期' : ''}`
  const hideTimingTooltip = React.useCallback(() => {
    timingTooltip.current?.remove()
    timingTooltip.current = null
  }, [])
  const showTimingTooltip = React.useCallback((event) => {
    hideTimingTooltip()
    if (timingText === null) return
    const tag = document.createElement('span')
    tag.className = 'relay-balance__timing'
    tag.setAttribute('role', 'tooltip')
    tag.textContent = timingText
    document.body.appendChild(tag)
    const cardRect = event.currentTarget.getBoundingClientRect()
    const tooltipRect = tag.getBoundingClientRect()
    const position = timingTooltipPosition(cardRect, tooltipRect, { width: window.innerWidth, height: window.innerHeight })
    tag.style.left = `${position.left}px`
    tag.style.top = `${position.top}px`
    tag.dataset.visible = 'true'
    timingTooltip.current = tag
  }, [hideTimingTooltip, timingText])
  React.useEffect(() => hideTimingTooltip, [hideTimingTooltip, timingText, wide])

  if (!wide) {
    const compact = data === null
      ? (state.loading ? '…' : '!')
      : (Number.isFinite(percent) ? String(Math.round(percent)) : compactMoney(data.remaining, data.unit))
    return React.createElement('button', {
      type: 'button',
      className: `relay-balance relay-balance--rail relay-balance--${tone}${state.loading ? ' is-loading' : ''}${Number.isFinite(percent) ? ' has-percent' : ''}`,
      'aria-label': label,
      onMouseEnter: showTimingTooltip,
      onMouseLeave: hideTimingTooltip,
      onFocus: showTimingTooltip,
      onBlur: hideTimingTooltip,
      onClick: refresh,
    },
    React.createElement('span', {
      className: 'relay-balance__ring',
      style: { '--relay-progress': `${Number.isFinite(percent) ? percent * 3.6 : 0}deg` },
      'aria-hidden': 'true',
    }, compact),
    stale ? React.createElement('span', { className: 'relay-balance__warning', 'aria-hidden': 'true' }, '!') : null)
  }

  return React.createElement('button', {
    type: 'button',
    className: `relay-balance relay-balance--wide relay-balance--${tone}${state.loading ? ' is-loading' : ''}`,
    'aria-label': label,
    onMouseEnter: showTimingTooltip,
    onMouseLeave: hideTimingTooltip,
    onFocus: showTimingTooltip,
    onBlur: hideTimingTooltip,
    onClick: refresh,
  },
  React.createElement('span', { className: 'relay-balance__summary' },
    React.createElement('span', { className: 'relay-balance__amount' }, data === null ? '—' : visualAmount),
    stale ? React.createElement('span', { className: 'relay-balance__stale', 'aria-hidden': 'true' }, '!') : null,
    Number.isFinite(percent)
      ? React.createElement('span', { className: 'relay-balance__percent' }, percentText(percent))
      : null),
  Number.isFinite(percent)
    ? React.createElement('span', { className: 'relay-balance__track', 'aria-hidden': 'true' },
      React.createElement('span', { className: 'relay-balance__fill', style: { width: `${percent}%` } }))
    : null)
}

const css = `
.relay-balance{--relay-tone:var(--dsw-alias-state-business-primary,#3b82f6);box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border:1px solid transparent;background:transparent;position:relative;transition:background .16s ease,border-color .16s ease,opacity .16s ease}
.relay-balance:hover{background:var(--dsw-alias-interactive-bg-hover)}
.relay-balance:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.relay-balance--healthy{--relay-tone:#22a06b}.relay-balance--warning{--relay-tone:#d49b16}.relay-balance--danger{--relay-tone:#df4b4b}.relay-balance--neutral{--relay-tone:var(--dsw-alias-state-business-primary,#3b82f6)}.relay-balance--unavailable{--relay-tone:var(--dsw-alias-label-caption,#8a8a8a)}
.relay-balance.is-loading{opacity:.78}
.relay-balance--wide{width:100%;min-width:100%;flex:0 0 100%;border-color:var(--dsw-alias-border-l1);border-radius:9px;padding:9px 10px 10px;text-align:left;display:flex;flex-direction:column;gap:7px;align-self:center}
:where(*):has(> [data-slot="sidebar.footer.action"] > .relay-balance--wide){flex-wrap:wrap;row-gap:4px}
:where(*):has(> [data-slot="sidebar.footer.action"] > .relay-balance--rail){flex-direction:column;align-items:center;row-gap:4px}
.relay-balance__summary{width:100%;display:flex;align-items:baseline;gap:8px;line-height:18px}.relay-balance__amount{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}.relay-balance__percent{margin-left:auto;flex:none;color:var(--relay-tone);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}.relay-balance__stale,.relay-balance__warning{color:#d49b16;font-weight:800}
.relay-balance__track{width:100%;height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-base)}.relay-balance__fill{height:100%;display:block;border-radius:inherit;background:var(--relay-tone);transition:width .3s ease}.relay-balance__timing{position:fixed;z-index:1000;box-sizing:border-box;width:max-content;max-width:calc(100vw - 16px);padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:500 13px/19px var(--dsw-font-family,system-ui,sans-serif);white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.2);pointer-events:none;opacity:0;transform:translateX(-2px);transition:opacity .1s ease,transform .1s ease}.relay-balance__timing[data-visible="true"]{opacity:1;transform:translateX(0)}
.relay-balance--rail{width:36px;height:36px;padding:4px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}
.relay-balance__ring{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);font-size:8px;font-weight:700;font-variant-numeric:tabular-nums;background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) 0deg,var(--dsw-alias-border-l1) 0)}
.relay-balance.has-percent .relay-balance__ring{background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) var(--relay-progress),var(--dsw-alias-border-l1) 0)}
.relay-balance__warning{position:absolute;right:1px;top:0;width:12px;height:12px;border-radius:50%;background:var(--dsw-specific-sidebar-fill);font-size:9px;line-height:12px;text-align:center}
.relay-settings{box-sizing:border-box;max-width:680px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px}.relay-settings__header{display:flex;flex-direction:column;gap:4px}.relay-settings__header h2{margin:0;font-size:18px;line-height:26px}.relay-settings__header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.relay-settings__field{display:flex;flex-direction:column;gap:7px;font-size:13px;font-weight:600}.relay-settings__field input{box-sizing:border-box;width:100%;height:38px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400;padding:0 11px;outline:none}.relay-settings__field input:focus{border-color:var(--dsw-alias-state-business-primary,#3b82f6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 20%,transparent)}.relay-settings__field small{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.relay-settings__actions{display:flex;justify-content:flex-end;gap:8px}.relay-settings__actions button{height:36px;border:0;border-radius:18px;cursor:pointer;font:inherit;padding:0 16px}.relay-settings__actions button:disabled{cursor:not-allowed;opacity:.55}.relay-settings__primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.relay-settings__secondary{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.relay-settings__notice,.relay-settings__readonly{margin:0;font-size:12px;line-height:18px}.relay-settings__notice.is-success{color:var(--dsw-alias-state-success-primary,#22a06b)}.relay-settings__notice.is-error,.relay-settings__readonly{color:var(--dsw-alias-state-error-primary,#df4b4b)}
.relay-history{--relay-history-accent:#3b82f6;box-sizing:border-box;min-height:178px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));display:flex;flex-direction:column;gap:14px}.relay-history__header{display:flex;align-items:center;gap:12px;min-width:0}.relay-history__header h3{margin:0;flex:none;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:650}.relay-history__summary{margin-left:auto;min-width:0;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.relay-history__summary>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.relay-history__refresh{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));font:600 17px/1 system-ui,sans-serif;cursor:pointer;transition:background .16s ease,color .16s ease,transform .2s ease}.relay-history__refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.relay-history__refresh:focus-visible,.relay-history__day:focus-visible{outline:2px solid var(--relay-history-accent);outline-offset:2px}.relay-history__refresh:disabled{cursor:wait;opacity:.55}.relay-history.is-loading .relay-history__refresh{transform:rotate(90deg)}
.relay-history__content{display:grid;grid-template-columns:minmax(144px,auto) minmax(0,1fr);align-items:center;gap:28px;min-height:168px}.relay-history__calendar{min-width:144px;display:flex;align-items:center;justify-content:flex-start}.relay-history__grid{display:grid;grid-template-rows:repeat(7,24px);grid-auto-flow:column;grid-auto-columns:24px;width:max-content;max-width:100%}.relay-history__day,.relay-history__blank{box-sizing:border-box;width:24px;height:24px}.relay-history__blank{display:block}.relay-history__day{appearance:none;padding:0;border:0;background:transparent;cursor:default;display:grid;place-items:center}.relay-history__day::before{content:"";box-sizing:border-box;width:16px;height:16px;border:1px solid transparent;border-radius:3px;background:var(--dsw-alias-border-l1);transition:transform .12s ease,box-shadow .12s ease,background .16s ease}.relay-history__day:hover::before,.relay-history__day:focus-visible::before{transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,.18)}.relay-history__day--1::before{background:color-mix(in srgb,var(--relay-history-accent) 34%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}.relay-history__day--2::before{background:color-mix(in srgb,var(--relay-history-accent) 52%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}.relay-history__day--3::before{background:color-mix(in srgb,var(--relay-history-accent) 72%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}.relay-history__day--4::before{background:color-mix(in srgb,var(--relay-history-accent) 92%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}.relay-history__day.is-today::before{border-color:var(--relay-history-accent);box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)),0 0 0 2px var(--relay-history-accent)}.relay-history__day--loading::before{border:0;animation:relay-history-pulse 1.2s ease-in-out infinite alternate}.relay-history__error,.relay-history__empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.relay-history__error{color:var(--dsw-alias-state-error-primary,#df4b4b)}.relay-history__tooltip{position:fixed;z-index:1001;box-sizing:border-box;width:max-content;max-width:calc(100vw - 16px);padding:8px 10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#202124;color:#fff;font:500 12px/18px var(--dsw-font-family,system-ui,sans-serif);overflow-wrap:anywhere;box-shadow:0 6px 18px rgba(0,0,0,.32);pointer-events:none;opacity:0;transform:translateY(2px);transition:opacity .1s ease,transform .1s ease}.relay-history__tooltip strong,.relay-history__tooltip span{display:block}.relay-history__tooltip strong{font-size:12px;font-weight:650}.relay-history__tooltip span{color:rgba(255,255,255,.78);font-variant-numeric:tabular-nums}.relay-history__tooltip[data-visible="true"]{opacity:1;transform:translateY(0)}
.relay-model{box-sizing:border-box;min-width:0;min-height:168px;padding-left:24px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;justify-content:center}.relay-model__body{min-width:0;display:grid;grid-template-columns:108px minmax(0,1fr);align-items:center;gap:14px}.relay-model__chart{width:108px;aspect-ratio:1;position:relative}.relay-model__chart svg{display:block;width:100%;height:100%;overflow:visible}.relay-model__track,.relay-model__segment{fill:none;stroke-width:6}.relay-model__track{stroke:var(--dsw-alias-border-l1)}.relay-model__segment{cursor:pointer;transition:opacity .16s ease,stroke-width .16s ease}.relay-model__segment:hover,.relay-model__segment:active{stroke-width:7.5}.relay-model__segment--1{stroke:#3b82f6}.relay-model__segment--2{stroke:#06b6d4}.relay-model__segment--3{stroke:#8b5cf6}.relay-model__segment--4{stroke:#f59e0b}.relay-model__segment--5{stroke:#22c55e}.relay-model__segment--6{stroke:#64748b}.relay-model__center{position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;flex-direction:column;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}.relay-model__center strong{font-size:16px;line-height:20px;font-weight:700}.relay-model__center small{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}.relay-model__legend{min-width:0;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}.relay-model__legend li{min-width:0}.relay-model__legend-button{appearance:none;box-sizing:border-box;width:100%;min-height:24px;margin:0;padding:2px 3px;border:0;border-radius:5px;background:transparent;display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font:inherit;font-size:11px;line-height:16px;text-align:left;cursor:pointer}.relay-model__legend-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.relay-model__legend-button:focus-visible{outline:2px solid var(--relay-history-accent);outline-offset:1px}.relay-model__swatch{width:7px;height:7px;border-radius:50%}.relay-model__swatch--1{background:#3b82f6}.relay-model__swatch--2{background:#06b6d4}.relay-model__swatch--3{background:#8b5cf6}.relay-model__swatch--4{background:#f59e0b}.relay-model__swatch--5{background:#22c55e}.relay-model__swatch--6{background:#64748b}.relay-model__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.relay-model__value{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}.relay-model__empty{min-height:108px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;text-align:center}.relay-model.is-loading .relay-model__empty{animation:relay-model-fade 1.2s ease-in-out infinite alternate}
@keyframes relay-history-pulse{from{background:color-mix(in srgb,var(--relay-history-accent) 12%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}to{background:color-mix(in srgb,var(--relay-history-accent) 32%,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)))}}@keyframes relay-model-fade{from{opacity:.45}to{opacity:1}}
@media (max-width:620px){.relay-history__content{grid-template-columns:1fr;align-items:start;gap:14px}.relay-model{min-height:0;padding-left:0;padding-top:14px;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}.relay-model__body{grid-template-columns:104px minmax(0,1fr)}.relay-model__chart{width:104px}}
@media (max-width:560px){.relay-history__header{align-items:flex-start;flex-direction:column;gap:4px}.relay-history__summary{width:100%;margin-left:0}.relay-history__summary>span{white-space:normal}.relay-history__refresh{margin-left:auto;margin-top:-24px}}
@media (max-width:380px){.relay-model__body{grid-template-columns:1fr}.relay-model__chart{justify-self:center}.relay-model__legend{width:100%}}
@media (forced-colors:active){.relay-history__day{forced-color-adjust:none}.relay-history__day::before{border-color:GrayText}.relay-history__day--1::before{background:Highlight;opacity:.35}.relay-history__day--2::before{background:Highlight;opacity:.55}.relay-history__day--3::before{background:Highlight;opacity:.75}.relay-history__day--4::before{background:Highlight;opacity:1}.relay-history__day.is-today{outline:2px solid CanvasText;outline-offset:1px}.relay-model__segment,.relay-model__swatch{forced-color-adjust:none}.relay-model__track{stroke:GrayText}.relay-model__legend-button:focus-visible{outline-color:Highlight}}
@media (prefers-reduced-motion:reduce){.relay-balance,.relay-balance__fill,.relay-history__refresh,.relay-history__day::before,.relay-history__tooltip,.relay-model__segment{transition:none}.relay-history__day--loading::before,.relay-model.is-loading .relay-model__empty{animation:none}}
`

const inject = ['slots', 'connection', 'settingsScope']
function apply(ctx) {
  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
    throw new Error('dsh-relay-balance requires slots.inject() and slots.register()')
  }
  if (typeof ctx.settingsScope?.bind !== 'function') throw new Error('dsh-relay-balance requires settingsScope.bind()')
  if (typeof ctx.connection?.api?.credentials?.describe !== 'function') {
    throw new Error('dsh-relay-balance requires the DSH connection credentials API')
  }
  const relaySettings = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE, decode: decodeRelaySettings })
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-relay-balance'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'relay-balance: styles')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'relay-balance',
    order: -100,
    label: '中转额度',
  }, BalanceIndicator))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'relay-balance',
    order: 30,
    label: '中转余额',
  }, () => React.createElement(RelaySettingsSection, { relaySettings, api: ctx.connection.api })))
}

exports.apply = apply
exports.inject = inject
exports.BalanceIndicator = BalanceIndicator
exports.DailyUsageHeatmap = DailyUsageHeatmap
exports.ModelUsageDonut = ModelUsageDonut
exports.RelaySettingsSection = RelaySettingsSection
exports.createBalanceRequestManager = createBalanceRequestManager
exports.createHistoryRequestManager = createHistoryRequestManager
exports.installRefreshLifecycle = installRefreshLifecycle
exports.installHistoryRefreshLifecycle = installHistoryRefreshLifecycle
exports.callRelayConnection = callRelayConnection
exports.decodeRelaySettings = decodeRelaySettings
exports.decodeHistoryData = decodeHistoryData
exports.heatScale = heatScale
exports.heatLevel = heatLevel
exports.heatmapTooltipPosition = heatmapTooltipPosition
exports.historyMoney = historyMoney
exports.compactMetric = compactMetric
exports.toneOf = toneOf
exports.money = money
exports.amountText = amountText
exports.scopeLabel = scopeLabel
exports.balanceTimingText = balanceTimingText
exports.timingTooltipPosition = timingTooltipPosition
