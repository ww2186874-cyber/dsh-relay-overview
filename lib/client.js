window.__ModuleLoader__.load({
  id: "dsh-relay-balance",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const ROUTE_PATH = '/relay-balance/status'
    const TEST_ROUTE_PATH = '/relay-balance/test'
    const SAVE_ROUTE_PATH = '/relay-balance/save'
    const SETTINGS_NAMESPACE = 'dsh-relay-balance'
    const REFRESH_EVENT = 'relay-balance:refresh'
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
      windowObject.addEventListener(REFRESH_EVENT, manager.refresh)
      return () => {
        windowObject.clearInterval(interval)
        documentObject.removeEventListener('visibilitychange', onVisibility)
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
          React.createElement('h2', null, 'Relay Balance'),
          React.createElement('p', null, '填写中转 URL 和 API Key，即可查询并显示剩余额度。')),
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

      if (!wide) {
        const compact = data === null
          ? (state.loading ? '…' : '!')
          : (Number.isFinite(percent) ? String(Math.round(percent)) : compactMoney(data.remaining, data.unit))
        return React.createElement('button', {
          type: 'button',
          className: `relay-balance relay-balance--rail relay-balance--${tone}${state.loading ? ' is-loading' : ''}${Number.isFinite(percent) ? ' has-percent' : ''}`,
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
        : null,
      timingText === null ? null : React.createElement('span', { className: 'relay-balance__timing', role: 'tooltip' }, timingText))
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
    .relay-balance__track{width:100%;height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-base)}.relay-balance__fill{height:100%;display:block;border-radius:inherit;background:var(--relay-tone);transition:width .3s ease}.relay-balance__timing{position:absolute;z-index:10;right:6px;bottom:calc(100% + 4px);box-sizing:border-box;width:max-content;max-width:calc(100vw - 32px);padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-size:11px;font-weight:400;line-height:16px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.18);pointer-events:none;opacity:0;visibility:hidden;transform:translateY(2px);transition:opacity .1s ease,transform .1s ease,visibility 0s linear .1s}.relay-balance--wide:hover .relay-balance__timing,.relay-balance--wide:focus-visible .relay-balance__timing{opacity:1;visibility:visible;transform:translateY(0);transition-delay:0s}
    .relay-balance--rail{width:36px;height:36px;padding:4px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center}
    .relay-balance__ring{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);font-size:8px;font-weight:700;font-variant-numeric:tabular-nums;background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) 0deg,var(--dsw-alias-border-l1) 0)}
    .relay-balance.has-percent .relay-balance__ring{background:radial-gradient(circle at center,var(--dsw-specific-sidebar-fill) 58%,transparent 60%),conic-gradient(var(--relay-tone) var(--relay-progress),var(--dsw-alias-border-l1) 0)}
    .relay-balance__warning{position:absolute;right:1px;top:0;width:12px;height:12px;border-radius:50%;background:var(--dsw-specific-sidebar-fill);font-size:9px;line-height:12px;text-align:center}
    .relay-settings{box-sizing:border-box;max-width:680px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px}.relay-settings__header{display:flex;flex-direction:column;gap:4px}.relay-settings__header h2{margin:0;font-size:18px;line-height:26px}.relay-settings__header p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.relay-settings__field{display:flex;flex-direction:column;gap:7px;font-size:13px;font-weight:600}.relay-settings__field input{box-sizing:border-box;width:100%;height:38px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400;padding:0 11px;outline:none}.relay-settings__field input:focus{border-color:var(--dsw-alias-state-business-primary,#3b82f6);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 20%,transparent)}.relay-settings__field small{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}.relay-settings__actions{display:flex;justify-content:flex-end;gap:8px}.relay-settings__actions button{height:36px;border:0;border-radius:18px;cursor:pointer;font:inherit;padding:0 16px}.relay-settings__actions button:disabled{cursor:not-allowed;opacity:.55}.relay-settings__primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.relay-settings__secondary{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.relay-settings__notice,.relay-settings__readonly{margin:0;font-size:12px;line-height:18px}.relay-settings__notice.is-success{color:var(--dsw-alias-state-success-primary,#22a06b)}.relay-settings__notice.is-error,.relay-settings__readonly{color:var(--dsw-alias-state-error-primary,#df4b4b)}
    @media (prefers-reduced-motion:reduce){.relay-balance,.relay-balance__fill{transition:none}}
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
        label: 'Relay Balance',
      }, () => React.createElement(RelaySettingsSection, { relaySettings, api: ctx.connection.api })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.BalanceIndicator = BalanceIndicator
    exports.RelaySettingsSection = RelaySettingsSection
    exports.createBalanceRequestManager = createBalanceRequestManager
    exports.installRefreshLifecycle = installRefreshLifecycle
    exports.callRelayConnection = callRelayConnection
    exports.decodeRelaySettings = decodeRelaySettings
    exports.toneOf = toneOf
    exports.money = money
    exports.amountText = amountText
    exports.scopeLabel = scopeLabel
    exports.balanceTimingText = balanceTimingText

    return module.exports
  },
})
