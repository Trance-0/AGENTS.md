# AI infrastructure integration tracker

## Delivered locally (2026-11-06)

- [x] Consolidate PCP identity, projects, native plugins and 0.3.2 recall fixes in the canonical repository.
- [x] Preserve dashboard scene/storage/settings/OpenCode work in its canonical repository.
- [x] Recycle nine redundant development/fixture directories after verifying ancestry and runtime references.
- [x] AstrBot verified owner execution through the signed PCP broker, with live per-tool authorization.
- [x] Dashboard `/adapters` group/member list editor; no groups enabled.
- [x] Image/GIF vision relay, sanitized persistent history, native upload queue and authorized image recall.
- [x] Optional authenticated nginx media-offload configuration.

## Required next, in order

- [x] Publish and merge PCP execution/media integration to Nesbitt-bot main (PR 6).
- [ ] Resolve deployment-fork write permission and verify the PCP Jenkins webhook and SHA.
- [ ] Publish dashboard integration; merge ai-infra-v0 into main with coordinated Jenkins branch change.
- [ ] Authenticate OpenClaw forge, publish source-only fixes and create a reproducible deployment pipeline including ACP plugin/service installation.
- [ ] Move OpenClaw session/workspace runtime state out of the source checkout with stopped-write manifest verification and rollback.
- [ ] Separate agent build authority from owner deployment/recovery controls; protect history and deployment tags.
- [ ] Implement independent watchdog, immutable known-good image records, kill switch and staging rollback/restore tests; wire the dashboard LKG placeholder.
- [ ] Complete project/workspace registration and versioned context synchronization in OpenCode/openclaw-pcp; merge-task worker and post-backfill retention.
- [ ] Finish PCP claim/identity/credential UI, session revocation and non-admin control visibility.
- [ ] Provision isolated group executors before enabling groups through `/adapters`.
- [ ] Documents/audio/video, media backfill, OCR/captions and retention/GC.
- [ ] Replace original placeholder checks and complete end-to-end recovery acceptance.

Publishing uses the existing OpenClaw Nesbitt-bot credentials. That account has
no write access to the Trance-0 PCP deployment fork. Database, adapter policy, media, service secrets, logs and
release evidence live under DockerVolumes. Recycled directories are recoverable
through the desktop Trash.
