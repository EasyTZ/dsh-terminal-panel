# dsh-terminal-panel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在侧边栏提供一个**终端面板**（命令控制台）。

在当前工作区敲命令、看实时输出、多标签页、Ctrl+C 中断运行中的命令、Tab 补全文件路径与 PATH 上的命令名、查看每条命令的退出码、一键「在系统终端中打开」。

## 前置要求

- dsh `>= 0.1.1-rc.2`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-host-webserver ^0.1.1-rc.2`、`@deepseek-ai/dsh-workspace ^0.1.1-rc.2`、`@deepseek-ai/dsh-shell ^0.1.1-rc.2`）

## 安装

「装进去」和「打开它」是两件事，缺一不可：

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-terminal-panel#v0.1.1
```

> **必须写 GitHub 地址，不能只写包名。** `dsh plugin add` 会把参数原样转给 pnpm，只写 `dsh-terminal-panel` 会去 npm registry 找同名包 —— 那可能是别人的包（`dsh-git` 在 npm 上就已被他人占用）。换个 tag 就是换版本；想跟最新可以用 `#main`，但**不建议**：钉 tag 才能复现。

## 激活

往 patch 层文件（`$DSH_HOME/profiles/<name>/cordis.patch.yml` 或机器级 `$DSH_HOME/cordis.patch.yml`）里加一条 `- insert:` 条目：

```yaml
- insert:
    - id: dsh-terminal-panel
      name: 'dsh-terminal-panel'
```

> **`id` 别用通用词**（比如 `terminal-panel`）。`- insert:` 不去重：一旦与 dsh 自带 bundle 里某条条目同名，cordis loader 会抛 `duplicate loader entry id`，**内核直接退出**。dsh 自带的 id 里有大量 `git` / `session` / `settings` / `storage` 这类通用词，而且内核会自行更新到新版本 —— 撞车只是时间问题。直接拿包名当 id 最省事。

重启 dsh 后，侧边栏底部会出现终端按钮，点它打开面板。

## 已知限制

- **它不是 PTY，是命令控制台**。跑不了全屏交互程序：`vim`、`sudo` 密码输入、`npm init` 问答这类需要终端接管屏幕的程序都无法使用——面板里明说了这一点，并提供「在系统终端中打开」作为替代。要做满血终端，正确路线是宿主侧接 node-pty，而不是往这个面板里塞。
- **每条命令是独立进程**，`cd` 不会跨命令保留（面板自己跟踪并展示当前目录）。
- Windows 上命令通过 `pwsh -NoLogo -NoProfile -NonInteractive` 执行；macOS 上是 `bash -c`（不读 rc 文件）——这是 dsh 内核按平台选择的执行器，不是插件的行为。

## 平台支持

目前只在 Windows 上验证过；插件对 macOS 做了登录 shell 探测兜底（GUI 启动的进程 PATH 会塌陷），未做完整验证，欢迎反馈。
