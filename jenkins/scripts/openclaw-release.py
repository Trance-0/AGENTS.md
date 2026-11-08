#!/usr/bin/env python3
"""Deploy immutable OpenClaw image IDs, retain known-good releases, and recover.

The private runtime Compose file and release records live outside SCM. This
tool never reads an env file into a shell or logs runtime environment values.
"""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

LOG = logging.getLogger('openclaw-release')


def command(args, timeout=120):
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    start = time.monotonic()
    while True:
        try:
            out, error = process.communicate(timeout=min(20, max(1, timeout - (time.monotonic() - start))))
            break
        except subprocess.TimeoutExpired:
            if time.monotonic() - start >= timeout:
                process.kill(); process.communicate()
                raise RuntimeError(f'Operation timed out: platform/process - {args[0]} exceeded {timeout}s')
            LOG.info('Operation running: platform/process - %s is still in progress', args[0])
    if process.returncode:
        # Command stderr may include private Compose interpolation values.
        raise RuntimeError(f'Operation failed: platform/process - {args[0]} exited {process.returncode}')
    return out


def atomic_json(file, data):
    temp = file.with_suffix(file.suffix + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(data, handle, indent=2); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
    temp.replace(file)


def inspect(name):
    return json.loads(command(['docker', 'inspect', name]))[0]


def mount_identity(container):
    return sorted((m['Source'], m['Destination'], m['RW']) for m in container['Mounts'])


class Releases:
    def __init__(self, root):
        self.root = root
        self.config = json.loads((root / 'deployment.json').read_text())
        self.name = self.config['container']
        self.runtime = root / 'runtime.compose.json'
        self.records = root / 'releases'; self.records.mkdir(exist_ok=True, mode=0o700)
        self.public = root / 'status'; self.public.mkdir(exist_ok=True, mode=0o755)

    @contextlib.contextmanager
    def locked(self):
        with (self.root / 'deploy.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield

    def image(self, name):
        image = json.loads(command(['docker', 'image', 'inspect', name]))[0]
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image['Id']):
            raise RuntimeError('Deployment refused: platform/image identity - expected immutable sha256 image ID')
        return image

    def healthy(self, channels=False):
        try:
            c = inspect(self.name)
            if not c['State']['Running'] or c['State'].get('Health', {}).get('Status') != 'healthy': return False
            with urllib.request.urlopen(self.config['health_url'], timeout=5) as response:
                if response.status != 200: return False
            if channels and self.config.get('required_channels'):
                raw = command(['docker', 'exec', self.name, 'node', 'dist/index.js', 'channels', 'status', '--json'], timeout=120)
                data = json.loads(raw[raw.index('{'):])
                for channel in self.config.get('required_channels', []):
                    accounts = data.get('channelAccounts', {}).get(channel, [])
                    if not accounts or not any(a.get('running') is True for a in accounts): return False
            return True
        except (ValueError, OSError, RuntimeError): return False

    def launch(self, image):
        runtime = json.loads(self.runtime.read_text())
        service = runtime['services'][self.config['service']]
        service['image'] = image
        candidate = self.root / 'candidate.compose.json'; atomic_json(candidate, runtime)
        # Each attempt has a fresh Compose identity so a renamed rollback container
        # cannot be selected and removed by Compose's service-label discovery.
        with contextlib.suppress(RuntimeError):
            inspect(self.name)
            command(['docker', 'rm', '-f', self.name])
        project = f"{self.config['project']}-{time.time_ns()}"
        wait = int(self.config.get('health_wait_seconds', 180))
        command(['docker', 'compose', '-p', project, '-f', str(candidate), 'up', '-d', '--no-build', '--wait', '--wait-timeout', str(wait)], timeout=wait + 40)

    def status(self, record, action):
        # This record is safe to bind read-only into the dashboard.
        public = {key: record.get(key) for key in ['image_id', 'revision', 'created_at', 'container']}
        public.update(action=action, checked_at=dt.datetime.now(dt.timezone.utc).isoformat(), healthy=self.healthy())
        atomic_json(self.public / 'openclaw.json', public)
        os.chmod(self.public / 'openclaw.json', 0o644)

    def seed(self):
        if (self.root / 'lkg.json').exists(): return
        c = inspect(self.name)
        if not self.healthy(channels=True): raise RuntimeError('Cannot seed recovery: platform/health - existing gateway or required channels are unhealthy')
        self.promote(c['Image'], c['Config'].get('Labels', {}).get('org.opencontainers.image.revision', ''), 'seed')

    def promote(self, image, revision, action):
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        record = {'image_id': image, 'revision': revision, 'created_at': stamp, 'container': self.name}
        atomic_json(self.records / f'{stamp}.json', record)
        atomic_json(self.root / 'lkg.json', record)
        command(['docker', 'tag', image, f'openclaw:lkg-{stamp.lower().replace(".", "-")}'])
        self.status(record, action)
        LOG.info('Release promoted: platform/LKG - revision %s, immutable image %s', revision, image)

    def deploy(self, image_name, revision, soak):
        if (self.root / 'paused').exists(): raise RuntimeError('Deployment refused: platform/kill switch - recovery is paused')
        self.seed()
        image = self.image(image_name)
        if image.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != revision:
            raise RuntimeError('Deployment refused: platform/image revision - image label does not match tested source')
        old = inspect(self.name)
        backup = f'{self.name}-rollback-{int(time.time())}'
        command(['docker', 'stop', '--timeout', '20', self.name])
        command(['docker', 'rename', self.name, backup])
        try:
            self.launch(image['Id'])
            current = inspect(self.name)
            if sorted(current['Config']['Env']) != sorted(old['Config']['Env']) or mount_identity(current) != mount_identity(old):
                raise RuntimeError('Deployment refused: platform/runtime identity - environment or mounts changed')
            deadline = time.monotonic() + soak
            while True:
                if not self.healthy(): raise RuntimeError('Deployment failed: platform/soak - gateway became unhealthy')
                if time.monotonic() >= deadline: break
                LOG.info('Soaking release: platform/health - %.0fs remaining', deadline - time.monotonic())
                time.sleep(min(15, deadline - time.monotonic()))
            if not self.healthy(channels=True): raise RuntimeError('Deployment failed: platform/channel gate - required channels not running')
            self.promote(image['Id'], revision, 'deployed')
        except Exception:
            with contextlib.suppress(RuntimeError): command(['docker', 'rm', '-f', self.name])
            command(['docker', 'rename', backup, self.name]); command(['docker', 'start', self.name])
            self.status(json.loads((self.root / 'lkg.json').read_text()), 'rolled-back')
            raise

    def recover(self):
        if (self.root / 'paused').exists(): return
        if self.healthy():
            with contextlib.suppress(FileNotFoundError): (self.root / 'failures').unlink()
            self.status(json.loads((self.root / 'lkg.json').read_text()), 'healthy'); return
        count = int((self.root / 'failures').read_text()) + 1 if (self.root / 'failures').exists() else 1
        (self.root / 'failures').write_text(str(count))
        if count < 3:
            LOG.warning('Gateway unhealthy: platform/watchdog - failed check %s of 3', count); return
        record = json.loads((self.root / 'lkg.json').read_text())
        self.launch(record['image_id'])
        if not self.healthy(): raise RuntimeError('Recovery failed: platform/watchdog - known-good image did not recover health')
        (self.root / 'failures').unlink(); self.status(record, 'recovered')
        LOG.warning('Gateway recovered: platform/watchdog - restored known-good image %s', record['image_id'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    sub = parser.add_subparsers(dest='action', required=True)
    deploy = sub.add_parser('deploy'); deploy.add_argument('--image', required=True); deploy.add_argument('--revision', required=True); deploy.add_argument('--soak', type=int, default=60)
    for action in ['seed', 'watchdog', 'pause', 'resume']: sub.add_parser(action)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    releases = Releases(args.root)
    with releases.locked():
        if args.action == 'deploy': releases.deploy(args.image, args.revision, args.soak)
        elif args.action == 'seed': releases.seed()
        elif args.action == 'watchdog': releases.recover()
        elif args.action == 'pause':
            (args.root / 'paused').touch(); command(['docker', 'stop', '--timeout', '20', releases.name])
        elif args.action == 'resume':
            (args.root / 'paused').unlink(missing_ok=True); (args.root / 'failures').write_text('2'); releases.recover()


if __name__ == '__main__': main()
