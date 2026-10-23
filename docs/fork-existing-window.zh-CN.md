# 本地定制版：现有窗口与显式恢复

> 本分支现已增加 **BrowserSkill-2 蓝色图标与可点击恢复**，页面/扩展 popup 的“继续执行”需要配套协议 1.6；见[新版说明](extension-click-resume.zh-CN.md)。下文的协议 1.5 与旧测试记录描述此前的核心窗口/CLI 功能。

这是 `yzxq1/BrowserSkill` 的 `feat/existing-window-resume` 分支。保留上游 MIT 许可证；默认独立 Agent Window 行为不变。

## 哪些功能必须改扩展

以下结论来自上游源码（`Tencent/BrowserSkill` 提交 `e8777ab`）：

| 需求 | 是否必须改扩展 | 依据 |
|---|---|---|
| 在正在使用的窗口末尾追加标签页，不新建窗口 | **必须改扩展** | 官方扩展新建标签页时固定使用 Agent Window（`apps/extension/src/tools/tabs.ts` 中 `windowId: ctx.agentWindowId`）；借用页面也会先移进 Agent Window（`moveTabForBorrow`）。CLI 加参数改变不了扩展的这一行为。 |
| Interrupt 后持续暂停，明确恢复后继续原会话 | **不必须，只改本机 bsk/daemon 基本能实现** | 官方扩展点击 Interrupt 后只向 daemon 发送 `session.user_interrupt` 通知；“只拦一次”的逻辑在 daemon（`crates/bsk-cli/src/daemon/ipc.rs` 的 `try_consume`）。 |

只改 bsk/daemon 实现持续暂停的方式：daemon 把一次性标记改为持续暂停，暂停期间的操作在 daemon 就被拒绝，不会发给扩展，页面遮罩保持暂停；恢复时由 daemon 清除暂停，下一次操作时官方扩展会自动把遮罩切回控制状态。

只改 bsk 的局限：

- Interrupt 通知没送到 daemon（断连等）时不会暂停。
- 浏览器端没有独立暂停保护，完全依赖 daemon 拦截。

这项“只改 bsk、保留官方扩展”的实现在单独分支 `feat/interrupt-resume-official-extension`。**本分支**的 `session resume` 要求扩展协议 1.5，配官方扩展时会被拒绝，必须与本分支构建的扩展配套使用。

## 不新建窗口，后台追加任务页

```sh
bsk session start --browser BROWSER_ID --window current --json
```

`current` 选择当前可确定的普通用户窗口，排除其他任务的 Agent Window。窗口无法明确选择时应报错，不偷偷新建窗口，也不改用其他浏览器实例。亦可明确指定窗口：

```sh
bsk session start --browser BROWSER_ID --window WINDOW_ID --json
```

保留返回的 `session_id` 和 `default_tab_id`。任务首页在目标窗口末尾以后台标签页创建；你的当前标签页保持不变。不带 `--window` 时仍使用上游独立窗口模式。

现有窗口模式不能与 `--incognito`、窗口尺寸或 `--focus` 混用。同一个窗口同时只承载一个任务会话。共享窗口不代表授权读取整个窗口：任务只能控制自己创建或明确借用的标签页。

```sh
bsk navigate https://example.com --session SESSION_ID
bsk observe --session SESSION_ID
```

未提供 `--tab-id` 时指向任务自己的默认页，而不是你当前选中的页面。

### 原地接管已有页面

```sh
bsk tab list --scope user --session SESSION_ID --json
bsk tab borrow TAB_ID --session SESSION_ID
# 按浏览器设置完成借用确认，随后使用新读取的页面 refs 操作。
bsk tab return TAB_ID --session SESSION_ID
```

同一共享窗口内的页面采用原地借用和释放，不必搬进另一窗口。借用确认仍由扩展设置决定，不能用命令行绕过。

### BSK2 标签组

现有窗口会话启动时，扩展会把后台追加的任务页放入一个蓝色的 **`BSK2`** Chrome 标签组。之后由会话新建的页面，以及你明确确认借用的同窗口页面，都会加入该组；所以可以清楚分辨 BSK2 正在操作的标签与自己的原有标签。

标签组只是视觉标记，绝不授予控制权：同窗口里的其他标签仍必须通过借用确认后才能操作。归还借用标签时会立即移出该组；停止会话时，扩展解除仍受控页面的分组但不关闭任何页面或窗口。若用户手动删除或调整分组，扩展不会认领同名分组；后续受控标签会创建新的 `BSK2` 组。

### 停止任务

```sh
bsk session stop SESSION_ID
```

现有窗口模式释放会话、调试连接和控制遮罩，保留窗口和页面，不批量关闭任务页，更不会关闭你的其他标签页。任务结束后可自行关闭不需要的页面。

## Interrupt：暂停，不销毁页面

点页面上的 Interrupt 后：

- 浏览器本地立即暂停并取消该会话正在执行的操作，不以 daemon 通知成功为前提。
- 在途命令和后续写操作都返回 `user_aborted` / `session_paused`，并附带“用户正在接管；不得重试、开新标签、新建会话或导航”的 Agent 指令。
- Agent 收到此信号应明确回复“已暂停，正在等待你接管完成”，然后停止浏览器工作；暂停不是可自动恢复的普通报错。
- 后续输入持续被拒绝，不是第一次报错后自动恢复。
- 不自动刷新、导航、新开页面或重放被打断的操作。
- 可查看会话状态，或直接停止任务。带 hover 探测的 `observe`、滚动截图及任意 `evaluate` 不能作为“纯读取”偷偷继续执行。

