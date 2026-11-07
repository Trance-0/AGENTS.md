# Agent comparison: dsh, Claude Code, Codex, OpenClaw, AstrBot, Dify

As of 2026-11-03. "Out of the box" means without installing plugins. A claim marked (unverified) wasn't confirmed from a source during this research. A claim marked (third-party) comes from an unofficial guide rather than the project's own docs.

**Assumption:** "dsh" means DeepSeek Harness (`@deepseek-ai/dsh`), the open-source agent harness DeepSeek released in August 2026. If you meant something else, this column needs redoing.

## What each tool is

**dsh (DeepSeek Harness).** dsh is an MIT-licensed agent harness from DeepSeek, built on an "everything is a plugin" design using the Cordis framework. It's a developer preview, and the README warns of breaking changes. It runs locally as a Web UI on `127.0.0.1:3080`, with a headless mode and a Python SDK (third-party). It ships a full coding agent, and every part can be replaced, including the agent loop itself (third-party). It's built for people who want to own and modify the harness, not just use one.

**Claude Code.** Claude Code is Anthropic's coding agent. It runs in the terminal, IDE extensions, the desktop app and cloud sessions. It edits files and runs shell commands in your repo, with permission prompts and an OS-enforced Bash sandbox. It has the broadest hook system of the six tools. It's built for developers working in a codebase.

**Codex CLI.** Codex CLI is OpenAI's local coding agent, and its CLI is open source under Apache-2.0. Its OS-enforced sandbox is on by default: network access is off, and writes are limited to the workspace. An approval policy controls when it must ask before acting. It's built for the same job as Claude Code, with stricter defaults.

**OpenClaw.** OpenClaw is an MIT-licensed personal assistant that runs as a Gateway daemon on your own machine. It connects to many chat networks and has a Control UI, CLI, TUI and companion apps. Models and agent harnesses (Claude, Codex, local models) are swappable plugins. It's built for one person, or a team, who wants one assistant reachable from every chat app.

**AstrBot.** AstrBot is an open-source Python chatbot platform focused on instant messaging, and it's strongest on Chinese networks. It includes an agent, MCP, skills, a knowledge base, persona settings, an agent sandbox and a WebUI, and it has 1000+ plugins. It's built for individuals and teams putting a bot into IM groups and DMs.

**Dify.** Dify is a self-hosted LLM application platform that runs as a Docker Compose stack (minimum 2 CPU cores and 4 GiB RAM). It has a visual workflow canvas, a RAG pipeline, sandboxed agents, a prompt IDE, LLMOps observability, and an API for every app. Its license is Apache 2.0 with additional conditions. It's built for building and operating LLM apps, not for coding in your repo or chatting in IM.

## Capability matrix (out of the box)

