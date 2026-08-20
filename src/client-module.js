const React = require('react')

const ROUTE_PATH = '/nbapi-balance/status'
const REFRESH_MS = 60_000

function toneOf(percent) {
  if (percent < 10) return 'danger'
  if (percent <= 30) return 'warning'
  return 'healthy'
}

function money(value, unit) {
  if (!Number.isFinite(value)) return '—'
  return unit === 'USD' ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${unit}`
}

function percentText(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
}

function createBalanceRequestManager({ fetchImpl, createController, onLoading, onSuccess, onError }) {
  let current = null

  function refresh() {
    if (current !== null) return current.promise

    const controller = createController()
    const record = { controller, promise: null }
    onLoading()
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
        if (!response.ok || body?.ok !== true || typeof body.data !== 'object' || body.data === null) {
          throw new Error(body?.error?.message || `余额查询失败（HTTP ${response.status}）`)
        }
        return body.data
      })
      .then((data) => {
        if (!controller.signal.aborted) onSuccess(data)
        return data
      })
      .catch((error) => {
        if (!controller.signal.aborted) onError(error?.message || '余额查询失败')
        return null
      })
      .finally(() => {
        if (current === record) current = null
      })
    current = record
    return record.promise
  }

  function abort() {
    const record = current
    if (record === null) return
    current = null
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
  return () => {
    windowObject.clearInterval(interval)
    documentObject.removeEventListener('visibilitychange', onVisibility)
    manager.abort()
  }
}

function BalanceIndicator({ wide }) {
  const [state, setState] = React.useState({ data: null, loading: true, error: null })
  const mounted = React.useRef(false)
  const manager = React.useRef(null)

  if (manager.current === null) {
    manager.current = createBalanceRequestManager({
      fetchImpl: (...args) => fetch(...args),
      createController: () => new AbortController(),
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
    : 0
  const tone = data === null ? 'unavailable' : toneOf(percent)
  const stale = data !== null && state.error !== null
  const title = data === null
    ? (state.loading ? '正在查询 NBAPI 余额' : `NBAPI 余额不可用：${state.error || '未知错误'}。点击重试`)
    : `${data.planName ? `${data.planName} · ` : ''}剩余 ${money(data.remaining, data.unit)} / 总额 ${money(data.total, data.unit)}（${percentText(percent)}）${stale ? ` · 数据可能已过期：${state.error}` : ''}。点击刷新`
  const label = data === null
    ? (state.loading ? 'NBAPI 查询中' : 'NBAPI 余额不可用')
    : `NBAPI 剩余 ${money(data.remaining, data.unit)}，总额 ${money(data.total, data.unit)}，${percentText(percent)}${stale ? '，数据可能已过期' : ''}`

  if (!wide) {
    return React.createElement('button', {
      type: 'button',
      className: `nbapi-balance nbapi-balance--rail nbapi-balance--${tone}${state.loading ? ' is-loading' : ''}`,
      title,
      'aria-label': label,
      onClick: refresh,
    },
    React.createElement('span', {
      className: 'nbapi-balance__ring',
      style: { '--nbapi-progress': `${percent * 3.6}deg` },
      'aria-hidden': 'true',
    }, data === null ? (state.loading ? '…' : '!') : String(Math.round(percent))),
    stale ? React.createElement('span', { className: 'nbapi-balance__warning', 'aria-hidden': 'true' }, '!') : null)
  }

  return React.createElement('button', {
    type: 'button',
    className: `nbapi-balance nbapi-balance--wide nbapi-balance--${tone}${state.loading ? ' is-loading' : ''}`,
    title,
    'aria-label': label,
    onClick: refresh,
  },
  React.createElement('span', { className: 'nbapi-balance__header' },
    React.createElement('span', { className: 'nbapi-balance__name' }, 'NBAPI'),
    React.createElement('span', { className: 'nbapi-balance__percent' }, data === null ? (state.loading ? '查询中…' : '不可用') : percentText(percent)),
    stale ? React.createElement('span', { className: 'nbapi-balance__stale', 'aria-hidden': 'true' }, '!') : null),
  React.createElement('span', { className: 'nbapi-balance__amount' }, data === null
    ? (state.error || '正在读取余额')
    : `剩余 ${money(data.remaining, data.unit)} / 总额 ${money(data.total, data.unit)}`),
  React.createElement('span', { className: 'nbapi-balance__track', 'aria-hidden': 'true' },
    React.createElement('span', { className: 'nbapi-balance__fill', style: { width: `${percent}%` } })))
}

const css = `
.nbapi-balance{--nbapi-tone:var(--dsw-alias-state-business-primary,#3b82f6);box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border:1px solid transparent;background:transparent;position:relative;transition:background .16s ease,border-color .16s ease,opacity .16s ease}
.nbapi-balance:hover{background:var(--dsw-alias-interactive-bg-hover)}
.nbapi-balance:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.nbapi-balance--healthy{--nbapi-tone:#22a06b}.nbapi-balance--warning{--nbapi-tone:#d49b16}.nbapi-balance--danger{--nbapi-tone:#df4b4b}.nbapi-balance--unavailable{--nbapi-tone:var(--dsw-alias-label-caption,#8a8a8a)}
.nbapi-balance.is-loading{opacity:.78}
.nbapi-balance--wide{width:100%;min-width:100%;flex:0 0 100%;border-color:var(--dsw-alias-border-l1);border-radius:9px;padding:7px 9px 8px;text-align:left;display:flex;flex-direction:column;gap:4px;align-self:center}
:where(*):has(> [data-slot="sidebar.footer.action"] > .nbapi-balance--wide){flex-wrap:wrap;row-gap:4px}
:where(*):has(> [data-slot="sidebar.footer.action"] > .nbapi-balance--rail){flex-direction:column;align-items:center;row-gap:4px}
.nbapi-balance__header{width:100%;display:flex;align-items:center;gap:6px;line-height:16px}.nbapi-balance__name{font-size:12px;font-weight:650;letter-spacing:.02em}.nbapi-balance__percent{margin-left:auto;color:var(--nbapi-tone);font-size:11px;font-variant-numeric:tabular-nums}.nbapi-balance__stale,.nbapi-balance__warning{color:#d49b16;font-weight:800}
.nbapi-balance__amount{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}
.nbapi-balance__track{width:100%;height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-base)}.nbapi-balance__fill{height:100%;display:block;border-radius:inherit;background:var(--nbapi-tone);transition:width .3s ease}
.nbapi-balance--rail{width:36px;height:36px;padding:4px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}
.nbapi-balance__ring{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);font-size:9px;font-weight:700;font-variant-numeric:tabular-nums;background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--nbapi-tone) var(--nbapi-progress),var(--dsw-alias-border-l1) 0)}
.nbapi-balance__warning{position:absolute;right:1px;top:0;width:12px;height:12px;border-radius:50%;background:var(--dsw-specific-sidebar-fill);font-size:9px;line-height:12px;text-align:center}
@media (prefers-reduced-motion:reduce){.nbapi-balance,.nbapi-balance__fill{transition:none}}
`

const inject = ['slots']
function apply(ctx) {
  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
    throw new Error('dsh-nbapi-balance requires slots.inject() and slots.register()')
  }
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-nbapi-balance'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'nbapi-balance: styles')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'nbapi-balance',
    order: -100,
    label: 'NBAPI 余额',
  }, BalanceIndicator))
}

exports.apply = apply
exports.inject = inject
exports.BalanceIndicator = BalanceIndicator
exports.createBalanceRequestManager = createBalanceRequestManager
exports.installRefreshLifecycle = installRefreshLifecycle
exports.toneOf = toneOf
exports.money = money
