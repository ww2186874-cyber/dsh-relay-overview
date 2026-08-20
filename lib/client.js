window.__ModuleLoader__.load({
  id: "dsh-relay-balance",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const ROUTE_PATH = '/relay-balance/status'
    const REFRESH_MS = 60_000
    const CLIENT_TIMEOUT_MS = 20_000

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

    function percentText(value) {
      return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
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
      const title = data === null
        ? (state.loading ? '…' : (state.error || '—'))
        : `${visualAmount}${Number.isFinite(percent) ? ` · ${percentText(percent)}` : ''}${stale ? ` · ${state.error}` : ''}`
      const label = data === null
        ? (state.loading ? '中转额度查询中' : '中转额度不可用')
        : `${summary}${Number.isFinite(percent) ? `，剩余 ${percentText(percent)}` : ''}${stale ? '，数据可能已过期' : ''}`

      if (!wide) {
        const compact = data === null
          ? (state.loading ? '…' : '!')
          : (Number.isFinite(percent) ? String(Math.round(percent)) : compactMoney(data.remaining, data.unit))
        return React.createElement('button', {
          type: 'button',
          className: `relay-balance relay-balance--rail relay-balance--${tone}${state.loading ? ' is-loading' : ''}${Number.isFinite(percent) ? ' has-percent' : ''}`,
          title,
          'aria-label': label,
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
        title,
        'aria-label': label,
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
    .relay-balance__track{width:100%;height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-base)}.relay-balance__fill{height:100%;display:block;border-radius:inherit;background:var(--relay-tone);transition:width .3s ease}
    .relay-balance--rail{width:36px;height:36px;padding:4px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}
    .relay-balance__ring{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);font-size:8px;font-weight:700;font-variant-numeric:tabular-nums;background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) 0deg,var(--dsw-alias-border-l1) 0)}
    .relay-balance.has-percent .relay-balance__ring{background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) var(--relay-progress),var(--dsw-alias-border-l1) 0)}
    .relay-balance__warning{position:absolute;right:1px;top:0;width:12px;height:12px;border-radius:50%;background:var(--dsw-specific-sidebar-fill);font-size:9px;line-height:12px;text-align:center}
    @media (prefers-reduced-motion:reduce){.relay-balance,.relay-balance__fill{transition:none}}
    `

    const inject = ['slots']
    function apply(ctx) {
      if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
        throw new Error('dsh-relay-balance requires slots.inject() and slots.register()')
      }
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
    }

    exports.apply = apply
    exports.inject = inject
    exports.BalanceIndicator = BalanceIndicator
    exports.createBalanceRequestManager = createBalanceRequestManager
    exports.installRefreshLifecycle = installRefreshLifecycle
    exports.toneOf = toneOf
    exports.money = money
    exports.amountText = amountText
    exports.scopeLabel = scopeLabel

    return module.exports
  },
})
