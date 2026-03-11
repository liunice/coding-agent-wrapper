# coding-agent-wrapper

一个面向开发者的、可组合的 coding agent wrapper：把 Codex / Claude Code 这类编程代理包装成统一的后台任务执行单元，并提供一致的运行时产物、进度汇报、查询与中断控制能力。

它既可以：
- 被 **OpenClaw skill** 调用，作为聊天中的后台 coding 执行层
- 也可以被开发者 **直接通过 CLI** 调用，用在本地脚本、自动化流程或自定义编排器中

当前版本重点做好：
- detached 后台运行
- 统一 artifact 输出（`run.log` / `result.json` / `status.json`）
- 运行中 progress 通知
- active run 查询
- graceful stop / cancel

## 适用场景

适合以下场景：
- 你希望把长时间运行的 coding 任务放到后台执行，而不是一直占住当前终端/会话
- 你希望运行过程中有可观察的进度，而不是只在最后看结果
- 你希望任务结束后有结构化结果文件，而不是只靠控制台滚动日志
- 你希望可以查询当前有哪些 run 在执行，必要时中途优雅停止
- 你在做 OpenClaw 集成，希望 skill、wrapper 和文档一起版本管理

不适合的场景：
- 只做一两行特别简单的本地改动
- 不需要后台运行、不需要结果落盘、不需要通知的短命令
- 你已经有一套更高层、协议化的任务调度/执行系统，并不需要这个中间层

## 核心能力

- 统一 CLI 参数：`agent`、`cwd`、`task`、`label`
- 支持 `--detach` 后台运行
- 支持 `codex` 适配
- 支持 `claude` 适配骨架
- 自动写入运行产物：
  - `run.log`
  - `result.json`
  - `status.json`
  - `agent-summary.txt`（若底层 agent 显式输出/写入）
  - `agent-report.json`（若底层 agent 按约定写出结构化报告）
- 支持可选的运行中进度通知：
  - cadence 由 wrapper 自己控制
  - 可通过 `--progress-start-after-seconds` 与 `--progress-every-seconds` 控制
- 支持 active run 查询：
  - `runs`
  - `show --run-id <id>`
- 支持 graceful cancellation：
  - `stop --run-id <id>`
  - 最终状态为 `cancelled`，而不是误记为 `failed`
- 默认支持按 `agent + cwd` 复用最近一次 session id
- 默认对同一项目目录启用 single-flight（同一 `cwd` 同时只允许一个活跃 run）

## 运行流程图

```mermaid
flowchart TD
    A[OpenClaw 主会话 / 用户请求] --> B[coding-assistant skill]
    B --> C{是否适合用 wrapper?}
    C -->|是| D[组装任务 / 选择通知策略]
    C -->|否| Z[改走直接手改或其他路径]

    D --> E[node dist/cli.js run ... --detach]
    E --> F[创建 run 目录与 RunContext]
    F --> G[写入初始 result.json / status.json]
    G --> H{是否 detached?}
    H -->|是| I[启动 internal-run 后台子进程]
    H -->|否| J[当前进程直接执行]

    I --> K[wrapper runner]
    J --> K[wrapper runner]

    K --> L[adapter 组装 Codex / Claude 命令]
    L --> M[启动 coding agent 子进程]
    M --> N[流式写 run.log]
    N --> O[提取 sessionId / 更新 status.json]
    O --> P[monitor 按 wrapper 时钟决定是否发 progress]
    P --> Q[reporter 发送运行中通知]

    M --> R[agent 完成 / 失败 / cancelled]
    R --> S[生成 agent-summary.txt / agent-report.json]
    S --> T[写最终 result.json / status.json]
    T --> U[reporter 发送 completion 或 cancelled 通知]
    U --> V[用户查看 Telegram / 当前会话]

    A --> X[查询当前运行情况]
    X --> X1[node dist/cli.js runs]
    X --> X2[node dist/cli.js show --run-id <id>]
    X1 --> X3[查看活跃 run 摘要]
    X2 --> X4[查看 status.json / result.json]

    A --> Y[中途停止任务]
    Y --> Y1[node dist/cli.js stop --run-id <id>]
    Y1 --> Y2[wrapper 优雅停止 child]
    Y2 --> Y3[最终状态落为 cancelled]

    T --> W[后续排查读取 artifacts]
    W --> W1[run.log]
    W --> W2[result.json]
    W --> W3[status.json]
    W --> W4[agent-summary.txt]
    W --> W5[agent-report.json]
```

