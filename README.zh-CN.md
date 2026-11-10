<div align="center">

<img src="public/icon.svg" width="96" alt="Office Crew 标志">

# Office Crew（오피스 크루）

**把你已经在用的 AI CLI 组成一个团队，在实时的等距视角办公室里看着它们干活。**

[English](README.md) · [한국어](README.ko.md) · 简体中文 · [日本語](README.ja.md)

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#-常见问题)

</div>

<p align="center">
  <img src="docs/screens/demo.gif" alt="Office Crew 演示：在船员小镇里，AI 团队从家里出发去公司工作、等待审批，完成后回家" width="900">
</p>

Office Crew 是一个在本地同时运行多个 AI 智能体的工作台。它直接调用你**已安装并登录的官方 CLI**（Claude Code、OpenAI Codex CLI、Gemini CLI、Nous Hermes Agent）以及任何 ACP 智能体，也支持 OpenAI 兼容 API 和本地模型。把智能体按阶段编排好之后，你可以看着每个智能体在办公室里走动，并随时介入。

## 💡 为什么选择 Office Crew

- **直接用你现有的订阅。** Office Crew 在你的电脑上以现有登录状态启动官方 CLI，不会索要或保存你的密码。
- **不只是一个聊天框，而是一个团队。** 每个智能体都有自己的模型、推理强度（effort）、权限、技能和 MCP 连接器。阶段按顺序执行，同一阶段内的智能体并行工作，使用自动路由时，审查环节会尽量交给与构建者不同的 AI 交叉检查。
- **每一步都看得见、改得了。** 智能体住在船员小镇里：空闲时待在家里，开始工作时去公司上班，并根据所用工具走到图书馆、瞭望塔、工坊或广场。需要审批时会举手，出错时会冒冷汗。运行中可以随时调整某个智能体的指令或跳过它，也可以在下一阶段前暂停，或停止整个运行。
- **占用资源少。** 零运行时依赖，无需构建，空闲时内存约 65 MB。服务器只监听 `127.0.0.1`。

## ✨ 功能

### 智能体与自动路由

- **按智能体路由：** 为每个智能体分别设置 AI（提供方）、模型、推理强度（与各 CLI 相同的档位：低、中、高、超高、最大，支持的 Codex 模型还有极致）、权限（只读 → 全部允许）、角色指令（系统提示词）、技能、MCP 连接器和头像（人物、原创生物或自己的图片）。
- **与 CLI 一致的模型列表：** Claude 像 Claude Code 一样按版本显示（例如 Opus 5.5、Fable 5.2、Sonnet 5.5、Haiku 5.5）。别名始终指向最新模型，并会记住运行时实际使用的版本。Codex 按 Codex 自己的顺序列出其模型目录中的所有模型，包括上一代。CLI 中设置的默认模型和推理强度会有标记；列表每 30 分钟以及检测到 CLI 更新时自动刷新，自动路由不会选择上一代模型。
- **自动路由（新建智能体的默认选项）：** 运行开始时，从可自动分配的已登录 AI（Claude Code、Codex、OpenAI 兼容 API、本地模型，调研角色还包括 Gemini CLI）中挑选模型和推理强度。依据是角色（调研、整理、分析、构建、审查、写作）和配置档（经济、均衡、最佳）。审查智能体会尽量分配给与构建者不同的 AI。
- **路由面板：** 在一张表里修改所有智能体的 AI、模型、推理强度和权限。

| 智能体编辑器 | AI 账号与登录 |
|---|---|
| ![设置服务商、模型、推理强度、权限、系统提示词、技能和头像的智能体编辑器](docs/screens/app-agent-editor.png) | ![列出各 AI CLI 版本、登录状态和支持的推理强度的设置页面](docs/screens/app-accounts.png) |
| 为每个智能体设置服务商、模型、推理强度、权限、技能和头像 | 每个 CLI 的版本、登录状态和支持的推理强度 |

### 团队、审批与实时介入

