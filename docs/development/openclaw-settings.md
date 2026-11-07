# OpenClaw settings and scheduled tasks

Dashboard 0.2.9 replaces the default JSON-only OpenClaw editor with grouped
forms. Sections cover every existing top-level configuration key; unfamiliar
fields remain editable without being dropped. The UI and JSON tabs share a
draft. Secret fields are password inputs, and the backend restores masked
placeholders from the current file. Existing optimistic hashes and backups
remain in force. Arrays containing masked credentials cannot be removed or
reordered in the form, because restoration is tied to the original path.

The Scheduled tasks tab lists all jobs, including paused jobs, through paginated
`cron.list` calls. The list shows names, agents, models, repeat patterns and
status. The form edits prompt/event text, model, thinking, timeout, lightweight
context, once/interval/daily/weekly/custom-cron schedules, time zones, interval
anchors, stagger windows, enabled/delete-after-run options and delivery.
Execution target follows payload type: assistant turns use isolated sessions;
system events use the main session. New jobs default to paused with no delivery.
Unexposed advanced fields remain intact and are available in the JSON tab.

The installed gateway cannot clear a previously assigned model override via
an empty patch. The form asks for an explicit model in that case. Schedule
validation and persistence belong to OpenClaw. The dashboard does not edit the
scheduler's file, execute jobs while saving, or relax HTTP tool restrictions.

## Server API

`GET /api/admin/openclaw-tasks` lists jobs. `POST` creates a job; `PUT /:id`
updates and `DELETE /:id` removes one. All routes require an administrator
session and the enabled OpenClaw settings panel. Writes also require the
same-origin dashboard request header. Prompt and job data never enter public
stream logs. Update/delete require a configuration hash; runtime status updates
do not invalidate it. Dashboard writes are serialized to detect competing
edits, though the upstream API does not offer atomic compare-and-swap against
changes made by other clients after the final read.

The gateway client uses the existing `OPENCLAW_ENDPOINT` and `OPENCLAW_TOKEN`.
It creates an Ed25519 device identity at `data/openclaw-device.json`, mode 600,
in the existing persistent dashboard state directory. It signs the gateway's
nonce using protocol v3 and requests operator read/write/admin scopes. The
credential and private key stay server-side. Trusted local connections pair
automatically under OpenClaw's policy; a remote gateway may require its normal
device approval. Pairing failures are shown as errors, never bypassed.

The JSON parser permits large config/task requests only on their dedicated
routes. Unknown task fields and runtime-state injection are rejected. All
requests have a connection/request timeout. Task saves use `cron.add`,
`cron.update`, or `cron.remove` and then reload the gateway's canonical values.

## Verification

Run `npm test` under Node 22 in `dashboard/`. Focused tests cover pagination,
authentication/admin/CSRF gates, stale writes, mutation serialization, device
signatures and private identity persistence.

`DASHBOARD_SETTINGS_BROWSER_CHECK=1` runs the new Chromium settings check
through the OIDC fixture in `server/auth.test.js`; `PLAYWRIGHT_MODULE` and
`CHROMIUM_PATH` select the local browser installation. It checks UI/JSON draft
round trips, masked credentials, task prompt/model/time updates, preserved
advanced fields and delivery, new paused jobs, and mobile/light/dark layouts.
`DASHBOARD_BROWSER_CHECK=1` additionally runs the existing browser regressions.
The task browser fixture simulates gateway jobs; live operator verification
uses only a temporary paused job and leaves existing schedules untouched.
