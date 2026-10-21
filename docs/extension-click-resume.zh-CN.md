# BrowserSkill-2：页面和扩展弹窗里点“继续执行”

分支：`feat/extension-click-resume`，基于完整定制分支 `feat/existing-window-resume`。名称为 **BrowserSkill-2**，使用蓝色图标及蓝色控制按钮，便于与官方橙色版本区分；这是独立本地定制版，不是 Chrome Web Store 官方更新。

## 怎么用

1. 使用配套的本分支 CLI/daemon 和扩展，协议 **1.6**。保留原有独立窗口模式及 `--window current` 后台追加模式。
2. 在任务页面点 **Interrupt** 后，原页面不销毁，页面角落出现非阻塞的“任务已暂停”提示。你仍可手动操作页面。
3. 点提示上的 **“继续执行”**。按钮在确认期间禁用；只有扩展和 daemon 都确认恢复成功，才重新显示控制遮罩。
4. 也可以点 Chrome 工具栏的 **BrowserSkill-2 蓝色图标**，在“已暂停的任务”中找到原会话并点 **“继续执行”**。隐藏了页面控制提示、或页面不支持注入内容脚本时，用这个入口。
5. 终端里的 `bsk session resume SESSION_ID` 仍然可用。

**这里恢复的是浏览器原会话的控制权限，不会自动重放已取消的操作，也不能自动唤醒已经结束的 AI 对话。若 Agent 已停在等待用户输入，请回到原对话说“继续”。** 扩展不能代替 Pi/Claude 的对话调度器。

## 恢复链路与安全边界

- 页面和 popup 的按钮仅响应真实用户点击，拒绝脚本生成的 `.click()`。
- 页面只能恢复当前顶层、已经授权控制的任务标签页；未借用的用户页、其他窗口、子 iframe 和其他扩展不能借此恢复任务。
- popup 必须是本扩展自己的 `popup.html`，不能由普通网页冒充。它可列出并恢复本实例的暂停任务。
- 同一会话重复点击会合并为一个恢复请求。
- 扩展通过原连接发送 `session.resume`，daemon 校验浏览器身份和会话归属，再与扩展确认。不会新建会话、切换 Profile、刷新页面或重放旧输入。
- WebSocket 读取循环不会在等待同一连接的确认时阻塞；新的 Interrupt 优先于旧恢复。
- 断连、超时、busy 或失败均有明确提示，保持暂停。不能仅因为点击了按钮就假装成功。
- UI 请求失败时，扩展会让本地重新保持暂停并通知 daemon，阻止迟到的旧确认解除暂停。
- 会话若已经失效，不会自动重建；不提供跨浏览器、daemon 或 Service Worker 重启的恢复。

## 安装与并存

```sh
pnpm install --frozen-lockfile
cargo build --release --locked
pnpm ext:build:zip
```

- CLI：`target/release/bsk`；推荐通过 `scripts/bsk-fork.sh` 调用，关闭官方自动更新，防止覆盖定制功能。
- 扩展目录：`apps/extension/dist/chrome-mv3/`。
- 在 `chrome://extensions` 中打开开发者模式，选择“加载已解压的扩展程序”，选上述目录。ZIP 需要先解压，不能当作 Chrome Web Store 已签名更新安装。
- 本分支未嵌入官方商店签名密钥；以不同扩展 ID 安装时，可与商店版并存。改名字和图标只是视觉区分，扩展 ID 才决定是否为同一个扩展；不要给它添加官方 `key` 来伪装更新。
- 并存时，两者有独立扩展设置和浏览器实例 ID，但同一个 Chrome Profile 的网站登录态仍共享。建议先停用官方版（不卸载），或用 `bsk browsers --json` 确认实例并显式指定 `--browser`，避免控制错任务或两套扩展操作同一页面。
- **只加载新扩展不够，还要配套更新 daemon。** 旧 daemon 不支持页面发起恢复时，界面会提示更新并保持暂停。
- 切换前先结束已有任务。开发验证不会自动覆盖 `~/.local/bin/bsk`、重启共享 daemon 或替换已安装的 Chrome 扩展。

## 验证与隐私

新增单测覆盖双端确认、请求去重、来源/标签授权、超时与断连、旧版本拒绝、失效会话、UI busy、迟到 Interrupt 确认、脚本点击拒绝及非阻塞暂停提示。

Rust 集成测试覆盖页面发起恢复的真实 WS/IPC 链路，含同一连接不死锁、跨浏览器拒绝、恢复期间再次中断保持暂停。

浏览器 UI 测试在全新临时 Profile 中运行 Chrome for Testing，验证原生可信鼠标点击可恢复、脚本 `.click()` 被拒绝、双端确认前保持暂停、popup 恢复和 busy 错误。其 daemon 对端由受控测试替身模拟；它不是在用户已安装扩展或真实业务页面上做的测试。

测试浏览器强制使用模拟钥匙串，关闭同步及后台网络，不请求用户现有钥匙串或网站账号凭据：

```sh
BSK_RESUME_UI_CHROME="/path/to/chrome-for-testing" \
  pnpm --filter @browser-skill/extension exec vitest run \
  src/content/__tests__/resume-ui.browser.test.ts
```

没有为 BrowserSkill-2 新增 Chrome 权限；沿用上游 bsk 的扩展权限。源码与测试之外的个人资料不是此功能的开发输入。
