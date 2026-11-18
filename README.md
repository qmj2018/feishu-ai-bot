# feishu-ai-bot

通过飞书远程使用 Codex 或已安装的 Claude Code。消息接入由飞书官方开源 Node SDK 完成，本项目实现
消息队列、用户白名单、权限确认、会话持久化和 Git worktree 隔离，不再依赖 LarkLink。
运行依赖全部来自公共 npm，版本及完整性摘要见 `package-lock.json`。

## 安装

支持 Linux，以及 Windows 上的 WSL Linux（推荐 Ubuntu/Debian）。将项目下载或克隆到 WSL 中，
进入目录后运行一键部署；Node.js 22.22.2+、npm、Git 会先检查，已有且可用的直接复用，缺失或版本不满足要求才安装。
Linux 支持 systemd 用户服务；WSL 未启用 systemd 或 linger 不可用时自动使用后台进程。
macOS 可使用已构建 CLI 前台运行，一键依赖安装入口目前面向 Linux / WSL。

```bash
git clone https://github.com/qmj2018/feishu-ai-bot.git
cd feishu-ai-bot
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo
```

实现、CLI 和测试使用 TypeScript；首次安装的引导入口使用 Bash，编译输出位于忽略提交的 `dist/`。
`npm run verify` 会先编译并进行生产源码的严格类型检查，再运行编译后的测试。
独立构建和类型检查可使用：

```bash
npm run build
npm run typecheck
```

运行命令使用 `node dist/bin/feishu-ai-bot.js`，也可使用 `./bin/feishu-ai-bot` 启动入口。`bin/feishu-runtime` 保留为 Bash
启动入口，转发到编译后的运行时；systemd 和后台运行均执行编译产物。
部署前按 lockfile 和实际包版本检查依赖；完整时跳过安装，缺失或版本不匹配时才执行
`npm ci --include=dev`。Node.js 安装使用官方发布包并校验 SHA-256；npm 单独缺失时单独补齐。
Git 等系统工具只在缺失时通过 apt 安装，可能需要输入本机 sudo 密码。

CLI 统一使用 `feishu-ai-bot`，可直接通过本地启动入口运行；`npm link` 后可使用
`feishu-ai-bot`。CLI 会自动查找本项目的 runtime 和 `node_modules/.bin/codex-acp`。

默认机器人名称为 `Feishu AI Bot`，默认 slug 为 `feishu-ai-bot`。配置、依赖安装及缓存目录也统一使用
`feishu-ai-bot`；已有机器人 slug 和运行数据保持可用。升级会优先读取新目录，必要时复用旧版环境配置、
发布检查点和受管理工作空间；重新部署或启用 systemd 服务时会先停止并禁用旧服务，避免两个服务重复启动同一个机器人。

```bash
node dist/bin/feishu-ai-bot.js install
~/.local/bin/codex login --device-auth
```

Codex 客户端开源；模型推理仍需要可用的 OpenAI 账号或 API 凭证，不是本地免费模型。

### 本机 Codex 的安装、升级和指定路径

机器人统一使用本机 Codex：优先复用 `~/.local/bin/codex` 或 PATH 中的 Linux 客户端，也可用 `CODEX_PATH`
或 `--codex-path /absolute/path/to/codex` 指定入口。模型列表、登录、部署探测和
ACP 会话均使用这个入口；ACP 只负责协议转换。

已有且可执行的 Codex 直接复用，不查询 npm、不重复安装、不自动升级。缺失时才查询公共 npm
并安装最新稳定版。需要升级时显式运行 `node dist/bin/feishu-ai-bot.js install --update-codex`，
或部署时添加 `--update-codex`。Codex 安装在用户目录，不需要 sudo。
WSL 中不会自动采用 Windows 挂载盘上的 Codex/npm 入口。

```bash
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo \
  --codex-path "$HOME/.local/bin/codex"
```

`deploy` 和 `service install` 将入口路径持久化到该机器的私有服务环境文件，
无需在代码中写死用户目录。迁移到新机器时重新执行部署命令即可；
Codex 安装不包含账号登录，首次仍需完成设备登录及飞书配置。

