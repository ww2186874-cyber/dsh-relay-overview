# dsh-relay-balance

[中文](#中文) | [English](#english)

## 中文

一个永久安装到 DSH Web Profile 的侧栏额度组件。插件采用通用的 **Relay** 身份，当前 `sub2api` 适配器支持 Sub2API 及其兼容实现的 `GET /v1/usage` 响应。

> “Sub2API-compatible”只表示额度接口协议兼容，不代表中转站一定运行原版 Sub2API。

### 功能

- 展开侧栏：显示 Relay 名称、额度类型、余额/限额和进度条。
- 折叠侧栏：真实配额显示百分比环；钱包余额显示金额；不限额显示 `∞`。
- 支持 API Key 总配额、5 小时/1 日/7 日滚动额度、订阅日/周/月限额、钱包余额和不限额模式。
- 加载、每 60 秒、页面恢复可见和点击时刷新。
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
- 一个配置在 `llm-pi-ai.providers` 下、并提供 `baseURL` 与 `apiKeyEnv` 的 Sub2API-compatible Provider
- 对应 credential 已在 DSH Credentials 中配置

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

安装后，在 Web Profile 的 `cordis.patch.yml` 中覆盖 Bundle 插入的 `relay-balance` row。**Cordis patch 会替换整个 `config`，所以必须重述所有键：**

```yaml
- id: relay-balance
  config:
    providerId: my-relay
    displayName: My Relay
    usagePath: auto
    allowRemote: false
```

配置项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `sub2api` | `llm-pi-ai.providers` 下的 Provider ID |
| `displayName` | `Relay` | 侧栏中显示的名称，不会被当作协议或站点品牌 |
| `usagePath` | `auto` | 自动尝试 `<baseURL>/usage` 及常见 `/v1/usage` 变体；也可写固定绝对路径，如 `/v1/usage` |
| `allowRemote` | `false` | 是否允许非回环客户端访问本地状态接口 |

验证最终 composition：

```powershell
dsh --profile web --dump-config
```

然后重启**现有** DSH Web 进程并刷新 `http://127.0.0.1:3080`。不要另起 Vite Server 代替现有 GUI。

### 安全边界

- API Key 仅由 Host 通过 `credentials.resolve(apiKeyEnv)` 在每次真实上游查询时解析；浏览器不会收到 API Key、credential reference、Authorization Header、Provider 配置或上游正文。
- 上游只允许 HTTPS，拒绝 URL userinfo、query 和 fragment；改变 `baseURL` 等同于改变 credential 的接收方，因此只有受信任管理员才能修改 Provider settings。
- 上游请求使用 `redirect: 'error'`，并防御性拒绝 `redirected` 和 HTTP 3xx。
- 响应正文同时受 `Content-Length` 和实际流式字节数的 1 MiB 限制，使用严格 UTF-8 解码。
- `/relay-balance/status` 默认只接受直接回环连接：TCP peer 和 `Host` 都必须是 loopback，且请求不能携带常见代理转发头；同时拒绝跨站浏览器请求。它不是完整的用户认证系统。
- 本机反向代理属于远程部署，必须在代理层完成身份认证后显式设置 `allowRemote: true`。这会信任外层访问控制；不要在无认证的局域网或公网部署中开启。
- 公共错误经过脱敏，不回传上游正文或原始异常。

### 支持的 Sub2API 数据形状

当前适配器读取：

- `isValid`, `mode`, `planName`, `unit`
- `quota.limit`, `quota.used`, `quota.remaining`
- `rate_limits[].window/limit/used/remaining/reset_at`
- `subscription.daily_*`, `subscription.weekly_*`, `subscription.monthly_*`
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

### Install

From npm after the package has been published:

```sh
dsh plugin --profile web add dsh-relay-balance
```

Or directly from GitHub:

```sh
dsh plugin --profile web add github:ww2186874-cyber/dsh-relay-balance
```

Override the complete row config in the Web Profile's `cordis.patch.yml`:

```yaml
- id: relay-balance
  config:
    providerId: my-relay
    displayName: My Relay
    usagePath: auto
    allowRemote: false
```

`providerId` selects an entry under `llm-pi-ai.providers`. That provider must define `baseURL` and `apiKeyEnv`, and the referenced DSH credential must exist.

Restart the existing DSH Web process after install or configuration changes.

### Quota semantics

- Key quota: uses `quota.limit`, `quota.used`, and `quota.remaining`.
- Rolling limits: uses the active 5-hour/day/7-day constraint with the smallest remaining amount.
- Subscription: uses the configured daily/weekly/monthly constraint with the smallest remaining amount.
- Wallet: displays the current wallet balance; cumulative key spend is not treated as an original total.
- Unlimited: displays an explicit unlimited state and no fabricated percentage.

### Security

Credentials stay on the Host and are resolved for every real upstream query. Upstream URLs must use HTTPS; redirects are rejected; response bodies are limited to 1 MiB and decoded as strict UTF-8. Public errors are sanitized.

By default the status route accepts only direct loopback requests: loopback peer and Host, with no common proxy-forwarding headers. A local reverse proxy therefore counts as remote deployment. Set `allowRemote: true` only after that proxy enforces authentication; Origin checks are not user authentication.

### Development

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm pack --dry-run
```

### License

MIT. See [LICENSE](LICENSE).