| Dimension | dsh | Claude Code | Codex CLI | OpenClaw | AstrBot | Dify |
|---|---|---|---|---|---|---|
| Where it executes | Your machine (local Web UI server, headless, SDK) | Your machine (also IDE, desktop, cloud sessions) | Your machine (also IDE, app, cloud) | Gateway daemon on your machine or server | Server process (uv, Docker, desktop app) | Multi-container server stack |
| Edits code and runs shell on your filesystem | Yes | Yes | Yes | Yes. Tools run on the host for the main session unless sandboxed | Code and shell in its agent sandbox, not on your repo (unverified detail) | In its own sandbox, not your filesystem |
| Sandbox and permissions | Approval policies. Landlock, Seatbelt or bwrap (third-party). Local RPC has no auth, only a Host-header check (third-party) | Permission prompts. Opt-in OS-enforced Bash sandbox. Hooks can block tool calls | OS sandbox on by default, network off, workspace-write. Approval policy | Sandbox off by default. Docker, Podman or SSH backends. DM pairing. Operator scopes | Agent sandbox for code and shell | Agent runs in a sandbox container behind an auth token |
| Built-in chat channels | None (Web UI) | None | None | Telegram, WhatsApp, Slack, Discord, Google Chat, Signal, iMessage and more. QQ and WeChat need plugins | QQ (official API and OneBot v11), Telegram, WeCom, WeChat Official Accounts, Feishu, DingTalk, Slack, Discord, LINE, Satori, KOOK, Misskey, Mattermost | None (web app and API). IM through plugins (unverified) |
| Session and memory, and who holds it | Append-only event log with resume, fork and replay, stored locally (third-party) | Local session transcripts and resume, plus CLAUDE.md files (storage path unverified) | Local sessions, plus AGENTS.md (details unverified) | State, memory and credentials on your hardware (`~/.openclaw`). Per-channel sessions. Embedding memory search | Per-conversation history, auto context compression, knowledge base | Per-app conversation memory in Dify's database |
| MCP | Unverified | Client. Server mode `claude mcp serve` (unverified) | Client (`codex mcp add`). Server mode (unverified) | `openclaw mcp serve` exposes channel conversations to Claude Code and Codex | Client | Client, and can publish any app as an MCP server |
| Orchestration and multi-agent | Subagents. Claude Code and Codex available as subagent providers, off by default (third-party) | Subagents | Subagents | Multiple agents and sub-agents. External harnesses through ACP (plugin) | Can route to Dify, Coze or Bailian apps | Visual workflow canvas |
| RAG and knowledge base | None built in (unverified) | None. Reads files directly | None. Reads files directly | Embedding-based memory search | Knowledge base | Full RAG pipeline, including PDF and PPT ingestion |
| Model backends | Any provider, OpenAI-compatible or local (third-party) | Anthropic models (other routes unverified) | OpenAI models through a ChatGPT plan or API key (others unverified) | Hosted and local providers | OpenAI-compatible, Anthropic, Gemini, DeepSeek, Ollama, LM Studio and more | Hundreds of providers, OpenAI-compatible |
| Headless and CI mode | `dsh --profile headless "<task>"`, Python SDK (third-party) | `claude -p`, plus a Setup hook event for CI | `codex exec`, plus `codex app-server` (JSON-RPC) | `openclaw agent` CLI and an OpenAI-compatible HTTP endpoint | Unverified | API for every app |
| Self-hosting | Fully local | CLI is local, model is hosted | CLI is local and open source, model is hosted | Fully self-hosted | Fully self-hosted | Self-hosted Community Edition |
| Admin UI | Web UI with trajectory view | None (terminal UI, desktop app) | None | Control UI | WebUI dashboard plus Web ChatUI | Full web studio |
| Extension mechanism | Plugins for every part, including the agent loop | Hooks, MCP, skills, plugins, subagents | Hooks, MCP, plugins | Plugins, skills, ClawHub | Python plugins (1000+) | Marketplace plugins and tools |

## Unique capabilities

Each list holds only things none of the other five can do out of the box.

**dsh**
- Replace any internal part, including the agent loop, tool registry and session log. The others allow extension through hooks, MCP or plugins, but not replacement of the loop.
- Unload a plugin at runtime with its side effects reversed, without a restart (third-party).
- "Code mode": the model writes a TypeScript program that calls tools, instead of making one tool call per round trip (third-party).
- A preset where the model edits its own live plugin composition (third-party).
- Fork and replay a session from an append-only event log, where "model-visible means logged" (third-party).

**Claude Code**
- Hook handlers can be HTTP endpoints, LLM prompts or subagents, not just commands. For example, a Stop hook can POST a turn to PCP with no script at all.
- The same hooks fire in terminal, IDE, desktop and cloud sessions.
- Runs Anthropic models natively.

**Codex CLI**
- The OS sandbox is on by default, with network access off. Claude Code's sandbox is opt-in.
- Hooks are trusted by hash. A new or changed hook is skipped until you review it. Managed hooks from system or `requirements.toml` sources are trusted by policy.
- Per-model-request hook events (`PreModelRequest`, `PostModelRequest`), which weren't in the Claude Code event list I checked.
- `codex app-server`, a long-lived JSON-RPC process you can embed in another program.
- The only open-source CLI of the two vendor coding agents.