升级先安装到 `~/.local/share/feishu-ai-bot/codex/` 的独立目录，验证版本后原子切换入口。
原入口保存在同目录下的 `codex.before-ai-bot-*`，原安装目录保留。
下载或校验失败时保持原客户端；首次安装或显式升级失败时会中止该操作并报告错误。
部署在停止现有服务前完成版本和模型检查。代理沿用保存的服务环境配置。

## 飞书配置

一键入口会优先复用本机 ai-bot 的机器人配置和白名单。没有可用配置时询问：
`1) 申请新机器人  2) 使用已有应用  0) 取消`。默认不申请新应用。

选择申请后，调用飞书官方 CLI 发起创建，按终端中的链接在 Windows 浏览器完成确认；
选择已有应用时，复用本机 CLI 的所选应用凭证和用户登录，必要时引导绑定、登录。
CLI 缺失才安装。App Secret 输入不回显，通过 stdin 传递，并只保存到私有配置。
Linux / WSL 可读取官方 CLI 的对应应用加密凭证；不会读取其他应用的用户 token。

向导会配置机器人能力、消息权限、长连接事件及卡片回调，提交发布并核实线上版本。
需要租户管理员审核时会保留申请并停止本次部署，审核通过后重新运行即可继续，不重复创建应用。
应用自身需具有 `application:application:patch`、`application:application:publish` 等管理权限；
缺少权限时会明确报错，不能绕过租户授权。现有运行服务会在这些步骤通过后才停止。
可用 `--feishu-mode create` / `--feishu-mode existing` 明确选择，用 `--feishu-profile <name>` 指定
已有 CLI profile；新建应用使用 `ai-bot-<slug>` 独立 profile，避免覆盖其他应用。

手工配置或无交互部署也可以预先设置下列环境变量。

在飞书开放平台创建企业自建应用，开启机器人能力。事件订阅选择长连接，订阅
`im.message.receive_v1`，授予读取私聊和群聊 @ 消息、以应用身份发送消息所需权限，
同时在「回调配置」中添加 `card.action.trigger`（卡片回传交互），回调方式选择长连接，
发布应用并将机器人添加到对话。消息事件和卡片回调都需要配置。无需公网 webhook。

为显示任务执行动效，还需开通并发布 `im:message.reactions:write_only`（发送、删除消息表情回复）权限。
任务实际开始执行时，机器人在原指令消息下添加飞书 `Typing` 动态表情，完成、失败或取消后移除。
排队中的消息和 `/new`、`/models` 等管理命令不显示执行动效；表情接口失败不会中断任务。

在当前终端安全设置以下环境变量（请勿提交真实值）：

- `FEISHU_APP_ID`：应用 ID。
- `FEISHU_APP_SECRET`：应用 Secret。
- `FEISHU_ALLOWED_USERS`：允许使用机器人的用户 open_id，逗号分隔，必须设置。
- `FEISHU_DOMAIN`：可选，`feishu`（默认）或 `lark`。

```bash
node dist/bin/feishu-ai-bot.js setup --slug my-bot --project /absolute/path/to/git-repo
node dist/bin/feishu-ai-bot.js run --slug my-bot
```

凭证只保存到 `~/.feishu-runtime/bots/<uuid>/feishu-runtime.json`，文件权限 0600。
只处理白名单用户的文本消息；群聊还必须 @ 当前机器人。审批消息在群聊中同样需要 @。
`setup` 不读取 `.env` 文件；凭证来自当前进程环境。修改应用凭证时，先停止机器人，
再运行 `FEISHU_*` 环境变量配置下的 `node dist/bin/feishu-runtime.js bots setup my-bot`。
白名单和监听群可使用下列管理命令，在运行此版本的机器人上按消息热加载，无需重启。

### 用户与群监听管理

任务权限由用户白名单统一控制。将机器人加入群后，白名单用户 @ 它即可派任务，
不需要给每个群单独配置任务权限。用户仍须处于飞书应用的可用范围内。

