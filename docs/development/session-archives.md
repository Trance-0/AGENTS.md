# Session archive transfer

## Shared-folder synchronization

Session Manager 1.3.0 separates directory synchronization from archive exports.
Choose a folder backed by Nextcloud or another file synchronizer on each device.
Modes are Manual (no active merge), Local only (merge Codex, Claude Code and dsh
stores), Directory (use the configured folder only), and Auto (merge local stores
and the shared directory when configured). The shared directory defaults to blank;
local indexes and cursors stay in the plugin's local data/config directories.
Automatic passes run on startup and every minute.

Shared layout:

```text
projects/<project-name-id>/imported/<session-id>/<device-revision>.json
conflicts/<hash-prefix>/<revision-hash>.json
history/<hash-prefix>/<record-hash>.json
```

Per-session JSON revisions are immutable and updates do not overwrite another
device's history. Conflicts preserve superseded records; history retains original
provider records and operation logs. Local SHA-256 cursors skip unchanged files.
Failed or changing files are retried and never acknowledged as synced.
Existing `.tar.gz` snapshots are ignored by directory sync; use explicit archive
import for those files. Directory sync does not create new archive snapshots.
Do not copy `device.json` between machines: each device must retain its own ID.

The configured folder for the owner's current device is
`D:\Documents\Nextcloud\opencode-sync`; that path is local configuration and
is not a default imposed on other installations.

Restart OpenCode after updating the plugins. Running processes retain the
previous module implementation.

On the source device, use Session Manager > Settings > Export complete session
history to .tar.gz. On the destination, use Import from .tar.gz and supply the
path accessible on that device. Generate a fresh version 2 archive: the older
text-only format cannot recover tool operations that it never exported.

The archive contains native and imported OpenCode session rows, messages and
all part types (including tools), events, input/context records and todos.
External source files are retained as raw payloads with normalized text for
compatibility. Unavailable paths retain their descriptor and any prior payload.
These paths are monitoring pointers, not prerequisites for re-exporting history.
Accounts, authentication credentials and share secrets are excluded.

Records merge by primary key. Independently imported external sessions match by
origin device, provider and source ID. Identical message/part payloads are reused.
Newer record timestamps update the current view; both versions remain in an
immutable archive-history table and travel on subsequent exports. Equal-length
transcripts alone are not evidence of duplication.

Source-only provider records retain their original operation history in the
archive. OpenCode's provider converter currently renders their text; it does not
reconstruct provider-specific tool UI. Files referenced by attachments and Git
working-tree snapshots are not copied by this database archive.

Import/export status is displayed in a collapsible panel below the triggering
widget. The current dashboard polls every five seconds.

Checks (from repository root):

```powershell
node opencode/scripts/test-session-transfer.mjs
node opencode/scripts/test-dashboard-script.mjs
```

Tests use isolated databases and temporary archives. They cover receiving-side
history, repeat imports, same-length tool updates, revision retention, missing
pointers, re-export to a third device, external identity deduplication and
corrupt archive rejection.
