# OpenClaw source deployment and recovery

The gateway now runs an image built from private forge main at 727c8185,
including the source-only announcement, ACP and image-fallback fixes.
`jenkins/openclaw-auto-deploy.jenkinsfile` checks out remote main, builds the
pinned Dockerfile, checks the shipped core/SDK types and focused regressions,
builds a revision-labeled runtime, installs the ACP bridge, and invokes the
independently installed release helper. Optional extension dependency suites
are outside the default Docker build; the source-wide host typecheck was also
run during the image-fallback repair.

Private deployment root: `DockerVolumes/openclaw/deploy`. It contains the
inspected `runtime.compose.json`, `deployment.json`, immutable release records,
`lkg.json`, `deploy.lock`, the installed helper, watchdog logs and the safe
`status/openclaw.json`. No runtime environment values belong in SCM.

Host operations:

```sh
python3 jenkins/scripts/openclaw-release.py --root <private-deploy-root> seed
python3 jenkins/scripts/openclaw-release.py --root <private-deploy-root> deploy --image <tested-image> --revision <source-sha> --soak 60
python3 jenkins/scripts/openclaw-release.py --root <private-deploy-root> pause
python3 jenkins/scripts/openclaw-release.py --root <private-deploy-root> resume
```

The user timer runs watchdog every minute. Three consecutive failed checks
restore the known-good image without Jenkins. Pause writes a persistent marker
and stops the gateway; resume explicitly clears it. Deployments hold the same
lock, retain the previous container, compare environment/mount identity and
require both native channels running before promotion. Images are launched by
immutable sha256 ID; all successful release records and image tags are retained.

Validated on isolated staging: a deliberately broken image restored the prior
container; a failed deployment was recovered by the watchdog; paused recovery
stayed stopped until explicit resume. Production passed a 60-second soak and
channel checks. The gateway state was separately migrated with a full stopped-
write checksum comparison; the original state tree remains a rollback copy.

`opencode/scripts/install-harness.py` reproduces the pinned host OpenCode
installation and verifies the npm archive SHA-512. Credentials are provisioned
privately; plugin installation backs up previous files and preserves sessions.
`--gateway-only` installs the ACP bridge without touching the host service.

The owner explicitly chose container isolation and dropped separate Unix-user
and forge-administration setup. The watchdog is a recovery mechanism, not a
claim of separate host privilege domains. Existing working pipelines still
use remote SCM and real webhook triggers.
