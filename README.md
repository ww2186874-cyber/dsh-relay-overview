# dsh-relay-balance

[中文](#中文) | [English](#english)

## 中文

一个永久安装到 DSH Web Profile 的侧栏额度组件。插件采用通用的 **Relay** 身份，当前 `sub2api` 适配器支持 Sub2API 及其兼容实现的 `GET /v1/usage` 响应。

> “Sub2API-compatible”只表示额度接口协议兼容，不代表中转站一定运行原版 Sub2API。

### 功能

- 设置页只需填写 **中转 URL + API Key**，支持测试连接和测试后保存。
- API Key 由 DSH Credential 服务保存；设置页只显示是否已配置，永远不会读回已存密钥。
- 展开侧栏只显示 `$剩余/$限额`、百分比和进度条；不显示站点名称或冗余说明。
- 订阅接口同时提供到期时间和额度窗口起点时，鼠标悬停展开卡片任意位置都会立即显示 `剩余N天（YYYY/MM/DD HH:mm） DdHh后重置`，且不附加其他内容。
- 折叠侧栏：真实配额显示百分比环；钱包余额显示金额；不限额显示 `∞`。
- 支持 API Key 总配额、5 小时/1 日/7 日滚动额度、订阅日/周/月限额、钱包余额和不限额模式。
- 加载、每 60 秒、页面恢复可见、保存配置和点击时刷新。
- Client 请求去重和 20 秒超时；Host 上游请求去重和 12 秒超时。
- 临时错误时保留最后一次成功数据并标记为过期。

### 正确的额度语义

插件不会再使用 `remaining + usage.total.actual_cost` 为所有站点虚构“总额度”：

- `quota_limited`：优先使用 `quota.limit / quota.used / quota.remaining`；若同时存在滚动额度，显示当前剩余金额最小的约束。
- 订阅：从已配置的日/周/月窗口中显示剩余金额最小的约束。
- 钱包：只把 `remaining`/`balance` 作为当前余额；`usage.total.actual_cost` 仅标记为当前 Key 的累计消费。
- 不限额：明确显示“不限额”，不生成伪造百分比。

### 要求

- DSH `>= 0.1.0-rc.8`
- Node.js `>= 22.19.0`
- 中转站提供 Sub2API-compatible 额度接口；只有 OpenAI-compatible 模型接口、没有额度接口的站点无法查询余额

### 使用

1. 打开 DSH Web 的 **Settings**。
2. 进入 **Relay Balance**。
3. 填写中转 URL，例如 `https://relay.example/v1`。
4. 填写 API Key。
5. 点击 **测试连接**；确认余额解析正确后，点击 **测试并保存**。

保存后的 API Key 不会回填到浏览器。只在同一个 HTTPS origin 内修改路径时，可以把 API Key 留空并继续使用现有密钥；切换到另一个中转站（origin 改变）时必须填写新 Key。

从 `0.2.x` 升级时，插件会将原 `providerId` 对应 Provider 的 URL 和 credential reference 作为初始配置来源，因此原有余额查询会继续工作。第一次在设置页保存后，插件使用自己的 `dsh-relay-balance` Settings namespace，不再要求用户理解 Provider/YAML。

### 安装

从 npm 安装（发布到 npm 后）：

```powershell
dsh plugin --profile web add dsh-relay-balance
```

从 GitHub 安装：

```powershell
dsh plugin --profile web add github:ww2186874-cyber/dsh-relay-balance
```

本地开发安装：

```powershell
dsh plugin --profile web add C:\path\to\dsh-relay-balance
```

正常使用无需编辑 YAML，安装并重启现有 DSH Web 后，直接在 **Settings → Relay Balance** 中配置。

以下 Cordis row 仅供高级部署或旧版兼容。**Profile patch 覆盖 row config 时会替换整个 `config`，所以必须重述所有键：**

```yaml
- id: relay-balance
  config:
    providerId: sub2api
    displayName: Relay
    baseURL: ''
    credentialRef: ''
    usagePath: auto
    allowRemote: false
```

配置项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `sub2api` | 旧版兼容：从 `llm-pi-ai.providers` 读取初始 URL 和 credential reference |
| `displayName` | `Relay` | 仅用于可访问性/兼容数据；当前简约卡片不显示名称 |
| `baseURL` | 空 | 可选的 composition 层 URL；通常由设置页写入用户 Settings 层 |
| `credentialRef` | 空 | 与 `baseURL` 配对的 Credential reference；不是 API Key 明文 |
| `usagePath` | `auto` | 自动尝试 `<baseURL>/usage` 及常见 `/v1/usage` 变体 |
| `allowRemote` | `false` | 是否允许非回环客户端访问状态接口；测试和保存接口始终仅限直接回环 |

验证最终 composition：

```powershell
dsh --profile web --dump-config
```

然后重启**现有** DSH Web 进程并刷新 `http://127.0.0.1:3080`。不要另起 Vite Server 代替现有 GUI。

### 安全边界

- 新 API Key 只会在密码输入框和一次同源写入/连接测试请求中短暂存在；保存后立即清空。Host 以后通过 `credentials.resolve()` 在每次真实上游查询时重新解析，浏览器不能读回已存值。
- 非敏感 URL/credential reference 写入 DSH Settings；实际 API Key 写入 DSH Credential provider（本地 provider 默认使用受限权限的 `.credentials.yaml`，不是浏览器存储或插件 YAML）。
- 上游只允许 HTTPS，拒绝 URL userinfo、query 和 fragment；改变 URL 等同于改变 API Key 的接收方，因此保存前必须先测试连接。
- 上游请求使用 `redirect: 'error'`，并防御性拒绝 `redirected` 和 HTTP 3xx。
- 响应正文同时受 `Content-Length` 和实际流式字节数的 1 MiB 限制，使用严格 UTF-8 解码。
- `/relay-balance/status` 默认只接受直接回环连接；`/relay-balance/test` 和会修改 Settings/Credential 的 `/relay-balance/save` 始终只接受直接回环 JSON POST。TCP peer 和 `Host` 都必须是 loopback，且请求不能携带常见代理转发头；同时拒绝跨站浏览器请求。
- 这沿用 DSH rc.8 对本机 Web API 的信任边界，不是独立的用户认证系统，不能抵御已经能直接调用本机 DSH loopback API 的恶意进程。不要在不信任的多人系统账户中使用；本机反向代理也必须在代理层完成身份认证。`allowRemote: true` 只放宽状态接口，不会放宽测试或保存接口。
- 公共错误经过脱敏，不回传上游正文或原始异常。

### 支持的 Sub2API 数据形状

当前适配器读取：

- `isValid`, `mode`, `planName`, `unit`
- `quota.limit`, `quota.used`, `quota.remaining`
- `rate_limits[].window/limit/used/remaining/reset_at`
- `subscription.daily_*`, `subscription.weekly_*`, `subscription.monthly_*`
- `subscription.expires_at`, `subscription.weekly_window_start`, `subscription.monthly_window_start`
- `balance` / `remaining`
- `usage.total.actual_cost`

不同 Fork 可能修改接口；请提交一个经过脱敏的响应字段结构和版本信息，而不是提交真实 Key 或完整敏感正文。

### 开发与验证

```powershell
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm pack --dry-run
```

- Host：`lib/index.js`
- Client 源码：`src/client-module.js`
- 生成产物：`lib/client.js`
- 生成器：`scripts/build-client.js`
- 非写入式生成物检查：`scripts/check-client.js`

`pnpm verify` 不会自动重写 Client 产物；过期时会失败，要求先运行 `pnpm bundle` 并提交生成结果。

### DSH 升级检查

升级 DSH 后运行测试、检查 composition，并确认：

1. 展开侧栏中 Relay 是完整的 footer row；
2. 折叠侧栏中 Relay、Cordis 和 Settings 仍纵向排列；
3. 点击、分钟、可见性和超时刷新正常；
4. `/relay-balance/status` 只返回归一化后的公开字段。

组件使用公开 Slot `sidebar.footer.action` 和 owner prop `wide`。两条窄范围的 `:has()` 兼容规则只依赖公开 `data-slot` 标记，用于适配 rc.8 的 `display: contents` Slot wrapper。

### 卸载

```powershell
dsh plugin --profile web remove dsh-relay-balance
```

同时删除 Profile `cordis.patch.yml` 中针对 `relay-balance` 的覆盖，然后重启 DSH Web。

### 许可证

MIT License。详见 [LICENSE](LICENSE)。

---

## English

A permanent DSH Web Profile sidebar quota indicator. The package has a generic **Relay** identity; its first adapter supports the `GET /v1/usage` contract exposed by Sub2API and compatible implementations.

“Sub2API-compatible” describes an API contract. It does not prove that a relay runs the original Sub2API source.

### Configure

Open **Settings → Relay Balance**, enter the relay URL and API key, test the connection, and save. The key is written through the DSH Credentials API and is never read back into the browser. A blank key may be reused only when changing the path within the same HTTPS origin; changing relay origin requires a new key. Existing `0.2.x` Provider configuration remains a migration fallback.

### Install

From npm after the package has been published:

```sh
dsh plugin --profile web add dsh-relay-balance
```

Or directly from GitHub:

```sh
dsh plugin --profile web add github:ww2186874-cyber/dsh-relay-balance
```

No YAML edit is required for normal use. For advanced composition or migration, a complete row override is:

```yaml
- id: relay-balance
  config:
    providerId: sub2api
    displayName: Relay
    baseURL: ''
    credentialRef: ''
    usagePath: auto
    allowRemote: false
```

`providerId` is retained as a `0.2.x` migration fallback. The settings page persists its own URL and credential reference after the first save.

Restart the existing DSH Web process after installation; settings changes apply live.

### Quota semantics

- Key quota: uses `quota.limit`, `quota.used`, and `quota.remaining`.
- Rolling limits: uses the active 5-hour/day/7-day constraint with the smallest remaining amount.
- Subscription: uses the configured daily/weekly/monthly constraint with the smallest remaining amount. When the upstream supplies expiry and window-start timestamps, hovering anywhere on the expanded card immediately shows only the subscription days/date and quota-reset countdown.
- Wallet: displays the current wallet balance; cumulative key spend is not treated as an original total.
- Unlimited: displays an explicit unlimited state and no fabricated percentage.

### Security

A newly typed key crosses the same-origin Host wire only in a test/save request, then the password draft is cleared. The Host performs credential staging and the revision-fenced Settings switch; stored keys are never read back by the browser and are resolved on the Host for every real upstream query. Upstream URLs must use HTTPS; redirects are rejected; response bodies are limited to 1 MiB and decoded as strict UTF-8. Public errors are sanitized.

By default the status route accepts only direct loopback requests. The test and settings/credential-mutating save routes always require a loopback peer and Host, no common proxy-forwarding headers, and no cross-site browser signal. This follows the DSH rc.8 local Web API trust boundary; it is not separate user authentication and does not defend against a malicious process that can directly call the local DSH loopback API. A local reverse proxy therefore counts as remote deployment and must enforce authentication. `allowRemote: true` relaxes only the status route, never test or save.

### Development

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm pack --dry-run
```

### License

MIT. See [LICENSE](LICENSE).
