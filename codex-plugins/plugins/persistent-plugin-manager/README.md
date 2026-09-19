# persistent-plugin-manager

Runs a localhost dashboard and supervises persistent personal-plugin processes. State is stored under `~/.codex/`.

The manager uses Codex `SessionStart` and `SessionEnd` hooks. MCP is only the control surface; the manager starts without an agent calling a tool.

The current implementation discovers Bark, CPA Usage, and Task Queue installations and reports their roots and enabled state. It does not yet launch arbitrary worker commands: add a worker definition only after its lifecycle, restart, and shutdown behavior are specified.
