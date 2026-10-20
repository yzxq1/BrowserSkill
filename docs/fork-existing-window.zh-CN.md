# 本地定制版：现有窗口与显式恢复

这是 `yzxq1/BrowserSkill` 的 `feat/existing-window-resume` 分支。保留上游 MIT 许可证；默认独立 Agent Window 行为不变。

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

### 停止任务

```sh
bsk session stop SESSION_ID
```

现有窗口模式释放会话、调试连接和控制遮罩，保留窗口和页面，不批量关闭任务页，更不会关闭你的其他标签页。任务结束后可自行关闭不需要的页面。

## Interrupt：暂停，不销毁页面

点页面上的 Interrupt 后：

- 浏览器本地立即暂停并取消该会话正在执行的操作，不以 daemon 通知成功为前提。
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

开发时先用完整路径调用构建产物，**不要直接覆盖正在运行的 `~/.local/bin/bsk` 或重启其他任务使用的 daemon**。替换正式使用版本前，应结束现有任务并确认扩展安装和连接实例。定制 daemon 应设置 `BSK_AUTO_UPDATE=off`，避免官方自动更新覆盖定制功能；手动 `bsk update` 也会安装上游版本，不用于更新本分支。

## 回归检查重点

1. 新任务后台追加末尾，用户活动页、原窗口和已有会话均不受影响。
2. 未授权的原有页面不能被默认目标、显式 tab ID、关闭、选择、截图或弹出页路径接管。
3. 借用确认、原地归还、启动取消、发送失败、断连及停止均不误删用户窗口。
4. 连续动作不会消费掉暂停；旧操作清理、恢复失败和再次中断不会被自动重试绕过。
5. 默认独立窗口模式保持回归兼容。