**OpenClaw**
- Built-in WhatsApp, Signal and iMessage channels. AstrBot lists WhatsApp as coming soon.
- A DM pairing workflow: unknown senders must be approved with `openclaw pairing approve`.
- Companion apps and device nodes for voice, camera, screen and Canvas on macOS, iOS, Android, Windows and Linux.
- An OpenAI-compatible endpoint where the `model` field picks an agent, not a provider model.
- `openclaw mcp serve`, which lets Claude Code or Codex join live chat-channel conversations.

**AstrBot**
- Personal QQ accounts through OneBot v11 bridges such as NapCat. OpenClaw's QQ plugin uses the official bot API.
- WeChat Official Accounts, DingTalk, KOOK, Misskey and Satori adapters built in.
- Dify, Coze and Alibaba Cloud Bailian apps as chat backends.
- Persona settings and a large built-in catalog of TTS and STT providers (it's unverified how far OpenClaw's voice support overlaps).

**Dify**
- A visual workflow canvas for building multi-step LLM apps.
- A RAG ingestion pipeline with text extraction from PDF, PPT and other documents.
- A prompt IDE with side-by-side model comparison.
- LLMOps: logs, annotations, and integrations with Opik, Langfuse and Arize Phoenix.
- Any app can be published as an MCP server or called through an API.

## Interchangeable layers

| Layer | Who can fill it | What you lose by swapping |
|---|---|---|
| Model backend | OpenClaw, AstrBot, dsh and Dify all accept OpenAI-compatible endpoints | Moving it out of OpenClaw splits model config and spend control across tools. This design keeps it in OpenClaw. |
| Telegram adapter | OpenClaw or AstrBot | Moving to AstrBot loses OpenClaw pairing and puts Telegram sessions outside the executor. |
| QQ adapter | AstrBot (personal account through OneBot, or official API) or OpenClaw's QQ Bot plugin (official bot API) | The OpenClaw plugin can't use a personal account, but it carries less ban risk and has durable inbound handling. |
| WeChat adapter | OpenClaw with Tencent's `openclaw-weixin` plugin (DMs only, pairing gap in 2.4.8), or AstrBot (WeCom, Official Accounts; personal WeChat unverified) | These connect to different WeChat products, so they're not equivalent. Choose by which account type you use. |
| Coding agent on your repo | Claude Code, Codex, dsh | Each has different sandbox defaults, hook semantics and model. All three read AGENTS.md. Claude Code reads CLAUDE.md, and dsh reads both (third-party). |
| PCP sync hooks | Claude Code and Codex share event names (SessionStart, Stop, PreToolUse, PostToolUse, UserPromptSubmit), and dsh bridges the same hook protocol (third-party) | Little. One hook script can serve all three. Codex requires hook trust, and Claude Code can use an HTTP hook instead of a script. |
| Tools via MCP | Any MCP client: Claude Code, Codex, AstrBot, Dify. OpenClaw through its MCP bridge (unverified detail) | Little. MCP is the portable layer. |
| Knowledge and RAG | PCP, AstrBot knowledge base, Dify RAG, OpenClaw memory search | Each extra store becomes a second source of truth. Keep PCP as the source and treat the others as caches. |
| Admin UI | OpenClaw Control UI, AstrBot WebUI, dsh Web UI, Dify studio | None of them should own context. The PCP dashboard does. |
| Multi-step orchestration | Dify workflows, OpenClaw sub-agents, dsh subagents | Dify gives a visual canvas but adds a whole extra stack. |

## Irreducible essentials

These are capabilities the platform can't drop. Most are roles, not specific products.

