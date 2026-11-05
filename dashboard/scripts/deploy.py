"""Deploy remote checkout, preserving recordings and the previous container."""
from __future__ import annotations

import datetime
import json
import logging
import os
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


def main():
    root = Path(__file__).resolve().parents[1]
    version = json.loads((root / "package.json").read_text())["version"]
    image = os.environ["DASHBOARD_IMAGE"]
    env_file = Path(os.environ["DEPLOY_ENV_SOURCE"])
    if not env_file.is_file():
        raise RuntimeError("Deployment cannot start: dashboard/private configuration — deployment environment file is absent.")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = Path("/home/motuariki/Documents/DockerVolumes/agent-dashboard/backups") / stamp
    backup_dir.mkdir(parents=True, mode=0o700)
    candidates = subprocess.check_output(["docker", "ps", "--format", "{{.Names}}"], text=True).splitlines()
    previous = [name for name in candidates if name.startswith("agent-dashboard-v")]
    if len(previous) > 1:
        raise RuntimeError("Deployment cannot start: dashboard/container discovery — multiple active dashboard containers require review.")
    old = previous[0] if previous else None
    old_name = old
    name = f"agent-dashboard-v{version}"
    volume = "dashboard_dashboard-state"
    activity_dir = Path(os.environ.get("OPENCLAW_ACTIVITY_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/openclaw/activity"))
    if not activity_dir.is_dir():
        raise RuntimeError("Deployment cannot start: dashboard/activity mount — shared OpenClaw activity directory is absent.")
    config_dir = Path(os.environ.get("OPENCLAW_CONFIG_HOST_DIR", "/home/motuariki/Documents/DockerVolumes/openclaw/config"))
    if not (config_dir / "openclaw.json").is_file():
        raise RuntimeError("Deployment cannot start: dashboard/config mount — shared OpenClaw config directory has no openclaw.json.")
    # Optional circtime uptime-radar build for the scene embed widget, mounted
    # read-only. Unset or missing: the dashboard serves no embeds (route 404).
    embed_dir = Path(os.environ["CIRCTIME_EMBED_HOST_DIR"]) if os.environ.get("CIRCTIME_EMBED_HOST_DIR") else None
    embed_args = []
    if embed_dir and (embed_dir / "index.html").is_file():
        embed_args = ["-e", "CIRCTIME_EMBED_DIR=/embed-src/circtime", "--mount", f"type=bind,src={embed_dir},dst=/embed-src/circtime,readonly"]
    elif embed_dir:
        log.warning("Embed not mounted: dashboard/deployment embeds — %s has no index.html; the circtime embed stays off.", embed_dir.name)
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
    run("docker", "run", "--rm", "--entrypoint", "node",
        "--mount", f"type=bind,src={metrics_key},dst=/run/secrets/metrics-encryption.key,readonly",
        "--mount", f"type=bind,src={metrics_dir},dst=/app/metrics",
        image, "-e", "const fs=require('node:fs');if(fs.readFileSync('/run/secrets/metrics-encryption.key').length!==32)process.exit(1);fs.accessSync('/app/metrics',fs.constants.R_OK|fs.constants.W_OK)")
    created = None
    try:
        if old:
            details = json.loads(subprocess.check_output(["docker", "inspect", old]))[0]
            if not any(m.get("Name") == volume and m["Destination"] == "/app/data" for m in details["Mounts"]):
                raise RuntimeError("Deployment cannot start: dashboard/storage check — active container does not use the expected recording volume.")
            run("docker", "stop", "--time", "20", old)
            run("docker", "run", "--rm", "--user", "0", "--entrypoint", "tar",
                "--mount", f"type=volume,src={volume},dst=/data,readonly",
                "--mount", f"type=bind,src={backup_dir},dst=/backup",
                image, "-C", "/data", "-cf", "/backup/data.tar", ".")
            log.info("State backup saved: dashboard/deployment backup — recording volume archived privately.")
            run("docker", "run", "--rm", "--user", "0", "--entrypoint", "tar",
                "--mount", f"type=bind,src={metrics_dir},dst=/metrics,readonly",
                "--mount", f"type=bind,src={backup_dir},dst=/backup",
                image, "-C", "/metrics", "-cf", "/backup/metrics.tar", ".")
            if old == name:
                old_name = f"{old}-before-{stamp}"
                run("docker", "rename", old, old_name)
        else:
            run("docker", "volume", "create", volume)
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
            "--mount", f"type=volume,src={volume},dst=/app/data", *embed_args, "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
            "--label", "com.trance0.service=agent-dashboard", "--label", f"org.opencontainers.image.version={version}",
            "--health-cmd", "node -e \"fetch('http://127.0.0.1:14143/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            "--health-interval", "30s", "--health-timeout", "5s", "--health-retries", "3", image], text=True).strip()
        run("docker", "start", created)
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