- **流水线：** 阶段按顺序执行，同一阶段的智能体并行工作，每个阶段的输出会自动交给下一阶段。
- **审批关卡：** 可以让某个阶段等待你的确认。你可以批准，也可以提出修改意见，系统会带着你的反馈重新运行该阶段。
- **错误关卡：** 智能体出错时，可选择重试、跳过或停止。
- **运行中介入：** 向正在运行的智能体发送指令（Claude 会直接注入到运行中的进程），把消息排到下一轮，暂停与恢复，停止，或只跳过某一个智能体。
- **实时用量：** 按消息、智能体、会话统计 token（流式输出时为估算值，回合结束后换成实际值），CLI 提供时显示费用，以及账号额度（Claude 5 小时与每周百分比、Codex 每周百分比）。
- **待处理：** 侧边栏顶部汇总需要你处理的会话（审批、出错后的决定、已暂停、失败，以及还没打开的结果），点一下就能直接进入。结果和失败打开后就会移出列表；审批、决定和暂停会一直保留到处理为止。
- **基于证据的审查：** 审查智能体会被要求只根据自己确认过的证据（文件、命令与测试输出）作出判定，并单独列出没能确认的项目。如果由做出结果的同一个 AI 来审查，会标明这比交叉验证弱。

| 团队编辑器 | 审批关卡 |
|---|---|
| ![带编号阶段、负责智能体和每阶段审批开关的团队编辑器](docs/screens/app-team-editor.png) | ![带有批准、要求修改、停止按钮的审批卡片，办公室里的角色正在等待审批](docs/screens/app-approval.png) |
| 阶段、负责智能体、阶段指令和审批开关 | 批准并继续 / 要求修改 / 在此停止 |

### 不中断，连接更多

