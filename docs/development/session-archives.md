# Session archive transfer

## Shared-folder synchronization

Session Manager 1.2.0 adds Directory sync settings. Choose a local folder backed
by Nextcloud or another file synchronizer on each device. Modes are Manual
(read on request), Import (automatically read and merge), and Auto (merge then
publish). Automatic passes run on startup and every minute. Each device writes
its own `device-<id>.tar.gz`; local SHA-256 cursors avoid importing unchanged
archives. Failed or changing files are retried and never acknowledged as synced.
Do not copy `device.json` between machines: each device must retain its own ID.

The configured folder for the owner's current device is
`D:\Documents\Nextcloud\opencode-sync`; that path is local configuration and
is not a default imposed on other installations.

Restart OpenCode after installing session-manager 1.1.10 and plugin-manager
1.1.10. Running processes retain the previous module implementation.

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