```bash
# 查看、添加、移除可派任务的用户；可一次传入多个 open_id
./bin/feishu-ai-bot users list --slug my-bot
./bin/feishu-ai-bot users add ou_user_a ou_user_b --slug my-bot
./bin/feishu-ai-bot users remove ou_user_b --slug my-bot

# 仅对明确配置的群保存监听消息
./bin/feishu-ai-bot groups list --slug my-bot
./bin/feishu-ai-bot groups add oc_group_a oc_group_b --slug my-bot
./bin/feishu-ai-bot groups remove oc_group_b --slug my-bot

# 首次群监听需要敏感权限 im:message.group_msg；此命令配置并提交发布
./bin/feishu-ai-bot groups authorize --slug my-bot

# 查看该群最近收到的消息，最多 100 条
./bin/feishu-ai-bot groups messages oc_group_a --limit 20 --slug my-bot
```

`groups authorize` 会向当前机器人应用申请群消息权限，并核实发布版本；如需管理员审核，
审核后重试同一命令即可。也可在飞书开放平台手工开通 `im:message.group_msg` 并发布。
它不自动把机器人加入群；需先在飞书将机器人加入目标群。

监听范围与任务权限独立：未 @ 的普通消息、非白名单用户的消息只作为监听记录，
不会启动 Agent，也不会自动注入模型上下文。监听仅记录用户消息；图片/文件只记类型，不下载附件。
监听记录位于运行目录的 `group-inbox.json`（0600），服务运行时每小时清理过期记录，
保留最近 7 天、每群最多 100 条、
全局最多 500 条；单条正文最多 4000 字符，截断会标记 `truncated`。
不允许移除最后一个白名单用户；移除用户后拒绝其新任务和仍在排队的任务，已开始的任务可继续完成。

## 会话和权限

默认每个用户、对话和线程有独立会话与 detached Git worktree。worktree 从项目已提交的
HEAD 创建，不包括原目录未提交的修改。会话 ID 和消息去重记录持久化，重启后下一条
新消息恢复会话；中断任务不会自动重放。

Codex 默认使用 `read-only` 模式，需要越过其沙箱权限边界时，飞书收到权限确认消息：

```text
/approve <一次性令牌>
/deny <一次性令牌>
```

仅原发起人在相同对话中的答复有效，300 秒未答复自动拒绝，不提供永久授权。
只读检查可能不触发审批。不会把飞书消息直接作为 Shell 命令执行。

也可在停止机器人后，用 `configure` 为该机器人设置工作目录和 Codex 权限：

```bash
node dist/bin/feishu-ai-bot.js configure --slug my-bot --project /absolute/path/to/project \
  --workspace-mode project-directory --codex-mode agent-full-access
```

`project-directory` 直接使用指定目录，支持非 Git 项目，会话共享该目录并修改其中的文件。
`agent-full-access` 对应 Codex Full Access（`danger-full-access`、`approval_policy=never`），
新建和恢复的 Codex 会话都会应用该模式。默认值分别为 `per-session-worktree`、`read-only`。
也可在 `start`、`run` 或 `restart` 时直接用 `--cwd <目录>` 设置并保存工作目录。
`--cwd` 自动选择 `project-directory`，支持带空格的路径（需加引号）。
已有 systemd 服务时，`start/restart/stop` 会管理该服务；`run` 始终以前台方式运行。
修改工作目录或工作空间模式时，会备份旧会话和配置并重建会话绑定，保留消息去重记录及旧 worktree。
目录和模式未改变时，重启会保留会话及其权限选择。

飞书中可随时查询或切换当前会话的 Codex 权限：

```text
/permissions
/permissions read-only
/permissions agent
/permissions full-access
```

`read-only` 为只读，越过沙箱边界时需要审批；`agent` 可修改工作空间，越界或联网时需要审批；
`full-access` 可访问工作空间外文件和网络，无需逐次审批。仅白名单用户可以操作，
设置按用户、对话和线程隔离并持久化，重启后继续有效。切换按任务顺序执行，当前任务不会中途改变权限，
下一条 Codex 任务（包括恢复的会话）应用新权限。Claude 的权限不受影响。
`/new` 开始新会话并恢复机器人默认权限。