- **自动接力：** 某个 AI 在任务中途达到用量上限时，由仍有余量的其他 AI 以相同角色接手，从中断处继续完成。它会收到原始请求、到目前为止写好的全部内容，以及服务器从工具记录中提取的交接单（用过的工具、改动过的文件、最后的命令；命令只保留程序名、常见子命令和普通文件名，容易带有令牌、密码的其他参数会被去掉），并被要求先检查当前状态。达到上限的 CLI（Claude Code、Codex、Gemini CLI、Hermes）会休息到用量数据中的重置时间；没有该数据时，以错误信息里写明的时间为准（都没有时休息 30 分钟）。正在休息或用量超过阈值（默认 95%）的 AI 会在运行前提前避开。可以在路由面板中关闭、修改阈值，或立即解除某个 AI 的休息状态。
- **按 AI 选择计费方式：** Claude Code 和 Codex 可以使用你的订阅，也可以使用官方 API 密钥（按用量计费）。在订阅模式下会忽略电脑上的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`（Claude）和 `CODEX_API_KEY` 环境变量，避免意外计费。API 密钥模式下若未在应用中填写密钥，则原样使用电脑环境变量中的密钥或网关令牌。
- **多个 ChatGPT 账号：** 在 设置 → AI 账号 中添加更多 ChatGPT 账号。每个账号使用单独的 Codex 文件夹登录，作为拥有独立用量上限的 AI 运行；一个账号达到上限时，自动接力会转到下一个账号。
- **ACP 智能体：** 直接接入支持 [Agent Client Protocol](https://agentclientprotocol.com) 的智能体，例如 Gemini CLI、Hermes、OpenCode、Goose、Qwen Code。工具权限请求会按智能体的权限级别自动回复。智能体请 Office Crew 代为读写的文件仅限工作文件夹内（读取也可访问附件文件夹）；智能体自带的工具遵循其自身的沙箱和你设置的权限级别。

| 带自动接力的路由面板 | 导入 Claude Code 或 Codex 会话 |
|---|---|
| ![路由面板：在一张表中设置每个智能体的 AI、模型、推理强度和权限，并带有自动接力开关](docs/screens/app-routing.png) | ![导入窗口：按项目文件夹分组列出 Claude Code 和 Codex 会话](docs/screens/app-import.png) |
| 每个智能体可选自动或手动，达到上限时自动接力 | 选一段过去的对话继续做 |

### 定时任务

- 到了设定的星期和时间，团队（或单个智能体）会收到相同的指令并自动开始工作，结果可以每次保存为新会话，也可以接着同一个会话。时间按这台电脑的时钟计算，应用开着时运行。
- 应用关着时错过的次数默认跳过；打开相应开关后，会在应用启动时运行一次。上一次运行还没结束时，这一次会跳过。审批步骤会在“待处理”中等你。

| 定时任务 | 技能 |
|---|---|
| ![定时任务页面：工作日 9 点的新闻整理和已关闭的每周博客草稿，各自带有立即运行按钮和开关](docs/screens/app-schedules.png) | ![技能页面：Claude、Codex、共用和应用技能，可按来源筛选](docs/screens/app-skills.png) |
| 星期、时间、团队或智能体、立即运行、开关 | Claude、Codex 和共用技能在一个列表中，可按来源筛选 |

### 实时办公室：船员小镇

- 不用游戏引擎、只用 SVG 绘制的等距小镇。每个智能体都有一栋房子。空闲的智能体待在家里（窗户会亮灯），开始工作时去**公司**上班，完成后回家。根据所用工具，读取去**图书馆**，搜索去**瞭望塔**，运行命令去**工坊**，规划和长时间思考去**广场**喷泉。
- 需要审批时会举手，出错时会冒冷汗，把结果交给下一阶段时会拿着文件走过去，智能体分派任务时会出现子智能体助手。
- **按自己的喜好装饰：** 每个智能体可以是人物、原创生物或自己的图片（小像素画也保持清晰），房子也可以换成自己的图片。图片只保存在你的电脑上。办公室皮肤（现代、温馨、夜景）和用自己的平面图做的皮肤也仍可使用。
- **画质档位：** 为低配电脑提供 `full`、`lite`、`static`。

| 状态一目了然 | 结果交接 |
|---|---|
| ![中文标签的船员小镇：智能体在图书馆读取、在瞭望塔搜索、等待审批、在公司工作](docs/screens/office-lang-zh.png) | ![智能体拿着构建结果走向下一个智能体的特写](docs/screens/office-handoff.png) |
| 读取中、搜索中、使用工具、需要审批 | 智能体拿着结果走向下一阶段 |
| **自己装饰的小镇** | **选择皮肤** |
| ![用帐篷图片当房子、两个智能体换成生物的船员小镇](docs/screens/office-village-custom.png) | ![显示设置：船员小镇、办公室皮肤和装饰小镇](docs/screens/app-skins.png) |
| 帐篷当房子，两个智能体换成生物 | 船员小镇、办公室皮肤和自己的图片 |

### 桌面应用般的体验

- 会话搜索与置顶、粘贴图片（Ctrl+V）、拖放、`@智能体` 提及、`/技能` 命令。
- 带复制按钮的 Markdown、重新发送与编辑、把对话导出为 `.md`、深色模式。
- **技能**会自动从 Claude、Codex 和共用（`~/.agents`）技能文件夹中找到，并按来源分开显示。韩文界面下会用韩文显示说明（只保存在你的电脑上，新装的技能可由你选的智能体翻译）。为智能体选技能时，可以用“按角色推荐”“该 AI 的 CLI 技能”“已选”“全部”几个标签查看，装在多个位置的同一技能只显示一次。**MCP 连接器**按智能体注入。**插件**把智能体、团队、技能、连接器和皮肤打包成一个 JSON 文件，方便导入导出。
- **导入并继续**已有的 Claude Code 和 Codex 会话，不丢失上下文。Claude 以分支（fork）方式继续，原记录保持不变；无法续接的会话会带入最近的对话来保持上下文。
- 界面语言：韩语、英语、简体中文、日语。

| 深色模式 | 输出中的实时用量 |
|---|---|
| ![运行完成后船员小镇的深色模式界面](docs/screens/app-dark.png) | ![正在输出回答的聊天界面，显示估算 token 数和各阶段进度](docs/screens/app-done.png) |
| 带可复制代码块的深色模式 | 输出时估算 token，回合结束后替换为实际数值 |

## 🚀 快速开始

**环境要求：** [Node.js](https://nodejs.org) 20 或更高版本，以及你想用的 AI CLI。只体验演示的话，一个 CLI 都不需要。

```bash
git clone https://github.com/yw8837/office-crew.git
cd office-crew
npm start
```

- 服务器在 `http://127.0.0.1:4317` 启动，并打开 Edge/Chrome 应用窗口；两者都找不到时，会用默认浏览器打开。
- **Windows：** 也可以直接双击 `오피스크루 실행.cmd`（"运行 Office Crew"），或用 `오피스크루 실행 (창 없이).vbs` 在不显示命令行窗口的情况下启动。退出时请用 设置 → 关于 → 退出 Office Crew。
- **首次运行：** 默认选中内置的**演示**团队。演示智能体是模拟的，不消耗任何 AI 额度，可以在接入 AI 之前先体验办公室、审批和介入功能。
- 数据保存在 `~/.office-crew`。

