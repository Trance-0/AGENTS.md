"""Deploy remote checkout, preserving recordings and the previous container."""
from __future__ import annotations

import datetime
import json
import logging
import os
import shlex
from pathlib import Path
import subprocess
import time
import urllib.request


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dashboard-deployment")


def run(*args: str, **kwargs):
    process = subprocess.Popen(args, **kwargs)
    while True:
        try:
            code = process.wait(timeout=20)
            if code:
                raise subprocess.CalledProcessError(code, args)
            return
        except subprocess.TimeoutExpired:
            log.info("Deployment is running: dashboard/process heartbeat — %s operation is still in progress.", args[0])


def healthy(url: str, timeout: int = 60) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return True
        except OSError:
            pass
        log.info("Deployment is waiting: dashboard/health probe — service has not returned HTTP 200 yet.")
        time.sleep(2)
    return False


STATE_VOLUME = "dashboard_dashboard-state"
STORAGE_ROOT = Path("/home/motuariki/Documents/DockerVolumes/agent-dashboard")
DEFAULT_STATE_DIR = str(STORAGE_ROOT / "state")
# Private runtime env (all dashboard config and secrets). Jenkins sets
# DEPLOY_ENV_SOURCE to this path; it must never live in a repo working tree.
DEFAULT_ENV_FILE = str(STORAGE_ROOT / "secrets" / "deploy.env")


def helper(image: str, *mounts: str, script: str) -> str:
    """Run a shell snippet as root in a throwaway container of the new image.

    Storage work goes through containers so it behaves the same whichever
    user the Jenkins agent runs as, and can read the legacy named volume.
    """
    args = ["docker", "run", "--rm", "--user", "0", "--network", "none", "--entrypoint", "sh"]
    for mount in mounts:
        args += ["--mount", mount]
    return subprocess.check_output([*args, image, "-c", script], text=True)


def volume_exists(name: str) -> bool:
    return subprocess.run(["docker", "volume", "inspect", name], capture_output=True).returncode == 0


# Path, owner, mode, size, and SHA-256 of every entry: the copy must match exactly.
MANIFEST = "cd /data && find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r f; do if [ -f \"$f\" ]; then h=\"$(stat -c %s \"$f\") $(sha256sum \"$f\" | cut -d' ' -f1)\"; else h=-; fi; echo \"$(stat -c '%n %u:%g %a' \"$f\") $h\"; done"


def prepare_state(image: str, state_dir: Path) -> None:
    """Move dashboard state from the legacy named volume to the bind directory.

    Runs after the backup, with the previous container stopped. Empty bind
    directory + legacy data: copy with ownership preserved and verify the copy.
    Both with data: the bind directory wins (logged). The legacy volume is never
    removed, so a rollback to an older container still finds its data.
    """
    parent = state_dir.parent
    helper(image, f"type=bind,src={parent},dst=/parent", script=f"mkdir -p /parent/{state_dir.name} && chown 1000:1000 /parent/{state_dir.name} && chmod 700 /parent/{state_dir.name}")
    has_data = "find /data -mindepth 1 -print -quit"
    bind_mount = f"type=bind,src={state_dir},dst=/data"
    bind_has_data = bool(helper(image, bind_mount, script=has_data).strip())
    legacy = volume_exists(STATE_VOLUME)
    legacy_mount = f"type=volume,src={STATE_VOLUME},dst=/data,readonly"
    legacy_has_data = legacy and bool(helper(image, legacy_mount, script=has_data).strip())
    if legacy_has_data and not bind_has_data:
        helper(image, f"type=volume,src={STATE_VOLUME},dst=/from,readonly", f"type=bind,src={state_dir},dst=/to", script="cp -a /from/. /to/")
        source = helper(image, legacy_mount, script=MANIFEST).splitlines()
        copied = helper(image, bind_mount, script=MANIFEST).splitlines()
        if source != copied:
            raise RuntimeError("Deployment stopped: dashboard/state migration — the copy in the bind directory does not match the legacy volume; nothing was started on it.")
        files = sum(1 for line in source if not line.endswith(" -"))
        log.info("State migrated: dashboard/state storage — %d entries (%d files) copied from volume %s to %s with owners, modes, and checksums verified; the volume is kept for rollback.", len(source), files, STATE_VOLUME, state_dir)
    elif legacy_has_data:
        log.info("State kept: dashboard/state storage — %s already has data, so it is used; volume %s also has data and is left untouched for rollback.", state_dir, STATE_VOLUME)
    elif not bind_has_data:
        log.info("State is new: dashboard/state storage — no legacy volume data; %s starts empty.", state_dir)
    if legacy_has_data and not helper(image, bind_mount, script=has_data).strip():
        raise RuntimeError("Deployment stopped: dashboard/state migration — the bind directory is empty while the legacy volume has data.")
    helper(image, bind_mount, script="chown 1000:1000 /data && chmod 700 /data")


