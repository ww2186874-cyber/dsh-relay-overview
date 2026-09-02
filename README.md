# dsh-relay-overview

[中文](#中文) | [English](#english)

## 中文

`dsh-relay-overview` 是安装到 DSH Web Profile 的中转额度与近 30 天使用概览插件。插件采用通用的 **Relay Overview** 身份；当前 `sub2api` 适配器读取 Sub2API 及兼容实现的额度响应。

此源码树只面向并已审计 DSH `0.1.2-alpha.5`，使用该版本的 `ctx.remote.credentials` Client API，不兼容其他 DSH 版本。

> “Sub2API-compatible”只表示额度接口协议兼容，不代表中转站运行原版 Sub2API，也不说明其源码来源。

### 功能

- 在 **Settings → 中转概览** 中配置中转 URL 和 API Key，支持测试连接和测试后保存。
- 设置页显示今天及此前 29 个北京时间自然日的每日实际扣费热力图，以及 30 天累计扣费、请求数和 Token。
- 同一卡片显示按请求次数统计的模型环形图：前 5 个模型单列，其余合并为“其他模型”；窄屏时移到热力图下方。
- 热力图和模型图只使用已保存配置，共用一次本机 `/relay-overview/history` 请求；插件不建立本地历史数据库。
- API Key 由 DSH Credential 服务保存。浏览器只查询 Credential 是否已配置，不能通过本插件读回已保存的值。
- 展开侧栏显示 `$剩余/$限额`、百分比和进度条，不显示 Provider、站点名或冗余标签。
- 折叠侧栏中，真实配额显示百分比环，钱包余额显示金额，不限额显示 `∞`。
- 订阅数据同时包含到期时间和有效额度窗口起点时，悬停或聚焦侧栏卡片会显示 `剩余N天（YYYY/MM/DD HH:mm） DdHh后重置`。
- 余额在组件加载、每 60 秒、页面恢复可见、保存配置和用户点击时刷新；临时失败会保留最后一次成功数据并标记为过期。
- Client 本机请求超时为 20 秒；Host 上游请求超时为 12 秒，并对并发的同类查询做去重。

### 额度语义

插件不会把 `remaining + usage.total.actual_cost` 统一解释为所有模式的“总额度”：

- **Key 配额**：优先使用 `quota.limit / quota.used / quota.remaining`；若同时存在滚动限制，选择剩余金额最小的有效约束。
- **订阅**：在已配置的日、周、月额度窗口中选择剩余金额最小的约束。
- **钱包**：`remaining` 或 `balance` 是当前钱包余额；`usage.total.actual_cost` 只是当前 Key 的累计消费，不是钱包原始总额。
- **不限额**：明确显示不限额，不伪造总额或百分比。
- **异常数据**：未知、自相矛盾或越界的数据会安全失败，而不是猜测额度。

### 要求

以 [`package.json`](package.json) 的 `engines` 为准。当前声明为：

- DSH `0.1.2-alpha.5`（仅此版本）
- Node.js `>=22.19.0`
- 中转站提供 Sub2API-compatible 额度接口；只有 OpenAI-compatible 模型接口、没有额度接口的站点无法查询余额或历史聚合

### 安装

此 Alpha 5 适配版源码位于 `C:\DSH-Versions\0.1.2-alpha.5\plugins\dsh-relay-overview`。完成 `pnpm verify`、`pnpm run verify:runtime` 和打包检查后，将生成的固定版本 tarball 保存到本版本 `plugin-packages`，再使用 DSH Alpha 5 自带 CLI 安装到该版本独立 Home：

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh plugin --profile web add 'C:\DSH-Versions\0.1.2-alpha.5\plugin-packages\dsh-relay-overview-0.10.0.tgz'
```

普通安装无需手工编辑 Profile YAML；CLI 会添加本地包依赖、Profile bundle，并应用包内 Composition patch。

安装完成后，需要由用户重启现有 DSH Web 进程并刷新其页面，使新的 Host 和 Client 插件载入。不要另起 Vite Server 代替现有 GUI。插件载入后，普通配置保存会实时生效，不需要每次保存都重启。

### 使用

1. 打开 DSH Web 的 **Settings**。
2. 进入 **中转概览**。
3. 填写 HTTPS 中转 URL，例如 `https://relay.example/v1`。
4. 填写 API Key。
5. 点击 **测试连接**；确认额度解析正确后，点击 **测试并保存**。

保存成功后，API Key 草稿会从输入框状态清空，不会从 Host 回填。仅在 HTTPS origin 相同、只修改路径时，才可以留空 API Key 并复用现有密钥；改变 origin 时必须填写新 Key。

### 高级 Composition 配置

正常使用无需手工编辑 YAML。包内 [`cordis.patch.yml`](cordis.patch.yml) 已提供默认 row；设置页将用户配置写入 DSH Settings。

如需在 Profile patch 中覆盖 row，请重述完整 `config`，因为 row 覆盖会替换整个配置对象：

```yaml
- id: relay-overview
  config:
    displayName: Relay
    baseURL: ''
    credentialRef: ''
    usagePath: auto
    allowRemote: false
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `displayName` | `Relay` | 用于可访问性和归一化数据；当前侧栏不显示名称 |
| `baseURL` | 空 | 可选的 Composition 层中转 URL；通常由设置页写入 Settings 层 |
| `credentialRef` | 空 | 与 `baseURL` 配对的 Credential reference，不是 API Key 明文 |
| `usagePath` | `auto` | 自动尝试基于 `baseURL` 推导的 `/usage` 与 `/v1/usage` 候选路径 |
| `allowRemote` | `false` | 仅放宽余额状态接口的直接回环限制；不会放宽历史、测试或保存接口，也不会增加身份认证 |

验证最终 Composition：

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh --profile web --dump-config
```

### 安全边界

- 浏览器只请求本机相对路由 `/relay-overview/status`、`/relay-overview/history`、`/relay-overview/test` 和 `/relay-overview/save`，不会直接请求用户填写的上游 URL。
- 新输入的 API Key 只会出现在密码输入状态和本机 test/save JSON 请求中。测试成功但尚未保存时，草稿会保留在输入框中；保存成功后会清空。
- Host 在真实上游查询时通过 DSH Credential 服务解析密钥，并把它作为 Bearer Token 发送给用户配置的中转站。实际 Credential 存储方式由当前 DSH Credential provider 决定。
- 上游 URL 必须使用 HTTPS，并拒绝 userinfo、query 和 fragment；重定向被拒绝。改变 URL origin 等同于改变 API Key 接收方，因此保存前必须测试且必须提供新 Key。
- **SSRF / 内网边界**：插件允许用户配置任意符合上述格式的 HTTPS 主机，目前不阻止回环、私网、链路本地或 DNS 解析到内部地址的目标，也不提供 DNS rebinding 隔离。能够调用本机设置接口的主体应被视为高信任主体；只配置你信任的中转地址。
- 上游响应同时受 `Content-Length` 和实际读取字节数的 1 MiB 限制，并经过 JSON 解析与字段白名单化；未知异常和上游正文不会原样返回浏览器。
- `/relay-overview/status` 默认只接受直接回环请求；`/relay-overview/history`、`/relay-overview/test` 和 `/relay-overview/save` 始终只接受直接回环请求。测试和保存还要求 JSON POST，并拒绝检测到的跨站请求及常见代理转发头。
- 上述回环防护沿用 DSH 本机 Web API 的信任边界，不是独立用户认证，不能抵御已经可以直接调用本机 DSH API 的恶意进程。多人系统账户或本机反向代理部署需要额外的操作系统/代理层访问控制。
- `allowRemote: true` 只公开归一化后的余额状态接口；该接口没有由插件提供的额外认证。历史、测试和保存接口不受此开关影响。
- 托管 Credential 使用由精确 origin 派生的 A/B 双槽。保存流程串行执行连接测试、密钥暂存、带 revision 的 Settings 切换和旧托管槽清理；不会广泛枚举或删除其他 Credential。

### 支持的 Sub2API 数据

额度适配器会读取并验证以下数据（字段是否必需取决于额度模式）：

- `isValid`（必须为 `true`）
- 可选元数据 `mode`、`planName`、`unit`
- `quota.limit`、`quota.remaining`，以及可选的 `quota.used`
- `rate_limits[].limit`，以及可选的 `used`、`remaining`、`window`、`reset_at`；已知窗口 `5h`、`1d`、`7d` 会保留对应语义，其他窗口归一化为通用窗口
- `subscription.daily_usage_usd` / `daily_limit_usd`
- `subscription.weekly_usage_usd` / `weekly_limit_usd` / `weekly_window_start`
- `subscription.monthly_usage_usd` / `monthly_limit_usd` / `monthly_window_start`
- `subscription.expires_at`
- `balance` / `remaining`
- `usage.total.actual_cost`
- `daily_usage[].date/actual_cost/requests/total_tokens`
- 可选的 `model_stats[].model/requests`

历史接口固定请求 `days=30&timezone=Asia/Shanghai`，并把同一组 30 个日期标签作为 `start_date` 和 `end_date` 传给上游。Host 会裁掉更早的每日数据，并把缺失日期补为 0。

Sub2API 当前只对 `daily_usage` 应用 `timezone`；`model_stats` 的日期边界由中转站服务器时区解释。因此，非 `Asia/Shanghai` 部署的模型统计绝对时间边界可能与热力图略有不同。

返回浏览器的历史数据只包含：

- 30 个连续日期的 `date`、`actualCost`、`requests`、`totalTokens`
- 30 天汇总
- 最多前 5 个模型的 `model` 和 `requests`，以及合并后的其他模型请求数

`model_stats` 缺失、超过 500 行或格式无效时，模型图会降级为不可用，但不会破坏有效的每日热力图。插件不会返回原始响应、逐请求记录、模型 Token/成本或 `account_cost`。

不同 Fork 可能改变接口。报告兼容问题时，请只提供脱敏后的字段结构和版本信息，不要提交真实 API Key 或完整敏感响应。

### 开发与验证

```powershell
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm run verify:runtime -- "C:\DSH-Versions\0.1.2-alpha.5\runtime"
pnpm pack --dry-run
```

- Host：[`lib/index.js`](lib/index.js)
- Client 源码：[`src/client-module.js`](src/client-module.js)
- Client 生成产物：[`lib/client.js`](lib/client.js)
- 生成器：[`scripts/build-client.js`](scripts/build-client.js)
- 非写入式生成物检查：[`scripts/check-client.js`](scripts/check-client.js)

修改 Client 源码后必须运行 `pnpm bundle`。`pnpm verify` 只检查生成产物是否同步，不会自动重写它。

生产依赖由 [`pnpm-lock.yaml`](pnpm-lock.yaml) 锁定。包没有 `preinstall`、`install` 或 `postinstall` 脚本；`prepack` 只在打包时运行验证。发布白名单只包含 Host、Client 生成产物、Runtime 契约探针、Composition patch、README、兼容性说明、LICENSE 和 `package.json`。

### DSH 升级检查

插件使用公开 Slot：

- `sidebar.footer.action`，接收侧栏的 `wide` owner prop
- `settings.section`

当前样式还使用 Slot renderer 输出的 `data-slot` 作为窄范围布局锚点。DSH 升级后应重新运行 `pnpm verify` 和 Composition dump，并在实际 GUI 中确认 Slot、Settings、Credential API、侧栏展开/折叠布局、30 天历史和刷新生命周期仍兼容。测试通过只说明已覆盖路径，不是对未来 Runtime 的兼容保证。

### 卸载

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh plugin --profile web remove dsh-relay-overview
```

仅当你曾在 Profile `cordis.patch.yml` 中手工添加 `relay-overview` 覆盖时，才需要同时删除该覆盖。随后由用户重启现有 DSH Web 进程并刷新页面。

插件当前没有卸载清理钩子；移除包不会主动删除已保存的 Settings 或插件托管 Credential。不要为清理插件而删除或重置 `C:\DSH-Versions\0.1.2-alpha.5\home`、旧 `.dsh-alpha2` 或其他 DSH Home。

### 许可证

MIT License。详见 [LICENSE](LICENSE)。

---

## English

`dsh-relay-overview` is a relay quota and recent-usage overview installed into a DSH Web Profile. It has a generic **Relay Overview** identity. Its current `sub2api` adapter reads the quota contract exposed by Sub2API and compatible implementations.

This source tree targets only the audited DSH `0.1.2-alpha.5` release and uses that version's `ctx.remote.credentials` Client API. It is not compatible with other DSH releases.

“Sub2API-compatible” describes an API contract; it does not establish which source code a relay runs.

### Features

- Configure a relay URL and API key in **Settings → 中转概览**, test the connection, and save.
- Show a Sunday-first heatmap for today plus the previous 29 Asia/Shanghai calendar days, with 30-day cost, request, and token totals.
- Show the top five models by request count and combine the remainder as Other.
- Fetch history only from a saved configuration and keep no local history database.
- Keep stored keys in the DSH Credential service; the browser can check configuration status but cannot read a saved value through this plugin.
- Show quota percentage, wallet balance, or an unlimited state in the sidebar, refreshing on load, every 60 seconds, on visibility restoration, after save, and on click.

Daily usage explicitly requests `timezone=Asia/Shanghai`. Model-stat date labels are interpreted in the relay server's configured timezone, so a non-Shanghai server can produce a small absolute-boundary difference between the heatmap and model totals.

### Requirements

The authoritative constraints are in [`package.json`](package.json):

- DSH `0.1.2-alpha.5` only
- Node.js `>=22.19.0`
- A Sub2API-compatible quota endpoint; an OpenAI-compatible model endpoint alone is not sufficient

### Install

This Alpha 5 adaptation lives at `C:\DSH-Versions\0.1.2-alpha.5\plugins\dsh-relay-overview`. After verification and packaging, install the pinned tarball into the independent Alpha 5 home with its matching CLI:

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh plugin --profile web add 'C:\DSH-Versions\0.1.2-alpha.5\plugin-packages\dsh-relay-overview-0.10.0.tgz'
```

The CLI adds the local dependency and Profile bundle and applies the package Composition patch; normal installation does not require a manual Profile YAML edit.

After installation, the user must restart the existing DSH Web process and refresh its page so the new Host and Client plugin are loaded. Do not use a separate Vite server as a replacement for the existing GUI. Once loaded, ordinary settings saves apply without another restart.

### Configure

Enter an HTTPS relay URL and API key, test, then save. A saved key is never filled back into the browser. A blank key can be reused only when changing the path within the same HTTPS origin; changing origin requires a new key.

For an advanced Profile override, repeat the complete config object:

```yaml
- id: relay-overview
  config:
    displayName: Relay
    baseURL: ''
    credentialRef: ''
    usagePath: auto
    allowRemote: false
```

A Profile row override replaces the entire `config`. Validate the result with the matching Alpha 5 CLI:

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh --profile web --dump-config
```

### Security boundary

- The browser calls only the same-origin local Host routes under `/relay-overview/*`; it never calls the configured upstream directly.
- The Host resolves the stored credential and sends it as a Bearer token only to the user-configured relay endpoint.
- Upstream URLs must use HTTPS and may not contain userinfo, a query, or a fragment. Redirects are rejected, response bodies are limited to 1 MiB, and public errors are sanitized.
- **SSRF/private-network boundary:** any syntactically valid HTTPS host is currently allowed. The plugin does not block loopback, private, link-local, or DNS-to-private targets and does not provide DNS-rebinding isolation. Treat the ability to call the local settings routes as privileged and configure only trusted relay endpoints.
- Status is direct-loopback-only by default. History, test, and save always remain direct-loopback-only. These checks follow the local DSH Web API trust boundary; they are not independent authentication against malicious local processes.
- `allowRemote: true` relaxes only the normalized status route and adds no plugin-level authentication. It never relaxes history, test, or save.
- Stored keys use origin-derived A/B managed Credential slots and a revision-fenced Settings switch. The plugin does not enumerate or broadly delete unrelated credentials.

### Quota semantics

- Key quota uses `quota.limit`, `quota.remaining`, and optional `quota.used`.
- When key quota and rolling limits coexist, the valid constraint with the smallest remaining amount is selected.
- Subscription mode selects the smallest remaining configured daily, weekly, or monthly allowance.
- Wallet mode displays the current balance; cumulative key spend is not treated as an original total.
- Unlimited mode has no fabricated total or percentage.
- Unknown or inconsistent upstream data fails validation instead of being guessed.

History output contains only 30 validated daily aggregates, a summary, and model name/request aggregates for the top five models plus Other. Raw responses, per-request records, model token/cost fields, and `account_cost` are not returned to the browser. Invalid optional model statistics degrade independently from valid daily history.

### Development

```powershell
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm run verify:runtime -- "C:\DSH-Versions\0.1.2-alpha.5\runtime"
pnpm pack --dry-run
```

Client source lives in [`src/client-module.js`](src/client-module.js); [`lib/client.js`](lib/client.js) is its generated artifact. Run `pnpm bundle` after Client changes. The package has no install lifecycle script; `prepack` runs verification for maintainers.

Runtime integration uses the public `sidebar.footer.action` and `settings.section` Slots. After a DSH upgrade, rerun verification and Composition dump, then check the actual GUI, Settings/Credential APIs, sidebar layout, history data, and refresh lifecycle.

### Uninstall

```powershell
$env:DSH_HOME = 'C:\DSH-Versions\0.1.2-alpha.5\home'
$Dsh = 'C:\DSH-Versions\0.1.2-alpha.5\runtime\node_modules\.bin\dsh.cmd'
& $Dsh plugin --profile web remove dsh-relay-overview
```

Remove a `relay-overview` Profile patch only if you added one manually, then have the user restart the existing DSH Web process and refresh the page. There is currently no uninstall cleanup hook, so removing the package does not actively delete saved Settings or managed Credentials. Never delete or reset `C:\DSH-Versions\0.1.2-alpha.5\home`, the legacy `.dsh-alpha2`, or another DSH Home to clean up this plugin.

### License

MIT. See [LICENSE](LICENSE).