| 选项 | 说明 |
|---|---|
| `--browser` | 用普通浏览器标签页代替应用窗口 |
| `--port <n>` | 服务器端口（默认 `4317`） |
| `--home <dir>` | 数据目录（默认 `~/.office-crew`） |
| `--no-open` | 只启动服务器，不打开窗口 |

选项写在 `--` 之后，例如 `npm start -- --browser --port 5000`。也可以用环境变量 `OFFICE_CREW_PORT`（或 `PORT`）和 `OFFICE_CREW_HOME` 修改默认值。

> `npx office-crew` 即将推出，目前还没有发布到 npm。

## 🤖 支持的 AI

| AI | 连接方式 | 安装 | 登录 |
|---|---|---|---|
| **Claude Code** | 官方 CLI，使用你的订阅或 Anthropic API 密钥 | `npm i -g @anthropic-ai/claude-code` | 设置 → AI 账号 → **登录**（打开终端后输入 `/login`） |
| **OpenAI Codex CLI** | 官方 CLI，使用你的 ChatGPT 账号或 OpenAI API 密钥 | Codex CLI | `codex login` |
| **Gemini CLI** | 官方 CLI + Gemini API 密钥 | `npm i -g @google/gemini-cli` | 设置 → API 密钥·本地模型 → Gemini CLI 密钥 |
| **Nous Hermes Agent** | 官方 CLI | Hermes Agent | `hermes model` |
| **ACP 智能体** | Agent Client Protocol（stdio） | Gemini CLI、Hermes、OpenCode、Goose、Qwen Code 等 | 设置 → API 密钥·本地模型 → ACP 智能体（预设按钮） |
| **OpenAI 兼容 API** | HTTPS API | 无 | 设置 → API 密钥·本地模型：OpenAI、OpenRouter、Nous Portal、xAI、Gemini API |
| **本地模型** | 本机 HTTP 服务 | Ollama、LM Studio、llama.cpp、vLLM 或 Jan | 无需登录。服务运行时自动检测，其他地址可在设置中添加 |
| **演示** | 内置 | 无 | 无需登录，用量为 0 |

在设置 → **AI 账号**中可以查看每个 CLI 的安装状态、版本、登录账号和支持的推理强度。

## 🧭 工作原理

```mermaid
flowchart LR
  UI["应用窗口<br/>Preact + htm · SVG 办公室"] <-->|"REST + SSE（令牌）"| S["本地服务器<br/>127.0.0.1 · Node.js 内置模块"]
  S <-->|"args / stdin → stdout"| C["官方 CLI<br/>claude · codex · gemini · hermes"]
  S <-->|"ACP (JSON-RPC)"| P["ACP 智能体<br/>gemini --acp · hermes acp · opencode · goose"]
  S <-->|HTTPS| A["OpenAI 兼容 API"]
  S <-->|"localhost HTTP"| L["本地模型<br/>Ollama · LM Studio · llama.cpp · vLLM · Jan"]
  S --- D[("~/.office-crew<br/>JSON 文件")]
```