- `/help`（或 `help`）：展示全部飞书聊天指令、参数、用途和使用限制；任务执行中也会立即响应。
- `/cancel`：取消当前会话任务；已排队的后续消息仍会执行。
- `/new`：在当前排队任务结束后开始新会话。
- `/sessions`：查看当前用户在本对话、线程中的会话及执行状态。
- `/session <会话编号>`：切换后续消息使用的会话，不中断其他会话的任务。
- `/usage`：查询 Codex 账号共享额度（包括服务端提供的周额度、重置时间）和当前会话上下文占比。
  可在任务执行中查询，无需排队，也不会发起模型推理或创建新会话。上下文按最近一次模型调用的
  token 数与窗口容量计算，显示快照时间，不使用会话累计 token 消耗。无可用数据时明确显示暂不可用，
  不显示虚构的 0%；当前仅支持 Codex。群聊仍需 @ 机器人。
- 当前会话有任务运行或排队时，再发普通任务消息会收到选择卡片，新消息暂不执行：
  可以选择“排队等待”“新会话并行处理”或“取消这条消息”。卡片仅原发起人在原聊天中可操作，
  10 分钟有效；无法发送卡片时提供 `/task <令牌> queue|parallel|discard` 文本选择。
  重启后未选择的卡片失效，需要重新发送任务，不会自动执行。
- 选择并行会新建独立上下文，继承原会话的模型和权限设置，原任务继续执行；后续消息切到新会话。
  用 `/sessions` 和 `/session` 可以返回原会话。worktree 模式为新会话创建独立 worktree；
  `project-directory` 模式下多个会话共享项目文件，应避免同时修改同一文件。
- 每会话最多 3 条运行中/排队消息，全局最多 4 个活跃队列；每个对话、线程最多保留 3 条待选择消息。
- 单次任务执行上限为 2 小时（不含排队和会话初始化），执行期间每 5 分钟回复一次“任务仍在执行”；
  完成、失败、取消或超时后停止提醒，提醒发送失败不会终止任务。达到上限会明确提示超时，
  保留会话 ID 和已有文件修改；在同一对话、同一线程发送“继续”可恢复该会话，无需 `/new`。
- 模型最终回复使用飞书富文本 `post` 的 `md` 标签渲染 Markdown，支持标题、
  列表、加粗、链接、代码块及表格。长回复按字节预算和行边界分段，跨段代码块自动闭合并续接。
  管理命令和权限确认仍使用纯文本。暂不支持图片、附件、流式卡片回复。
- worktree 保留用于检查修改，暂不自动删除；Git worktree 不是容器，也不隔离用户凭证。

## 拉取仓库和创建工作空间

可在命令行单独创建工作空间，无需启动机器人：

```bash
# 从远端仓库创建；--branch 可省略，默认使用远端默认分支
node dist/bin/feishu-ai-bot.js workspace create \
  --name my-project --repo git@github.com:your-org/your-project.git --branch main

# 从空 Git 仓库开始，自动创建初始提交，供会话 worktree 使用
node dist/bin/feishu-ai-bot.js workspace create --name scratch --empty
```

默认目录为 `~/.feishu-runtime/workspaces/<name>/`，其中 `repo/` 存放代码，
`workspace.json` 记录来源和分支（0600）。可用 `--workspace-root /absolute/path` 修改根目录。
支持无嵌入式凭证的 HTTPS、SSH URL 和 `git@host:namespace/repo.git` 地址；
私有仓库需事先配置 Git credential helper 或 SSH agent，避免在 URL 中放 Token。
不会替用户创建远端仓库。

Linux 上也可以把拉取和部署合成一条命令：

```bash
./deploy.sh --slug project-bot \
  --repo git@github.com:your-org/your-project.git \
  --workspace my-project --branch main --model auto

# 复用此前创建的工作空间
./deploy.sh --slug scratch-bot --workspace scratch --model auto
```

