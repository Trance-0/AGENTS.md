#!/usr/bin/env python3
"""Install the shared ACP bridge and host OpenCode service from this repository.

Credentials/configuration are provisioned separately. Existing transcripts and
private configuration are never replaced. Run without --gateway-only on host.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request

VERSION = '1.19.5'
ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger('opencode-install')


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response: return response.read()


def digest_tree(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and not p.name.endswith('.test.js')}


def replace_tree(source, target, backups):
    expected = digest_tree(source)
    if target.exists() and digest_tree(target) == expected: return False
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    if target.exists(): shutil.copytree(target, backups / f'{target.name}-{time.time_ns()}')
    staging = target.with_name(target.name + '.installing')
    if staging.exists(): shutil.rmtree(staging)
    shutil.copytree(source, staging, ignore=shutil.ignore_patterns('*.test.js', '__pycache__'))
    if digest_tree(staging) != expected: raise RuntimeError('Installation refused: OpenCode/plugin verification - staged files do not match source')
    if target.exists(): shutil.rmtree(target)
    staging.rename(target)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gateway-only', action='store_true')
    parser.add_argument('--state-root', type=Path, default=Path.home() / 'Documents/DockerVolumes/openclaw/state')
    parser.add_argument('--server-root', type=Path, default=Path.home() / 'Documents/DockerVolumes/openclaw-opencode')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if not (args.state_root / 'credentials/opencode-server.json').is_file():
        raise RuntimeError('Installation refused: OpenCode/private configuration - gateway server credentials have not been provisioned')
    target = args.state_root / 'extensions/opencode-server'
    target.parent.mkdir(parents=True, exist_ok=True)
    changed = replace_tree(ROOT / 'openclaw-plugin', target, args.server_root / 'backups/plugin-installs')
    LOG.info('Gateway bridge verified: OpenCode/install - %s; gateway restart activates changed files', 'updated' if changed else 'unchanged')
    if args.gateway_only: return
    if not (args.server_root / 'server.env').is_file() or not (args.server_root / 'config/opencode/opencode.json').is_file():
        raise RuntimeError('Installation refused: OpenCode/private configuration - server environment or provider configuration is absent')
    for name in ['logs', 'runtime', 'cache', 'data', 'state']:
        (args.server_root / name).mkdir(exist_ok=True, mode=0o700)
    package = f'opencode-linux-{ "arm64" if os.uname().machine == "aarch64" else "x64" }'
    binary = args.server_root / 'runtime/package/bin/opencode'
    version_file = args.server_root / 'runtime/version'
    if not binary.is_file() or not version_file.exists() or version_file.read_text().strip() != VERSION:
        LOG.info('Downloading runtime: OpenCode/install - pinned %s %s', package, VERSION)
        metadata = json.loads(fetch(f'https://registry.npmjs.org/{package}/{VERSION}'))
        archive = fetch(metadata['dist']['tarball'])
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
        if integrity != metadata['dist']['integrity']: raise RuntimeError('Installation refused: OpenCode/integrity - npm archive hash differs')
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            member = tar.getmember('package/bin/opencode')
            if not member.isfile(): raise RuntimeError('Installation refused: OpenCode/archive - executable is not a regular file')
            binary.parent.mkdir(parents=True, exist_ok=True)
            tmp = binary.with_suffix('.new'); tmp.write_bytes(tar.extractfile(member).read()); tmp.chmod(0o700); tmp.replace(binary)
        version_file.write_text(VERSION + '\n')
    config = args.server_root / 'config/opencode'
    for name in ['plugin', 'lib']: replace_tree(ROOT / name, config / name, args.server_root / 'backups/plugin-installs')
    shutil.copy2(ROOT / 'versions.json', config / 'versions.json')
    package_file = config / 'package.json'
    package_file.write_text(json.dumps({'private': True, 'type': 'module', 'dependencies': {'@opencode-ai/plugin': VERSION, 'msgpackr': '1.11.8'}}, indent=2) + '\n')
    LOG.info('Installing pinned plugin dependencies: OpenCode/install - npm will report progress')
    subprocess.run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=config, check=True, timeout=180)
    unit = Path.home() / '.config/systemd/user/openclaw-opencode.service'
    unit.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ROOT / 'server/openclaw-opencode.service', unit)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, timeout=30)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'openclaw-opencode.service'], check=True, timeout=30)
    subprocess.run(['systemctl', '--user', 'restart', 'openclaw-opencode.service'], check=True, timeout=30)
    LOG.info('Service installed: OpenCode/install - existing credentials and session database preserved')


if __name__ == '__main__': main()
