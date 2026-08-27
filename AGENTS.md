# dsh-relay-balance 项目记忆

本文件是 `dsh-relay-balance` 的项目级持久记忆，供后续开发者和 AI Agent 在全新会话中读取。开始修改前，应同时阅读本文件、`README.md`、`package.json`，并检查 Git 工作区；不得覆盖用户或其他开发者已有的未提交更改。

## 1. 项目身份

- 包名与插件名：`dsh-relay-balance`
- 产品身份：通用 **Relay Balance**，不要使用 NBAPI 品牌。
- 当前首个适配器：`sub2api`。
- “Sub2API-compatible”只表示额度接口协议兼容，不代表目标站点运行原版 Sub2API，也不能据此声称其源码来源。
- 这是永久安装到 DSH Web Profile 的 Cordis Profile Bundle，不是仅在当前进程中存在的 Dynamic Cordis Plugin。
- 插件源码仓库的固定位置：`C:\Users\12187\.dsh\profiles\web\packages\dsh-relay-balance`
- Web Profile composition：`C:\Users\12187\.dsh\profiles\web\cordis.yml` 及其 `cordis.patch.yml`。
- 插件 row id：`relay-balance`。

## 2. DSH Runtime 与插件源码的边界

- DeepSeek Harness（DSH）Runtime 和本插件是两个分开存放、分开维护的项目。
- DSH Runtime 安装在 `C:\Users\12187\AppData\Local\dsh-runtime\<版本目录>`；版本升级可能更换该版本目录。
- 插件源码位于 Web Profile 的 `packages\dsh-relay-balance`，正常升级 DSH Runtime 不应修改、迁移或覆盖此源码仓库。
- 不要从某个旧版本号推断当前 Runtime 路径。需要检查 DSH 本体时，先确认当前实际版本和 checkout。
- DSH 升级不会自动改变插件源码，但可能改变插件依赖的 Service、Slot、Settings、Client Runtime、构建产物协议或页面布局。因此“源码未变”不等于“运行兼容性必然不变”。升级后必须执行本文件的兼容性检查。
- 只有在用户明确要求修改 DSH 本体时，才可以编辑 Runtime checkout。不要为了实现插件功能而偷偷修改已安装的 DSH 文件。
- Runtime checkout 中的直接改动可能被下一次 DSH 升级覆盖；需要长期保留的 DSH Shell 能力应提交上游或维护为明确、可重放的补丁。
- 不要擅自停止、重启或重新启动 DSH Host、Web GUI 或相关进程。若变更需要重启，只说明原因并让用户本人操作。

## 3. 产品与界面决策

### 侧栏卡片

- 不显示 Provider 名称或站点名称。
- 展开状态同一行左侧显示 `$remaining/$total`，右侧显示百分比，下一行显示进度条。
- 订阅上游同时提供 `expires_at` 和额度窗口起点时，鼠标悬停展开或折叠卡片任意位置都应立即在卡片右侧显示插件自绘提示 `剩余N天（YYYY/MM/DD HH:mm） DdHh后重置`；提示字体为易读的 `13px`，使用插件拥有的页面级浮层绕过 DSH 侧栏列的 `overflow: hidden`，不要修改 Shell 或依赖浏览器原生 `title`。提示中不得加入余额、百分比、套餐名、错误或其他信息。
- 不显示“周额度 / 剩余 / 限额”等冗余可见标签。
- 折叠状态：真实配额显示百分比环；钱包余额显示金额；不限额显示 `∞`。
- 加载、每 60 秒、页面恢复可见、保存配置和用户点击时刷新。
- 临时错误应保留最后一次成功数据并标记为过期，而不是立即清空。

### 设置页

