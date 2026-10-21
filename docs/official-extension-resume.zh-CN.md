# 保留官方扩展：Interrupt 后显式继续

分支：`feat/interrupt-resume-official-extension`。

本分支从上游 `e8777ab` 独立开发，不依赖现有窗口定制分支；**`apps/extension/`、扩展协议版本及 Chrome 扩展代码均不修改**。只需要配套更新本机 bsk CLI 和运行中的 daemon，Chrome Web Store 官方扩展保留。

## 两个需求分别需要改哪里

| 需求 | 是否必须改扩展 | 源码依据 |
|---|---|---|
| 在正在使用的窗口末尾追加标签页，不新建窗口 | **必须改扩展** | 官方 `tools/tabs.ts` 的创建目标固定为 `ctx.agentWindowId`；borrow 通过 `moveTabForBorrow` 移入 Agent Window。这个需求不在本分支实现。 |
| Interrupt 后持续暂停，用户明确恢复后继续原会话 | **不必须，只改 bsk/daemon 基本可实现** | 官方扩展把 `session.user_interrupt` 事件发给 daemon；上游 `daemon/ipc.rs` 的 `try_consume` 只拦一次。本分支改为持续暂停，并增加纯 daemon 端恢复。 |

现有窗口追加和浏览器本地独立暂停见另一分支：
[feat/existing-window-resume](https://github.com/yzxq1/BrowserSkill/tree/feat/existing-window-resume)。该分支需要配套定制扩展，不能把其 CLI/扩展与本分支混用。

## 使用

先使用本分支构建 CLI/daemon，**保留官方 Chrome 扩展**。以下命令中的 `bsk` 指本分支构建的程序，不是尚未更新的旧程序。

```sh
bsk session list --json
# 用户点击 Interrupt 后，原会话显示 paused: true。

# 只有用户明确要求继续时才执行：
bsk session resume SESSION_ID --json

# 恢复后重新读取页面，再决定下一步；不自动重放被打断的点击。
bsk observe --session SESSION_ID
```

典型恢复结果：

```json
{
  "session_id": "SESSION_ID",
  "resumed": true,
  "was_paused": true
}
```

再次执行恢复具有幂等性，`was_paused` 为 false。不存在的会话返回 `not_found`，不会重新创建。

### 实际恢复链路

1. 官方扩展点击 Interrupt 后发送原有 `session.user_interrupt` 通知。
2. daemon 先记录持续暂停，再取消该会话的在途请求。
3. 后续控制类调用在 daemon 被拦截，连续调用不会消费掉暂停。拒绝的调用不会发给扩展。
4. `session resume` 检查会话与队列，确认旧请求清理完成后，通过中断代次 CAS 解除暂停。**不发送任何新扩展 RPC**，不要求 `tool.session_resume` 或扩展协议 1.5。
5. 下一个正常控制类工具调用到达官方扩展时，其原有 `onBrowserControlResumed` 路径恢复遮罩，继续操作同一页面。

因此：`resume` 返回后遮罩不一定立刻变化；下一次 `observe` 或控制调用才会恢复官方扩展的控制外观。这不需要刷新页面。

## 安全边界与限制

- 必须先获得用户明确继续的指令，不能自动执行 resume 绕过停止。
- 旧请求仍在取消清理时返回 `session_busy`；清理超时或失败后返回 `resume_cleanup_unconfirmed`，保持暂停，不自动重建页面或重放动作。
- 被中断的操作可能已经产生部分效果；恢复后先查看页面，不能直接重复提交。
- 暂停时允许状态读取（session list、tab list、console 等）和 session stop。官方 snapshot 可能重新发送已有 hover，因此本分支也会拒绝暂停期间的 snapshot。
- 依赖 Interrupt 通知送达 daemon。断连导致通知丢失时，不能保证浏览器侧独立暂停；这是与定制扩展方案的主要差别。
- 不持久化暂停和会话，不提供跨 daemon、浏览器或 Service Worker 重启的恢复。暂停期间仍可能触发原有空闲清理；会话失效后不能声称同会话恢复。
- 已验证官方扩展协议 **1.3/1.4**。其他未验证版本会拒绝 daemon-only 恢复，避免对具有独立本地暂停的新扩展（如定制协议 1.5）误报恢复成功。
- 仍然使用官方 Agent Window；本分支没有 `--window current`，不解决窗口末尾追加需求。

## 构建与切换

```sh
cargo test --workspace --locked
cargo build --release --locked
```

产物：`target/release/bsk`。仓库内 `scripts/bsk-fork.sh` 可用于调用此构建并关闭自动更新。

**只运行新 CLI 不等于已经更新 daemon。** 旧 daemon 仍运行时，CLI 会说明需要在现有任务结束后切换 daemon；不需要为此更换官方扩展。不要用 `session stop --all` 或强制重启去中断别人的任务。

定制构建应使用 `BSK_AUTO_UPDATE=off`，不要运行会安装上游版本的 `bsk update`。开发与测试不会替换现有 `~/.local/bin/bsk`、重启共享 daemon 或安装扩展。

## 验证

集成测试覆盖：

- 官方扩展协议 1.3/1.4，恢复时没有任何新 RPC 发往浏览器。
- 连续多次输入被拒绝；普通状态读取不消费暂停。
- 恢复后仍是同一 session/window，只转发用户后续发起的新操作，不重放旧输入。
- 幂等恢复、再次中断、清理 busy、补偿超时后拒绝恢复、会话不存在、旧 daemon 的友好提示。
- 定制扩展协议 1.5 不会被 daemon-only 分支误报恢复。

以上兼容验证使用可计数的模拟扩展端和真实 daemon/IPC；并非已经替换或实测用户当前安装的 Chrome 扩展。

### 本轮结果（2026-10-21）

- Interrupt/恢复集成测试：原 6 项 → 11 项，全部通过；覆盖官方协议 1.3/1.4 和不适配定制协议 1.5 的明确拒绝。
- Rust 全工作区：865 通过、0 失败、1 忽略（原上游 864 通过；原一次性标记测试已替换为持续暂停/代次测试）。
- 官方扩展原样回归：2675 通过、0 失败、244 跳过。没有修改扩展源码或重建/安装扩展。
- `pnpm lint` 通过，含 DSH plugin 的 538 项测试；第三方依赖的 source map 缺失提示不影响结果。
- `cargo build --release --locked` 通过。现有安装的 bsk、运行中的共享 daemon 和 Chrome 扩展均未替换。
