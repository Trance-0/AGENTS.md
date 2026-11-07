# AI platform design (v0)

This folder describes a personal, self-hosted AI platform. QQ, WeChat, Telegram and Claude Code sessions share context through PCP. An autonomous agent can rewrite its own stack, while git history, the last-known-good image and rollback stay outside its control. The v0 stack is AstrBot, OpenClaw, PCP and Claude Code. The folder holds documents and check-script stubs only. Nothing here has been installed or run.

| File | Purpose |
|---|---|
| `design.md` | Architecture and security design: zones, rules the agent can't break, Jenkins split, deploy flow, PCP context sync, Claude Code in the OpenClaw container, the dashboard, threats |
| `build-plan.md` | Tasks 1-11, each with Objective, Guidance, Check and Demo |
| `agent-comparison.md` | dsh, Claude Code, Codex, OpenClaw, AstrBot and Dify compared: unique capabilities, interchangeable layers, irreducible essentials |
| `checks/lib.sh` | Shared helpers sourced by every check: pass/fail, a default curl timeout, the disruptive-check guard |
| `checks/01-host.sh` ... `checks/11-dashboard.sh` | One check per task. Each exits non-zero on failure. Lines marked `TODO: adjust` depend on choices not yet made |
| `checks/run-all.sh` | Runs checks 01 to NN in order (`run-all.sh 04`) and stops at the first failure |

Run the checks on your own platform host only. Checks 05 and 10 restart services and push test commits, so they need `CONFIRM_DISRUPTIVE=yes`.