1. 你向某个智能体或团队发送消息。
2. 编排器依次推进各阶段。每个智能体都是一个 CLI 进程或一次 API 调用，带着自己的模型、推理强度、权限、技能和连接器。
3. 流式输出通过 Server-Sent Events（SSE）变成聊天消息、工具块、用量数据和办公室动画。
4. 对于支持续接的 CLI（Claude Code、Codex），会保存每个智能体的会话 ID，下一轮接着同一段对话继续；其他 CLI 则把最近的对话加入提示词来保持上下文。

详细设计和服务商适配器约定见 [docs/DESIGN.md](docs/DESIGN.md)（韩文）。

## ⚖️ 对比

下表比较的是常见的工具类型，而不是具体产品。每类都有很多优秀的工具，请按自己的工作方式选择。

| | **Office Crew** | 单一 CLI 的图形界面 | 可视化工作流编排工具 | 多模型聊天界面 |
|---|---|---|---|---|
| 运行已登录的官方 CLI | ✅ | 仅一个 CLI | 多用 API 密钥 | 多用 API 密钥 |
| 一次运行中混用多家 AI | ✅ | 通常只有一家 | 经常支持 | 因工具而异 |
| 分阶段团队 + 并行智能体 | ✅ | 少见 | 核心能力 | 少见 |
| 审批关卡与运行中调整 | ✅ | 因工具而异 | 因工具而异 | 有限 |
| 按智能体设置模型、推理强度、权限 | ✅ | 按会话 | 按节点 | 按对话 |
| 实时查看每个智能体在做什么 | ✅ 动画办公室 | 终端或日志视图 | 节点图 | 聊天记录 |
| 本地模型 | ✅ | 因工具而异 | 经常支持 | 经常支持 |
| 运行时依赖 | 0 | 因工具而异 | 因工具而异 | 因工具而异 |

## 📜 账号使用原则

Office Crew 的设计目标是在各服务商的规则范围内使用。简而言之：

- **只用未经修改的官方工具。** Office Crew 只是把你安装的 CLI 作为独立进程启动，和你在终端里手动运行一样。它不会修改或冒充这些 CLI。
- **登录信息留在 CLI 里。** Office Crew 从不读取、复制、保存或转发 CLI 的登录令牌（例如 `~/.claude/.credentials.json`、`~/.codex/auth.json`）。从 `~/.claude.json` 中只使用 MCP 服务器列表。登录始终在终端窗口里通过各厂商的 CLI 完成（Office Crew 可以帮你打开终端）。
- **一人一机。** 订阅登录仅供你本人在自己的电脑上使用。不要通过 Office Crew 共享账号，也不要把它作为服务提供给他人。
- **产品、团队和无人值守运行请用 API 密钥。** 如果你要为他人构建产品、在公司中使用或无人值守运行，请把 Claude Code 和 Codex 的计费方式切换为 **API 密钥**（设置 → AI 账号 → 计费方式）。Anthropic 要求第三方产品在未获批准时不得提供 claude.ai 登录或订阅额度，OpenAI 也建议以编程方式使用 Codex 时采用 API 密钥。
- **Google：** Gemini CLI 的个人 Google 登录（Gemini Code Assist for individuals）已无法使用，因此 Office Crew 使用 Gemini API 密钥。Antigravity 的个人账号条款不允许通过第三方工具使用，因此不予支持。
- **Hermes：** 如果把 Hermes 的服务商设为 Anthropic，Hermes 可能会复用 Claude Code 的登录令牌。请改为给 Hermes 配置 Anthropic API 密钥或其他服务商。
- Office Crew 与 Anthropic、OpenAI、Google、Nous Research 没有任何关联。