- 普通用户只应看到：近 30 天使用热力图、模型调用量环形图、中转 URL、API Key、测试连接、测试并保存。
- 热力图位于标题下、配置表单上方，按北京时间显示今天及此前 29 个自然日，不建立本地历史数据库；Host 请求 `days=30&timezone=Asia/Shanghai`，并为模型统计传入相同 30 个日期标签的 `start_date/end_date`，裁掉更早每日数据，并将上游未返回的日期补为 0。Sub2API 当前仅对 `daily_usage` 应用 `timezone`；`model_stats` 的日界线由中转站服务器时区解释，非上海时区部署可能存在绝对时间边界偏差，不能声称两者必然是同一个北京时间绝对窗口。
- 热力图使用周日在上的 GitHub 式 7 行布局和小圆角方格；零用量使用主题自适应的中性灰，有用量按四档蓝色色阶逐级加深；不显示月份、星期或图例，今天使用蓝色细描边。
- 热力图卡片标题右侧紧凑显示 30 天累计实际扣费、请求数和 Token；悬停/聚焦/触屏点击方格时，深色浮层显示日期、扣费、请求数和 Token。
- 同一卡片右侧显示按请求次数统计的模型调用量环形图，不显示独立的“模型调用量”可见小标题；环形图与图例从内容区顶部开始，与左侧热力图顶部对齐。前 5 个模型单列，其余合并为“其他模型”，中心显示模型统计自身的总调用数；图例与交互提示显示模型名、调用数和占比。窄屏时环形图移到热力图下方。
- 热力图和模型环形图只使用已保存配置并共用一次 30 天请求；保存前不请求历史。进入页面自动刷新，右上角支持手动刷新，保存配置后随全局余额刷新事件更新。
- 不向普通用户暴露 Provider、Credential reference 或 YAML 概念。
- 保存后不得把 API Key 回填到浏览器。
- 只有 HTTPS origin 相同、仅路径发生变化时，才允许 API Key 留空并复用现有密钥；切换 origin 时必须填写新 Key。
- 当前 Settings section id 为 `relay-balance`，面向用户的 label 与设置页标题均为 `中转余额`；包名、插件 ID、Settings namespace 和通用产品身份保持不变。
- 自定义 Settings 导航图标是否受支持取决于当前 DSH Settings Shell 的公开协议。旧版 rc.8 仅按内置 section id 选择图标，未知 id 回退为齿轮；在新 Runtime 上实现图标前必须重新检查，不要使用冒充保留 id 或脆弱的 DOM/CSS 替换。

## 4. 架构

### Host

- 主文件：`lib/index.js`。
- 注册 Settings namespace：`dsh-relay-balance`。
- 本地路由：
  - `GET /relay-balance/status`
  - `GET /relay-balance/history`
  - `POST /relay-balance/test`
  - `POST /relay-balance/save`
- Host 负责：读取配置、解析 Credential、请求上游、归一化额度、近 30 天每日聚合与模型调用聚合、测试连接、原子化保存设置与密钥、清理不再使用的托管密钥。
- 历史公开数据只含每日 `date`、`actualCost`、`requests`、`totalTokens`、30 天汇总，以及白名单化的模型 `model` 与 `requests` 聚合。模型统计最多输出前 5 名和一个“其他”计数，不公开模型 Token、成本、`account_cost`、原始 `model_stats`、原始响应或逐请求记录；模型统计缺失或无效时必须降级为不可用，而不能破坏每日热力图。

### Client

- 源码真源：`src/client-module.js`。
- 生成产物：`lib/client.js`。
- 生成器：`scripts/build-client.js`。
- Client 使用的公开 Slot：
  - `sidebar.footer.action`
  - `settings.section`
- 浏览器只调用本机 Host 路由，不得直接请求用户填写的上游中转 URL。
- 浏览器可以查询 Credential 是否已配置，但不得读取已存密钥，也不得自行调用 Credential 写入/删除 API。
- Client 代码修改后先运行 `pnpm bundle`；不得手工修改 `lib/client.js` 来绕过生成流程。

### Composition

- 包内默认 row：`cordis.patch.yml`。
- Web Profile 的部署覆盖：`C:\Users\12187\.dsh\profiles\web\cordis.patch.yml`。
- Profile patch 覆盖 row config 时会替换整个 `config`，所以覆盖项必须重述完整配置键。
- 修改 composition 前应加载 `editing-cordis-compositions` skill，并按当前 DSH 的 composition 规则验证。

## 5. 额度语义不变量

不得把 `remaining + usage.total.actual_cost` 统一当作所有模式的总额度。

- `quota_limited`：优先使用 `quota.limit / quota.used / quota.remaining`；同时存在滚动限制时，选择当前剩余金额最小的有效约束。
- 订阅模式：在已配置的日、周、月窗口中选择剩余金额最小的有效约束。
- 钱包模式：`remaining` 或 `balance` 是当前钱包余额；`usage.total.actual_cost` 只是当前 Key 的累计消费，不是钱包原始总额。
- 不限额模式：明确表示不限额，不伪造 total 或 percentage。
- 对未知或自相矛盾的数据形状应安全失败，不要凭猜测生成额度。

## 6. 安全不变量

以下边界不得为了简化代码而削弱：