| Essential | Provided by | Why it can't be dropped |
|---|---|---|
| One source of truth for context | PCP | Without it, each tool keeps its own history (`~/.openclaw`, AstrBot's database, CLI transcripts) and nothing syncs. Two writable sources of truth will conflict. |
| An agent that can edit and commit code in a workspace | Claude Code or Codex. dsh, or OpenClaw driving Codex, also qualify | Self-evolution means the agent changes `agent-stack` and pushes. Any one of these is enough, but you need at least one. |
| One channel gateway per chat network you use | Telegram: OpenClaw. QQ: AstrBot (personal account) or OpenClaw's plugin (bot account). WeChat: one of the two, depending on account type | Each network has its own protocol and login. Nothing else in the stack can reach it. |
| One executor that owns model config and tool policy | OpenClaw (your choice) | Owner-only tool use, the no-tools `relay` agent and spend limits have to be enforced in one place. A second executor would be a second policy to keep in sync, and a second way around it. |
| A root of trust the agent can't change | Forgejo with server-side protection, Jenkins controller config in `platform-infra`, the watchdog, and an off-device backup | This is what makes self-evolution safe. Jenkins itself is replaceable (for example, Forgejo Actions), but an agent-independent deploy path isn't. The watchdog is essential because Jenkins can be down. |
| Secret injection outside git | Jenkins credentials injected as env vars, plus the gitleaks pre-receive hook | History is append-only, so any committed secret is permanent. |

**Not essential:**
- **Dify:** optional (see below).
- **dsh:** optional.
- **AstrBot:** needed only for personal-account QQ, or for the Chinese networks OpenClaw lacks.
- **Claude Code vs Codex:** you need one of them, not both.

## Mapping to this design

| Tool | Role in `design.md` | Notes |
|---|---|---|
| PCP | Context source of truth (platform zone) | Agents append only. The dashboard owns cleanup. |
| OpenClaw | The executor: owns models and tool policy, handles Telegram and WeChat | Its OpenAI-compatible endpoint serves AstrBot through the no-tools `relay` agent. |
| AstrBot | QQ and WeChat adapter only, built-in agent unused | Configured as an OpenAI-compatible client of OpenClaw. No code needed. |
| Claude Code | The coding agent in v0, over SSH and inside the OpenClaw container. Synced to PCP by managed hooks and the PCP MCP server | Its credential comes from a read-only bind of a dedicated host config directory (see `design.md`). |
| Codex | Not in v0 | Can replace or join Claude Code later through the same hook events. |
| dsh | Not in the design. Optional lab harness | Developer preview with breaking changes, and an unauthenticated local RPC surface (third-party). Don't use it as the self-evolving production executor or as the dashboard host. The dashboard borrows its hot-plug idea through the `plugin-manager` registry contract instead (see `design.md`). It could replace Claude Code for local SSH sessions if you want to swap internals. |
| Dify | Not in the design. Optional RAG and workflow backend | Fit: publish a Dify app as an MCP server and give OpenClaw a tool that calls it. Benefit: document-heavy RAG and visual workflows. Cost: a multi-container stack (at least 2 CPU cores and 4 GiB RAM), more to patch, and a second knowledge store that competes with PCP. Add it only when you have documents to ingest that PCP shouldn't hold. |

## Sources

- dsh:
  - [deepseek-ai/deepseek-harness README](https://github.com/deepseek-ai/deepseek-harness)
  - [open-harness.net guide](https://www.open-harness.net/) (third-party, verified against 0.1.0-rc.6)
- Claude Code:
  - [Hooks reference](https://code.claude.com/docs/en/hooks)
  - [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- Codex:
  - [openai/codex README](https://github.com/openai/codex)
  - [Hooks](https://learn.chatgpt.com/docs/hooks)
  - [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- OpenClaw:
  - [README](https://github.com/openclaw/openclaw)
  - [OpenAI chat completions endpoint](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/gateway/openai-http-api.md)
  - [WeChat channel](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/channels/wechat.md)
  - [QQ bot channel](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/channels/qqbot.md)
  - [Sandboxing](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/gateway/sandboxing.md)
  - [ACP agents](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/acp-agents.md)
  - Note: docs.openclaw.ai was unreachable from the research machine, so the docs were read from the GitHub repo.
- AstrBot:
  - [AstrBotDevs/AstrBot README](https://github.com/AstrBotDevs/AstrBot)
  - [docs.astrbot.app](https://docs.astrbot.app/en/)
- Dify:
  - [langgenius/dify README](https://github.com/langgenius/dify)
  - [Publish an app as an MCP server](https://docs.dify.ai/en/guides/application-publishing/publish-mcp)

Content from these sources was paraphrased for compliance with licensing restrictions.