条款可能会变化，本摘要也不构成法律建议。使用前请查看各服务商的最新条款。

## 🔒 安全与隐私

- **仅限本机。** 服务器只绑定 `127.0.0.1`，拒绝 `Host` 或 `Origin` 不是应用本身的请求（防止 DNS 重绑定和跨站调用），并且每个 API 调用都需要按安装生成的令牌。
- **安全渲染。** 智能体的输出先转义再渲染为 Markdown，回复中的 HTML 和脚本不会被执行。
- **不经手密码。** 登录状态由各 CLI 自己管理。API 密钥只保存在数据目录（`settings.json`）中，界面上只显示最后 4 位。连接器和 ACP 设置中名称看起来像机密的值（token、key、secret、password 等）也会同样遮盖。
- **无遥测。** 服务器对外的请求只会发往你配置的 API 地址和本机的本地模型服务。各 CLI 照常与各自的服务通信。
- **注意权限。** "全部允许"，以及 Gemini CLI 和 ACP 智能体的"自动判断"，会让智能体不经确认就执行命令，请只在可信的文件夹中使用。

发现漏洞？请参阅 [SECURITY.md](SECURITY.md)。

## ❓ 常见问题

**这样用符合 AI 服务商的条款吗？**
Office Crew 不会替你登录、代理你的账号或共享凭据。它只是在你自己的电脑上启动你已安装并登录的官方 CLI，和你在终端里手动运行一样。遵守各服务的条款（包括关于自动化或第三方工具的规定）仍是你自己的责任。用于组织或商业场景时，更推荐使用 API 密钥。Office Crew 遵守的原则见[账号使用原则](#-账号使用原则)。Office Crew 与 Anthropic、OpenAI、Google、Nous Research 没有任何关联。

**要花多少钱？**
Office Crew 本身依据 AGPL 免费使用。用量由各服务商从你的订阅或 API 密钥中扣除，和你直接使用其 CLI 完全一样。用量面板会实时显示 token 和账号额度；把路由配置档设为**经济**会选择更便宜的模型；演示服务商不产生任何费用。

**可以离线或只用本地模型吗？**
可以。Ollama、LM Studio、llama.cpp、vLLM 和 Jan 运行时会被自动检测。界面所用的 Preact 和 htm 也已随仓库附带，不会从 CDN 加载任何内容。

**需要安装所有 CLI 吗？**
不需要，装你需要的就行。自动路由只会考虑你已登录的 AI。

**支持哪些操作系统？**
Office Crew 在 Windows 上开发，CI 会在 Windows、Linux 和 macOS（Node.js 20 与 22）上运行测试。应用窗口使用 Edge 或 Chrome，找不到时改用默认浏览器。

## 🗺️ 路线图

- [ ] 发布到 npm，支持 `npx office-crew`
- [ ] 支持更多服务商
- [ ] 团队模板库
- [ ] 移动端配套应用

欢迎在 [Issues](https://github.com/yw8837/office-crew/issues) 中提出想法和投票。

## 🤝 参与贡献

欢迎提交缺陷报告、服务商适配器、皮肤和翻译。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。测试使用模拟 CLI，所以 `npm test` 不会消耗任何 AI 额度。

```bash
npm test
```

请遵守[行为准则](CODE_OF_CONDUCT.md)。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 📄 许可证

Office Crew 采用**双重许可**：

- [GNU AGPL-3.0-only](LICENSE)：个人使用、学习、研究、内部工具，以及遵守 AGPL 的开源项目（免费）。
- **商业许可**：闭源产品、不公开修改源码的托管服务，或其他需要不同条款的场景。详见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

随附的第三方代码（Preact：MIT；htm：Apache-2.0）列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 中。各产品名称均为其各自所有者的商标。

## ⭐ Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=yw8837/office-crew&type=Date)](https://star-history.com/#yw8837/office-crew&Date)