用户明确要求继续时：

```sh
bsk session list --json
bsk session resume SESSION_ID --json
bsk observe --session SESSION_ID
```

`resume` 继续同一个运行中的会话与页面。旧操作尚未结束补偿清理时，恢复会返回 busy，应等它结束；恢复过程再次收到 Interrupt 时保持暂停。恢复失败不能改成重新开一个页面来假装继续。

**限制：不提供跨浏览器关闭、扩展 Service Worker 重启或 daemon 会话丢失的恢复。** 页面尚在与会话尚在不是同一回事；失效后必须重新确认标签归属并接管。

## 构建与版本兼容

```sh
pnpm install --frozen-lockfile
cargo test --workspace --locked
pnpm ext:test
cargo build --release --locked
pnpm ext:build
```

产物：

- CLI：`target/release/bsk`
- Chrome 扩展：`apps/extension/dist/chrome-mv3/`

现有窗口与显式恢复使用协议 **1.5**，须配套使用本分支 CLI、daemon 和扩展。旧端会被版本检查拒绝，不会忽略 `--window` 后退回新窗口。

开发时推荐使用仓库内的启动脚本：

```sh
./scripts/bsk-fork.sh session start --browser BROWSER_ID --window current --json
./scripts/bsk-fork.sh session resume SESSION_ID --json
```

脚本调用本仓库的 `target/release/bsk`，关闭自动更新，并拒绝会覆盖定制版的 `update` 命令。它不会自动替换、停止或重启已经运行的 daemon；如连到旧 daemon，会因协议不支持而拒绝新功能。先等待现有任务结束，再单独安排切换。

开发时也可用完整路径调用构建产物，**不要直接覆盖正在运行的 `~/.local/bin/bsk` 或重启其他任务使用的 daemon**。替换正式使用版本前，应结束现有任务并确认扩展安装和连接实例。定制 daemon 应设置 `BSK_AUTO_UPDATE=off`，避免官方自动更新覆盖定制功能；手动 `bsk update` 也会安装上游版本，不用于更新本分支。

## 回归检查重点

1. 新任务后台追加末尾，用户活动页、原窗口和已有会话均不受影响。
2. 未授权的原有页面不能被默认目标、显式 tab ID、关闭、选择、截图或弹出页路径接管。
3. 借用确认、原地归还、启动取消、发送失败、断连及停止均不误删用户窗口。
4. 连续动作不会消费掉暂停；旧操作清理、恢复失败和再次中断不会被自动重试绕过。
5. 默认独立窗口模式保持回归兼容。

## 本轮验证（2026-10-23，v0.3.5-bsk2）

- 合并 `main`（蓝色界面、点击恢复、弹窗策略、`bsk2` / `52801` / `~/.bsk2` 隔离）与 BSK2 标签组、用户接管等待，提交 `a09998c`。
- 扩展 TypeScript 类型检查通过；扩展全量单元测试 2732 通过、246 跳过、0 失败（合并后曾有 22 项失败，已修复）。
- Rust 全工作区 872 通过、1 忽略、0 失败；`cargo fmt --check`、`cargo build --release --locked` 通过。修正了改名 `bsk2` 后集成测试仍引用 `CARGO_BIN_EXE_bsk`、测试写入真实 `~/.bsk2` 的问题。
- `pnpm lint` 通过，含 DSH plugin 538 项测试。
- 扩展构建产物 manifest：`BrowserSkill-2 0.3.5`，含 `tabGroups` 权限，不含 `key`（扩展 ID 仍由加载目录决定）。
- 本机已部署：`~/.local/bin/bsk2` 0.3.5、daemon 端口 52801；Chrome 加载目录 `~/ChromeExtensions/BrowserSkill-2` 已同步为 0.3.5，需在 `chrome://extensions` 点刷新。

## 早期验证（2026-10-21）

- 扩展 TypeScript 类型检查、`pnpm ext:build`：通过。
- 扩展全量单元测试：2705 通过、245 跳过、0 失败。跳过项包括需显式配置的浏览器集成测试，不表示这些测试已执行。
- Rust 全工作区：869 通过、1 忽略、0 失败；`cargo build --release --locked` 通过。
- `pnpm lint`：通过，含 DSH plugin 类型检查及 538 项测试。第三方依赖缺失 source map 的警告不影响退出码。
- 新增真实 Chrome for Testing 集成测试已单独执行，并连续三次通过：验证追加末尾、不切换用户活动页、未授权页面读取拒绝、原地借用/归还、连续暂停、恢复同页面、停止保留全部页面。测试使用独立临时 Profile，不接触现有 Chrome 登录态。

真实浏览器测试命令（Chrome for Testing 的实际路径由运行者指定）：

```sh
BSK_EXISTING_WINDOW_CHROME="/path/to/chrome-for-testing" \
  pnpm --filter @browser-skill/extension exec vitest run \
  src/session-manager/__tests__/existing-window.browser.test.ts
```

本地现有 `~/.local/bin/bsk`、运行中的 daemon 以及已安装 Chrome 扩展均未替换。正式使用新功能仍需切换到本分支 CLI/daemon，并加载同分支构建的扩展。`default_tab_id` 在启动响应和 daemon 会话元数据中记录启动时的任务页；浏览器内后续 borrow/select 可改变默认操作目标，应重新读取页面和标签归属，而非永久缓存旧 refs。
