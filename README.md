# dsh-terminal-panel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在侧边栏提供一个**终端面板**（命令控制台）。

在当前工作区敲命令、看实时输出、多标签页、Ctrl+C 中断运行中的命令、Tab 补全文件路径与 PATH 上的命令名、查看每条命令的退出码、一键「在系统终端中打开」。

## 前置要求

- dsh `>= 0.1.1-rc.2`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-host-webserver ^0.1.1-rc.2`、`@deepseek-ai/dsh-workspace ^0.1.1-rc.2`、`@deepseek-ai/dsh-shell ^0.1.1-rc.2`）
- `pnpm` 可用（`dsh plugin` 底层转发给 pnpm）

## 安装

一条命令装完：

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-terminal-panel#v0.2.1
```

`<name>` 换成你的 profile 名（桌面版通常为 `web`，TUI 为 `tui`）。插件自带 `dsh.bundle` 层（`cordis.patch.yml`），`dsh plugin add` 会同时完成「装进去」和「注册激活」，**不需要再手写 patch**。

> 命令里的 `#v0.2.1` 是版本 tag，钉 tag 才能复现；想追最新可以改成 `#main`，但不建议。`dsh plugin` 底层转发给 pnpm，所以机器上要有可用的 `pnpm`。

重启 dsh 后，侧边栏底部会出现终端按钮。

## 使用

点侧边栏底部的终端按钮打开终端面板：在当前工作区敲命令、看实时输出、多标签页、Ctrl+C 中断运行中的命令、Tab 补全文件路径与 PATH 上的命令名、查看每条命令的退出码、一键「在系统终端中打开」。

## 卸载

一条命令卸载：

```sh
dsh plugin --profile <name> remove @easytz/dsh-terminal-panel
```

`<name>` 与安装时一致。`remove` 会把包从 profile 依赖里移除，`dsh` 随后会把它从激活清单（`dsh.profile.bundles`）里撤掉。

> 如果你按旧版 README 手动往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml` 里加过 `- insert:` 条目，卸载时把那段 YAML 一起删掉。

重启 dsh 后，侧边栏里的终端按钮消失。

## 已知限制

- **它不是 PTY，是命令控制台**。跑不了全屏交互程序：`vim`、`sudo` 密码输入、`npm init` 问答这类需要终端接管屏幕的程序都无法使用——面板里明说了这一点，并提供「在系统终端中打开」作为替代。要做满血终端，正确路线是宿主侧接 node-pty，而不是往这个面板里塞。
- **每条命令是独立进程**，`cd` 不会跨命令保留（面板自己跟踪并展示当前目录）。
- Windows 上命令通过 `pwsh -NoLogo -NoProfile -NonInteractive` 执行；macOS 上是 `bash -c`（不读 rc 文件）——这是 dsh 内核按平台选择的执行器，不是插件的行为。

## 平台支持

目前只在 Windows 上验证过；插件对 macOS 做了登录 shell 探测兜底（GUI 启动的进程 PATH 会塌陷），未做完整验证，欢迎反馈。