## 在 OpenClaw 中启用 repo 内置 skill

开始前，先在仓库根目录执行：

```bash
pnpm install
pnpm build
```

本仓库内置了一个与 wrapper 同步维护的 `coding-assistant` skill，目录位于：

```text
skills/coding-assistant/
```

如果你希望 OpenClaw 直接从这个仓库加载该 skill，需要在 `openclaw.json` 中加入额外的 skill 加载目录：

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "/path/to/coding-agent-wrapper/skills"
      ]
    }
  }
}
```

同时，通常还需要在 `openclaw.json -> skills.entries.coding-assistant.env` 中配置这个 skill 运行所需的环境变量。常见用途包括：

- coding agent 自身需要的环境变量（例如 Codex / Claude Code 所需配置）
- wrapper 的通知目标配置（例如默认通知 channel / target / account）

一个通用示意如下：

```json
{
  "skills": {
    "entries": {
      "coding-assistant": {
        "env": {
          "SOME_AGENT_ENV": "value",
          "ANOTHER_AGENT_ENV": "value",
          "NOTIFY_CHANNEL": "telegram",
          "NOTIFY_TARGET": "<chat-or-user-id>",
          "NOTIFY_ACCOUNT_ID": "default"
        }
      }
    },
    "load": {
      "extraDirs": [
        "/path/to/coding-agent-wrapper/skills"
      ]
    }
  }
}
```

这样做的好处是：skill 调用约定、路径、文档和 wrapper 实现可以一起做版本管理，避免 skill 文档和 wrapper 能力逐渐漂移。

注意事项：
- `skills.load.extraDirs` 的优先级较低；如果你本地已经有同名 `coding-assistant` skill，repo 内这份不会自动覆盖旧版本
- 因此迁移时，最好先移走、停用或重命名旧的同名 skill，再启用本仓库内置版本
- 启用后可用 `openclaw skills list` 检查 `coding-assistant` 是否来自 `openclaw-extra`
- 本仓库内 skill 的命令示例默认假设你在 **wrapper repo root** 下执行，因此推荐使用：

```bash
node dist/cli.js ...
```

而不是把绝对路径硬编码到每条命令里。

## 使用方式

这个项目有两种主要使用方式：

### 方式 A：通过 OpenClaw skill 使用

如果你在 OpenClaw 中启用了 repo 内置 `coding-assistant` skill，那么上层 agent 可以直接通过 skill 来：
- 启动后台 coding 任务
- 决定是否开启 progress notifications
- 查询活跃 run
- 中途停止任务
- 在任务被中断后检查 git 工作区并询问用户是否保留改动

这种方式适合：
- 聊天驱动的任务执行
- 希望复用 skill 中已定义好的策略（progress cadence、stop 后 git 检查等）

### 方式 B：直接通过 CLI 使用

如果你不通过 OpenClaw skill，也可以直接调用 wrapper CLI。

#### 常见命令

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

长任务启用 wrapper 控制的运行中汇报：

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/repo \
  --task "Implement the feature, run validation, and fix follow-up issues if needed." \
  --label feature-work \
  --progress-start-after-seconds 120 \
  --progress-every-seconds 180 \
  --detach
```

中途停止一个后台 run：

```bash
node dist/cli.js stop \
  --run-id 20260311093830-stop-probe-v2
```

查看当前活跃 run：

```bash
node dist/cli.js runs
```

查看单个 run 的状态与结果：

```bash
node dist/cli.js show \
  --run-id 20260311093830-stop-probe-v2
```

也支持给底层代理透传额外参数，在 `--` 后面填写：

```bash
node dist/cli.js run \
  --agent codex \
  --cwd /path/to/repo \
  --task "Add a small README section." \
  -- --model gpt-5-codex
```

### CLI 参考

#### `run` 相关参数

- `--agent <codex|claude>`：选择底层代理
- `--cwd <path>`：任务工作目录
- `--task <text>`：要执行的任务描述
- `--label <text>`：可选标签，用于 runId 可读性
- `--detach`：后台运行
- `--progress-start-after-seconds <n>`：首条运行中汇报最早在启动后多少秒允许发送
- `--progress-every-seconds <n>`：运行中汇报的固定节奏间隔（由 wrapper 自己控制）
- `--output-root <path>`：结果输出根目录，默认是当前命令目录下的 `runs`
- `-- ...`：透传给底层代理命令的额外参数

#### 子命令