- 上游只允许 HTTPS。
- 拒绝 URL userinfo、query 和 fragment。
- 上游请求使用 `redirect: 'error'`，并防御性拒绝 redirected 响应和 HTTP 3xx。
- Host 上游超时 12 秒；Client 本地操作超时 20 秒。
- 上游响应同时受 `Content-Length` 和实际读取字节数的 1 MiB 限制，并使用严格 UTF-8 解码。
- 对外错误必须脱敏，不能返回上游正文、API Key、Credential 值或原始敏感异常。
- `/relay-balance/test` 与 `/relay-balance/save` 始终只接受直接 loopback、同站点 JSON POST；历史路由始终只接受直接 loopback，状态路由默认也只接受直接 loopback。
- loopback 防护沿用 DSH 本机 Web API 的信任边界，不是抵御本机恶意进程的独立身份认证。
- 托管 Credential slot 由 origin 的 SHA-256 派生，使用 A/B 双槽：`DSH_RELAY_BALANCE_<32_HEX>_A` 与 `_B`。
- Host 必须串行执行完整的测试、暂存密钥、Settings revision 切换和清理事务。
- Settings 更新必须使用 `expectedRevision`。
- 明确的 `SETTINGS_CONFLICT` 应回滚未启用的暂存密钥；提交结果不明确时必须保留暂存数据，避免删除可能已经生效的密钥。
- 清理操作只能触及由旧 URL 的精确 origin 派生出的托管槽，不能广泛删除 Credential。
- 所有 Client/Host 副作用必须具有正确生命周期和清理逻辑。

## 7. 配置与迁移

- 正常用户配置保存在 Settings namespace `dsh-relay-balance`。
- 非秘密配置包含 `baseURL`、`credentialRef`、`usagePath`；API Key 本体只保存在 DSH Credential provider。
- `providerId` 保留用于从 `0.2.x` Provider 配置迁移，不能重新包装成面向普通用户的 Provider 设置。
- 当前兼容配置仍应保持完整键：`providerId`、`displayName`、`baseURL`、`credentialRef`、`usagePath`、`allowRemote`。

## 8. 开发流程

开始工作前：

1. 确认当前工作目录和插件仓库实际路径。
2. 阅读本文件、`README.md`、`package.json` 和待改文件。
3. 运行 `git status --short --branch`；保留所有既有未提交修改，不要擅自还原。
4. 若任务依赖 DSH API、Slot 或 Settings 行为，确认当前 DSH 版本并检查该版本的公开接口，不能只依赖旧版结论。

常用命令：

```powershell
pnpm install --ignore-workspace --frozen-lockfile
pnpm bundle
pnpm verify
pnpm pack --dry-run
```

完成代码修改后至少：

1. 若修改 Client 源码，运行 `pnpm bundle`。
2. 运行 `pnpm verify`。
3. 运行 `pnpm pack --dry-run` 检查发布内容。
4. 使用当前 DSH CLI 对 Web Profile 执行 composition dump/validation。
5. 如需让正在运行的 GUI 载入新的 Host 或普通 Web 产物，只告诉用户需要重启或刷新及原因；不得由 Agent 自行重启。

## 9. DSH 升级后的兼容性检查

每次 DSH Runtime 升级后，至少确认：

1. `pnpm verify` 全部通过，Client 生成产物没有漂移。
2. 当前 Web Profile composition 能成功解析。
3. `/relay-balance/status` 与 `/relay-balance/history` 返回 200，且只含归一化后的公开字段；模型聚合只含模型名和调用次数。
4. 设置页仍只显示近 30 天热力图、模型调用量环形图、URL、API Key、测试连接和测试并保存。
5. API Key 保存后不回填；跨 origin 留空 Key 仍被拒绝。
6. 展开侧栏仍是完整 footer row；折叠时 Relay、Cordis 和 Settings 布局正常。
7. 点击、分钟、页面可见性和超时刷新仍正常。
8. 当前版本的 `settings.section`、`sidebar.footer.action`、Settings 和 Credential API 签名没有破坏性变化。

测试通过只能说明覆盖范围内兼容；涉及新 DSH UI 能力时仍应检查当前 Runtime 的真实公开协议。

## 10. Git 与发布

- 不要擅自 push、创建 tag、发布 npm 包或创建 GitHub Release。
- 不要修改已有提交历史，除非用户明确要求。
- 提交前说明包含哪些文件与验证结果。
- `lib/client.js` 是必须随源码同步提交的生成产物。
- 安装在 Profile 中不等于已经发布到 npm 或 GitHub Release。