def secure_private_storage(image: str, env_file: Path, backups_root: Path) -> None:
    """Keep private files at owner 1000:1000 and modes 700 (dirs) / 600 (env).

    The env file is readable by the host user so `docker compose` and a local
    development instance can use it directly; the metrics key keeps mode 400.
    """
    name = shlex.quote(env_file.name)
    helper(image, f"type=bind,src={env_file.parent},dst=/secrets",
           script=f"chown 1000:1000 /secrets /secrets/{name} && chmod 700 /secrets && chmod 600 /secrets/{name}")
    helper(image, f"type=bind,src={backups_root},dst=/backups", script="chmod 700 /backups")


def main():
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "package.json").read_text())["version"]
    image = os.environ["DASHBOARD_IMAGE"]
    env_file = Path(os.environ.get("DEPLOY_ENV_SOURCE", DEFAULT_ENV_FILE))
    if not env_file.is_file():
        raise RuntimeError("Deployment cannot start: dashboard/private configuration — deployment environment file is absent.")
    if env_file.is_symlink() or root.resolve() in env_file.resolve().parents:
        raise RuntimeError("Deployment cannot start: dashboard/private configuration — the environment file must be a regular file outside the repository checkout.")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backups_root = STORAGE_ROOT / "backups"
    backup_dir = backups_root / stamp
    backup_dir.mkdir(parents=True, mode=0o700)
    candidates = subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"], text=True).splitlines()
    previous = [name for name in candidates if name.startswith("agent-dashboard-v")]
    if len(previous) > 1:
        raise RuntimeError("Deployment cannot start: dashboard/container discovery — multiple active dashboard containers require review.")
    old = previous[0] if previous else None
    old_name = old
    name = f"agent-dashboard-v{version}"
    # Persistent state (recordings, scene layouts, panel state, config-editor
    # backups, activity cursors) lives in a host bind directory. Before 0.2.6
    # it was the named volume STATE_VOLUME, migrated by prepare_state().
    state_dir = Path(os.environ.get("DASHBOARD_STATE_HOST_DIR", DEFAULT_STATE_DIR))
    if not state_dir.is_absolute() or not state_dir.parent.is_dir():
        raise RuntimeError("Deployment cannot start: dashboard/state storage — DASHBOARD_STATE_HOST_DIR must be an absolute path whose parent exists.")
    activity_dir = Path(os.environ.get("OPENCLAW_ACTIVITY_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/openclaw/activity"))
    if not activity_dir.is_dir():
        raise RuntimeError("Deployment cannot start: dashboard/activity mount — shared OpenClaw activity directory is absent.")
    config_dir = Path(os.environ.get("OPENCLAW_CONFIG_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/openclaw/config"))
    if not (config_dir / "openclaw.json").is_file():
        raise RuntimeError("Deployment cannot start: dashboard/config mount — shared OpenClaw config directory has no openclaw.json.")
    adapter_dir = Path(os.environ.get("PCP_ADAPTER_CONFIG_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/pcp/adapters"))
    adapter_args = []
    if (adapter_dir / "execution-policy.json").is_file():
        adapter_args = ["-e", "PCP_ADAPTER_CONFIG_DIR=/pcp-adapters", "--mount", f"type=bind,src={adapter_dir},dst=/pcp-adapters"]
    # Optional circtime uptime-radar build for the scene embed widget, mounted
    # read-only. Unset or missing: the dashboard serves no embeds (route 404).
    embed_dir = Path(os.environ.get("CIRCTIME_EMBED_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/circtime/dist"))
    embed_args = []
    if (embed_dir / "index.html").is_file():
        embed_args = ["-e", "CIRCTIME_EMBED_DIR=/embed-src/circtime", "--mount", f"type=bind,src={embed_dir},dst=/embed-src/circtime,readonly"]
    else:
        log.warning("Embed not mounted: dashboard/deployment embeds — circtime build directory has no index.html; deploying with the embed route off.")
    # Keep the encryption key outside recording/database backups and out of
    # OpenClaw's mounts. Never regenerate an existing key during deployment.
    metrics_key = env_file.parent / "metrics-encryption.key"
    if not metrics_key.exists():
        descriptor = os.open(metrics_key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(os.urandom(32))
            output.flush()
            os.fsync(output.fileno())
        os.chown(metrics_key, 1000, 1000)
        os.chmod(metrics_key, 0o400)
    if metrics_key.stat().st_size != 32:
        raise RuntimeError("Deployment cannot start: dashboard/metrics encryption — existing key must contain exactly 32 bytes.")
    metrics_dir = env_file.parent.parent / "metrics"
    if not metrics_dir.exists():
        metrics_dir.mkdir(mode=0o700)
        os.chown(metrics_dir, 1000, 1000)
    secure_private_storage(image, env_file, backups_root)
    run("docker", "run", "--rm", "--entrypoint", "node",
        "--mount", f"type=bind,src={metrics_key},dst=/run/secrets/metrics-encryption.key,readonly",
        "--mount", f"type=bind,src={metrics_dir},dst=/app/metrics",
        image, "-e", "const fs=require('node:fs');if(fs.readFileSync('/run/secrets/metrics-encryption.key').length!==32)process.exit(1);fs.accessSync('/app/metrics',fs.constants.R_OK|fs.constants.W_OK)")
    created = None
    try:
        if old:
            details = json.loads(subprocess.check_output(["docker", "inspect", old]))[0]
            data = next((m for m in details["Mounts"] if m["Destination"] == "/app/data"), None)
            if data and data["Type"] == "volume" and data.get("Name") == STATE_VOLUME:
                state_source = f"type=volume,src={STATE_VOLUME},dst=/data,readonly"
            elif data and data["Type"] == "bind" and Path(data["Source"]) == state_dir:
                state_source = f"type=bind,src={state_dir},dst=/data,readonly"
            else:
                raise RuntimeError("Deployment cannot start: dashboard/storage check — active container does not use the expected state volume or bind directory.")
            run("docker", "stop", "--time", "20", old)
            run("docker", "run", "--rm", "--user", "0", "--entrypoint", "tar",
                "--mount", state_source,
                "--mount", f"type=bind,src={backup_dir},dst=/backup",
                image, "-C", "/data", "-cf", "/backup/data.tar", ".")
            log.info("State backup saved: dashboard/deployment backup — the active state (%s) archived privately.", "legacy volume" if "type=volume" in state_source else "bind directory")
            run("docker", "run", "--rm", "--user", "0", "--entrypoint", "tar",
                "--mount", f"type=bind,src={metrics_dir},dst=/metrics,readonly",
                "--mount", f"type=bind,src={backup_dir},dst=/backup",
                image, "-C", "/metrics", "-cf", "/backup/metrics.tar", ".")
            if old == name:
                old_name = f"{old}-before-{stamp}"
                run("docker", "rename", old, old_name)
        prepare_state(image, state_dir)
        created = subprocess.check_output(["docker", "create", "--name", name, "--restart", "unless-stopped", "--network", "host",
            "--env-file", str(env_file), "-e", "HOST=127.0.0.1", "-e", "PORT=14143",
            "-e", "OPENCLAW_ACTIVITY_DIR=/var/log/openclaw-activity",
            "-e", "OPENCLAW_CONFIG_FILE=/openclaw-config/openclaw.json",
            "-e", "METRICS_ENCRYPTION_KEY_FILE=/run/secrets/metrics-encryption.key",
            "-e", "METRICS_DATA_DIR=/app/metrics",
            "--mount", f"type=bind,src={metrics_dir},dst=/app/metrics",
            "--mount", f"type=bind,src={metrics_key},dst=/run/secrets/metrics-encryption.key,readonly",
            "--mount", f"type=bind,src={activity_dir},dst=/var/log/openclaw-activity,readonly",
            "--mount", f"type=bind,src={config_dir},dst=/openclaw-config",
            "--mount", f"type=bind,src={state_dir},dst=/app/data", *embed_args, *adapter_args, "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
            "--label", "com.trance0.service=agent-dashboard", "--label", f"org.opencontainers.image.version={version}",
            "--health-cmd", "node -e \"fetch('http://127.0.0.1:14143/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            "--health-interval", "30s", "--health-timeout", "5s", "--health-retries", "3", image], text=True).strip()
        run("docker", "start", created)
        mounts = json.loads(subprocess.check_output(["docker", "inspect", created]))[0]["Mounts"]
        # Every persistent path must be a host bind, never a volume or the container layer.
        expected = {"/app/data": state_dir, "/app/metrics": metrics_dir, "/run/secrets/metrics-encryption.key": metrics_key}
        for destination, source in expected.items():
            if not any(m["Type"] == "bind" and m["Destination"] == destination and Path(m["Source"]) == source for m in mounts):
                raise RuntimeError(f"Deployment failed: dashboard/persistent storage — the new container does not bind-mount {source} at {destination}.")
        if not healthy("http://127.0.0.1:14143/healthz") or not healthy("https://live.trance-0.com/healthz", 30):
            raise RuntimeError("Deployment failed: dashboard/health verification — local or public endpoint did not become ready.")
    except Exception:
        if created:
            subprocess.run(["docker", "rm", "-f", created], check=False)
        if old_name:
            run("docker", "start", old_name)
        raise
    log.info("Deployment verified: dashboard/rollout — local and public health passed; prior container retained for rollback.")
    plugin_dir = root / "openclaw-plugin"
    destination = "/home/node/.openclaw/extensions/dashboard-stream"
    changed = any(
        subprocess.run(["docker", "exec", "openclaw-openclaw-gateway-1", "cat", f"{destination}/{source.name}"], capture_output=True).stdout != source.read_bytes()
        for source in plugin_dir.iterdir() if source.is_file()
    )
    if changed:
        run("docker", "cp", f"openclaw-openclaw-gateway-1:{destination}", str(backup_dir / "plugin"))
        run("docker", "cp", f"{plugin_dir}/.", f"openclaw-openclaw-gateway-1:{destination}")
        run("docker", "restart", "openclaw-openclaw-gateway-1")
        if not healthy("http://127.0.0.1:18789/healthz"):
            raise RuntimeError("Plugin update incomplete: dashboard/openclaw deployment — gateway did not become healthy after restart.")
        log.info("Plugin updated: dashboard/openclaw deployment — remotely checked-out stream plugin loaded.")


if __name__ == "__main__":
    main()