- `run`：启动一个新的 wrapper 任务
- `stop --run-id <id>`：请求优雅停止一个后台 run，成功时最终状态会落成 `cancelled`
- `runs`：列出当前活跃 run 的简要信息
- `show --run-id <id>`：查看某个 run 的 `status.json` / `result.json` 摘要

## 结果文件与运行状态

默认输出到：

```text
runs/<runId>/run.log
runs/<runId>/result.json
runs/<runId>/status.json
runs/<runId>/agent-summary.txt
runs/<runId>/agent-report.json
```

### `result.json`

`result.json` 是任务结束后的权威结果文件，至少包含：

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

此外，运行中的 ownership / control 相关字段包括：

- `pid`：wrapper 进程 pid
- `childPid`：底层 Codex / Claude 子进程 pid
- `claimedAt`
- `terminationReason`
- `stopRequestedAt`
- `stopRequestedBy`

### `status.json`

`status.json` 是运行中状态快照，主要用于：
- progress 通知
- 活跃 run 查询
- 判断任务当前阶段

常见字段包括：
- `phase`
- `summary`
- `updatedAt`
- `sessionId`
- `reporting.lastReportAt`
- `reporting.reportCount`

### 其它产物

- `run.log`：完整原始执行日志
- `agent-summary.txt`：agent 留下的人类可读总结（如有）
- `agent-report.json`：agent 留下的结构化报告（如有）

## 运行行为与默认策略

### Stop / cancel 语义

当前 wrapper 已支持通过 `stop --run-id <id>` 请求中途停止后台 run。

停止流程的目标是：
- 优先优雅停止正在运行的 wrapper / coding agent 进程
- 保留 `run.log` / `result.json` / `status.json` 等产物
- 最终状态记为 `cancelled`，而不是 `failed`
- 向用户发送“后台任务已停止”通知

如果被打断的项目是 git 仓库，是否保留工作区中已产生的改动应由上层调用方/用户明确决定；wrapper 本身不会擅自清理用户代码改动。

### Progress 策略建议

wrapper 提供 progress 能力，但**默认策略建议由上层 skill / 调用方决定**，而不是让 wrapper 对所有任务一视同仁地强制开启。

推荐做法：
- **短任务 / 明显边界清晰的任务**：不传 progress 参数
- **时长不确定但通常不长的任务**：默认仍不开，除非用户明确要求
- **明确长任务**：再传
  - `--progress-start-after-seconds 120`
  - `--progress-every-seconds 180`

这样可以避免把通知通道变成噪音，同时保留长任务的过程可见性。

## 二次开发指南

如果你想在这个项目上继续开发，建议先从下面这些入口理解结构：

- `src/cli.ts`：CLI 入口与子命令解析
- `src/runner.ts`：run 生命周期主流程
- `src/monitor.ts`：progress cadence 与最近活动提炼
- `src/reporter.ts`：通知发送
- `src/status.ts`：`status.json` 读写
- `src/stop.ts`：graceful cancellation
- `src/query.ts`：`runs` / `show` 查询能力
- `src/adapters.ts`：Codex / Claude 的命令适配层
- `skills/coding-assistant/`：与 wrapper 同步演进的 OpenClaw skill

建议的开发顺序通常是：
1. 先明确是要改 CLI 行为、运行态、通知策略还是 skill 策略
2. 优先保持 `result.json` / `status.json` 契约稳定
3. 改完后至少执行：

```bash
pnpm type-check
pnpm lint
pnpm build
```

## 设计说明

- 保持为普通 CLI，不做服务化
- 不引入数据库，不引入队列系统
- 不做 UI
- 结果细节以文件为准，通知只负责“唤醒”
- 适配层与运行层分开，便于后续增加更多 agent

## 当前限制

- 第一版没有实现任务队列、重试策略
- 当前默认不支持同一个 `cwd` 的并行 run；若 future 需要并行，应结合 git worktree（不同工作目录）单独设计，而不是绕过 single-flight
- 第一版没有统一抽象所有代理的结构化输出协议
- `Claude Code` 目前重点是命令拼装与运行骨架，深度适配仍待继续补充
- 后台任务由当前机器本地进程负责，不包含守护进程恢复能力
- Webchat / Control UI 场景下，`chat.inject` 已能把完成通知写入目标 session transcript，但当前 UI 不一定会实时显示这条 injected assistant 消息；该遗漏已记录，后续需单独排查 Control UI 的显示/订阅链路

## 本地验证

```bash
pnpm type-check
pnpm lint
pnpm build
```

## 后续可扩展方向

- 增加更多 agent 适配器
- 增加结果 JSON 的更强结构化字段