同名工作空间重试会核对来源及指定分支，复用现有目录，保留本地修改；
不会自动 pull、切分支、reset 或覆盖未知目录。拉取失败只清理本次临时目录。
空远端仓库尚无 HEAD 时，请先提交代码，或用 `--empty` 创建本地工作空间。
不同机器人项目可使用不同 `--slug`；修改项目目录或工作空间模式会备份旧会话并重建绑定。
工作空间不是容器，运行用户的账号和系统资源仍会共享。

当前不提供飞书卡片中的工作空间创建或切换；默认在所选仓库下按会话隔离 worktree。

## 在飞书切换模型

发送以下命令获取模型选择卡片（群聊中需要 @ 机器人）：

```text
/models
/models codex
/models claude
```

`/models` 分别查询两种引擎；某一种没有安装或无法读取时，仍显示另一种的卡片。
卡片下拉框显示运行时返回的模型名称，选择后按当前会话的任务顺序切换，
完成时机器人发送确认。选择只影响当前用户、对话和线程，保存后重启仍生效。
只有发起人能点击原对话中的卡片，卡片 10 分钟有效，成功提交选择后不能重放。
旧任务会先完成；切换失败保留原模型设置。

Codex 从已登录 CLI 的 `model/list` 获取列表；恢复会话后仍通过 ACP
`session/set_config_option` 应用选中的模型，避免仅改环境变量却继续使用旧模型。
Claude 从本机 `claude` CLI 的流式控制初始化响应读取模型，再用 `set_model` 控制请求切换。
两边均不硬编码模型名称。

Codex 卡片将 `supportedReasoningEfforts` 展开为“模型 / 推理强度”组合，例如：

```text
GPT-… / Low
GPT-… / Medium（默认）
GPT-… / High
GPT-… / Extra high
```

`Extra high` 对应协议值 `xhigh`；“默认”标记来自每个模型的
`defaultReasoningEffort`，不统一假定为 Medium。若运行时还提供 `max`、`ultra`
等档位，也按实际支持项显示；缺少强度信息时仅提供模型选项，不自行补齐。
选择组合后先设置模型，再通过 ACP 的 `reasoning_effort` 配置设置强度；
两者都成功才保存并确认，失败保留原设置。重启或恢复会话时重新应用两者。
Claude 仍使用其 CLI 返回的模型选项，不套用 Codex 的强度档位。

列表代表当前客户端提供的模型选项，实际推理是否可用仍取决于
账号权限、余额、配额和网络；选择确认不表示已经完成推理验证。

