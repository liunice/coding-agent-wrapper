# coding-agent-wrapper

一个尽量小、可运行、可扩展的通用 coding agent wrapper。第一版目标不是做服务平台，而是提供一个统一 CLI，把不同编程代理包装成一致的“后台任务执行单元”，统一处理：

- 启动参数
- 后台运行
- 日志落盘
- 结果 JSON 落盘
- 完成通知

当前第一版优先把 `Codex` 支持做好，同时给 `Claude Code` 留出清晰适配位。

## 为什么它服务于“模式 B”

这里将“模式 B”具体化为一种简单工作模式：

- 人或上层脚本发起一次编码任务
- 任务在后台持续运行，不要求人一直盯着终端
- 任务过程写日志，结果写结构化 JSON
- 完成后只通过轻量通知唤醒人
- 细节查看走日志和结果文件，而不是把通知通道塞满

这个仓库的第一版正是围绕这组需求设计：通知通道与结果通道分离，适合作为更大自动化流程中的一个基础执行块。

## 当前能力

- 支持统一 CLI 参数：`agent`、`cwd`、`task`、`label`
- 支持 `--detach` 后台运行
- 支持 `codex` 适配
  - `CODEX_API_KEY` 从运行环境或 `openclaw.json -> skills.entries.coding-assistant.env` 读取
  - 默认附加 `--dangerously-bypass-approvals-and-sandbox`
- 支持 `claude` 适配骨架
  - 已实现命令拼装
  - 已实现运行、日志、结果落盘流程
  - 第一版主要定位为结构预留与本机命令接入点
- 自动写入：
  - `run.log`
  - `result.json`
  - `agent-summary.txt`（若底层 agent 显式输出/写入）
- 任务结束后自动通知：
  - 外部聊天渠道优先走 `openclaw message send`
  - session / webchat 场景回退到 `chat.inject`
  - 默认通知路由可从 `openclaw.json -> skills.entries.coding-assistant.env` 中的 `NOTIFY_*` 环境变量读取
- 完成通知与 `result.json` 会尽量包含：
  - 开始时间 / 完成时间 / 耗时(分钟)
  - 任务总结
  - 验证摘要
  - session id / resume 来源 / commit id
  - 修改文件清单
  - 备注
  - 状态码
- wrapper 现在会要求 agent 额外写出 `agent-report.json`，优先从结构化字段读取：
  - `taskSummary`
  - `modifiedFiles`（兼容字段）
  - `projectModifiedFiles`
  - `artifactFiles`
  - `validation`
  - `validationSummary`
  - `notes`
  - `commitId`
- 用户通知里的 `【修改文件】` 默认只展示项目改动；wrapper 产物（如 `agent-summary.txt` / `agent-report.json`）会单独归类到 `artifactFiles`
- 默认会按 `agent + cwd` 记录并复用最近一次 session id；只有显式传 `--new-session` 时才禁用 resume

## 安装

```bash
pnpm install
pnpm build
```

也可以直接在仓库内通过 `pnpm exec` 运行编译后的 CLI。

## 用法

先编译：

```bash
pnpm build
```

前台运行一个 Codex 任务：

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/repo \
  --task "Inspect the repository and summarize the next refactor step." \
  --label demo
```

后台运行：

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/repo \
  --task "Fix the failing test and explain the root cause." \
  --label fix-tests \
  --detach
```

也支持给底层代理透传额外参数，在 `--` 后面填写：

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/repo \
  --task "Add a small README section." \
  -- --model gpt-5-codex
```

## 参数说明

- `--agent <codex|claude>`：选择底层代理
- `--cwd <path>`：任务工作目录
- `--task <text>`：要执行的任务描述
- `--label <text>`：可选标签，用于 runId 可读性
- `--detach`：后台运行
- `--output-root <path>`：结果输出根目录，默认是当前命令目录下的 `runs`
- `-- ...`：透传给底层代理命令的额外参数

## 结果文件位置

默认输出到：

```text
runs/<runId>/run.log
runs/<runId>/result.json
```

其中 `result.json` 至少包含：

- `runId`
- `agent`
- `cwd`
- `taskSummary`
- `startedAt`
- `finishedAt`
- `exitCode`
- `status`
- `logPath`
- `summary`

## 设计说明

- 保持为普通 CLI，不做服务化
- 不引入数据库，不引入队列系统
- 不做 UI
- 结果细节以文件为准，通知只负责“唤醒”
- 适配层与运行层分开，便于后续增加更多 agent

## 当前限制

- 第一版没有实现任务队列、并发控制、重试策略
- 第一版没有统一抽象所有代理的结构化输出协议
- `Claude Code` 目前重点是命令拼装与运行骨架，深度适配仍待继续补充
- 后台任务由当前机器本地进程负责，不包含守护进程恢复能力
- Webchat / Control UI 场景下，`chat.inject` 已能把完成通知写入目标 session transcript，但当前 UI 不一定会实时显示这条 injected assistant 消息；该遗漏已记录，后续需单独排查 Control UI 的显示/订阅链路

## 本地验证

```bash
pnpm type-check
pnpm lint
```

## 后续可扩展方向

- 增加更多 agent 适配器
- 增加结果 JSON 的更强结构化字段
- 增加任务列表与最近运行查询

