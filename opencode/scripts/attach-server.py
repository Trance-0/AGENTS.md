"""Attach the local OpenCode terminal UI to the shared coding server."""
from __future__ import annotations

import os
from pathlib import Path


def main() -> None:
    root = Path.home() / "Documents/DockerVolumes/openclaw-opencode"
    try:
        values = dict(
            line.split("=", 1)
            for line in (root / "server.env").read_text().splitlines()
            if line.strip() and not line.startswith("#")
        )
        environment = {**os.environ, **values}
        binary = root / "runtime/package/bin/opencode"
        os.execve(binary, [str(binary), "attach", "http://127.0.0.1:4096"], environment)
    except (OSError, ValueError) as error:
        raise SystemExit(
            "Terminal UI cannot connect: opencode-server/client launch — "
            f"private server configuration or binary is unavailable ({type(error).__name__})."
        ) from None


if __name__ == "__main__":
    main()