Claude 需要另外安装并登录 Claude Code CLI，确保服务进程 PATH 中能找到 `claude`。
本项目不自动安装、复制或重新许可 Claude Code，也不新增 Claude SDK npm 依赖；
Claude Code 本身遵循 Anthropic 的使用条款，不能把它当作本项目的开源组件。
Claude 使用 default 权限模式，不启用绕过权限；需要授权的工具操作沿用飞书一次性审批。
Codex 与 Claude 共用该会话的 worktree，各自保存独立的对话 ID；切换回原引擎时恢复
它之前的会话，不自动将两种引擎的历史上下文相互搬运。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、
[Claude Agent 控制能力](https://code.claude.com/docs/en/agent-sdk/typescript)。

## 部署和运维

Linux 一键部署保留模型发现、连通性探测及可选的 systemd 用户服务。

```bash
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo --model auto
# 直接使用现有目录（无需 Git），并设置机器人默认 Codex 权限：
./deploy.sh --slug my-bot --cwd /absolute/path/to/project --codex-mode agent-full-access
# 已配置的机器人启动或重启时指定工作目录：
./bin/feishu-ai-bot start --slug my-bot --cwd /absolute/path/to/project
./bin/feishu-ai-bot restart --slug my-bot --cwd /absolute/path/to/project
# 前台运行（先停止已有后台实例）：
./bin/feishu-ai-bot run --slug my-bot --cwd /absolute/path/to/project
# 不使用 systemd，仅使用后台 daemon：
./deploy.sh --slug my-bot --project /absolute/path/to/git-repo --service manual
node dist/bin/feishu-ai-bot.js status --slug my-bot
node dist/bin/feishu-ai-bot.js stop --slug my-bot
node dist/bin/feishu-ai-bot.js doctor --slug my-bot
node dist/bin/feishu-ai-bot.js verify --slug my-bot --json
```

全新目录可直接运行 `./deploy.sh`，无需预先运行 `npm ci`；脚本先补齐缺失的 Node.js/npm/Git，
再检查 lockfile 对应的依赖并按需安装，完成构建、测试、模型检查和飞书配置。
重复部署会复用工具、依赖、Codex 登录及机器人配置。WSL 关闭、`wsl --shutdown` 或电脑休眠时
机器人会离线；后台进程模式不会自动启动 WSL 本身。
不访问内部包源。
`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 可按网络需要设置，模型和代理配置保存到
`~/.config/feishu-ai-bot/<slug>.proxy.env`（0600），支持 `--proxy-mode direct` 清除代理。
`CODEX_PATH` 同样保存到该文件。后台运行日志位于 runtime 的 `logs/feishu-runtime.log`；
systemd 启动及升级日志使用 `journalctl --user -u feishu-ai-bot-<slug>.service` 查看。

## 通用代码审查 skill

审查主流程由本项目的 [.agents/skills/code-review/SKILL.md](.agents/skills/code-review/SKILL.md)
维护，支持本地未提交改动、指定提交或分支比较，以及 PR/MR 输入。它先确定目标仓库和
准确的变更范围，再读取该仓库的目录指令、模块配置、CI、相关调用链及测试，根据实际
契约判断回归；不会把机器人的默认业务仓库或某一种语言框架当作通用前提。

Codebase 的 URL 和 `tmp-merge` 处理放在独立适配说明中；原 `codebase-mr-review`
入口复用这份通用流程。其他平台使用当前环境可用的只读集成或 Git 信息取得基线和候选
版本；无法读取时说明缺失信息。`mr prepare` 自动取远端引用目前仅支持 Codebase，
该功能需要目标仓库的 SSH 读取权限，不安装私有 npm 包。

```bash
# 修改项目中的 skill 后，同步到这台机器，供不同仓库的会话使用
node dist/bin/feishu-ai-bot.js skill install
```

安装和部署也会执行同步，将通用 skill、Codebase 入口及引用资源一起更新到
`~/.agents/skills/`。仓库中的文件是维护来源；`verify` 会检查安装副本是否与项目一致。
已有的非本项目管理的同名 skill 会被保留并报告冲突。

可以向机器人发送“review 当前仓库未提交的改动”“审查这个提交范围”或附带 MR 链接。
默认在当前对话返回有文件位置、触发条件和影响的发现，并说明审查范围及验证限制；
发布评论、修改代码等操作遵循用户另行给出的任务授权。

## 依赖与许可证

| 直接依赖 | 固定版本 | 许可证 | 源码 |
| --- | --- | --- | --- |
| @larksuiteoapi/node-sdk | 1.76.0 | MIT | https://github.com/larksuite/node-sdk |
| @agentclientprotocol/sdk | 1.3.0 | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| @agentclientprotocol/codex-acp | 1.6.2 | Apache-2.0 | https://github.com/agentclientprotocol/codex-acp |

包括间接依赖和各平台可选包的清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

```bash
npm run audit:licenses
npm audit --registry=https://registry.npmjs.org/
```

许可证检查拒绝非公共 npm 源、缺少完整性摘要或未审查的许可证，并纳入 `npm run verify`。
本项目保持原有私有项目配置；第三方软件遵循各自许可证。

切换前先停止旧 LarkLink 服务，避免同一应用的多个长连接竞争事件。
原 LarkLink runtime 数据不会自动迁移，请重新配置凭证和白名单。历史设计文档已更新为
当前桥接架构，不再作为内部依赖的安装指南。
