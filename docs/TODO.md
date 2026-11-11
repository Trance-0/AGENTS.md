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
- [x] Owner synchronized PCP to the Trance-0 deployment fork; real webhook build #7 succeeded on 8d4fddf.
- [x] Merge dashboard integration to main (PR 1); Jenkins switched to main and real webhook build #27 succeeded on d559739.
- [x] Publish and merge OpenClaw source-only fixes (private forge PR 12), excluding runtime-config backup changes.
- [ ] Create a reproducible OpenClaw deployment pipeline including ACP plugin/service installation.
- [x] Move OpenClaw state to DockerVolumes/openclaw/state; full stopped-write checksum/metadata comparison passed and original tree retained for rollback.
- [ ] Container-only execution isolation and protected recovery configuration; separate Unix users and forge-admin setup were explicitly dropped by the owner.
- [x] Independent watchdog, immutable known-good image records and kill switch installed; staging broken-image rollback and recovery passed.
- [ ] Ship dashboard known-good release status panel.
- [ ] Complete project/workspace registration and versioned context synchronization in OpenCode/openclaw-pcp; merge-task worker and post-backfill retention.
- [ ] Finish PCP claim/identity/credential UI, session revocation and non-admin control visibility.
- [x] Dashboard provisions restricted agents for selected groups; execution runs in per-chat isolated containers. Live allowlist stays empty.
- [x] AstrBot voice attachments and local transcription implemented.
- [ ] Documents/video, media backfill, OCR/captions and retention/GC.
- [ ] Replace original placeholder checks and complete end-to-end recovery acceptance.

Publishing uses the existing OpenClaw Nesbitt-bot credentials. That account has
no write access to the Trance-0 PCP deployment fork. Database, adapter policy, media, service secrets, logs and
release evidence live under DockerVolumes. Recycled directories are recoverable
through the desktop Trash.


## Task reliability repair (2026-11-11)

- [x] Dashboard task-save minimal patches, top notification, and five-second Undo; deployed by Jenkins build 31.
- [x] Identify Bilibili failure: denied yield, exhausted provider credit, and missing durable QQ completion route.
- [x] Install durable PCP work monitoring and AstrBot polling; verify real delegated Python completion after the parent closes through an isolated local ingress.
- [x] Merge PCP 0.4.3 into Nesbitt-bot main (PR 9); deploy locally.
- [ ] Owner sync of PCP 0.4.3 to the Trance-0 fork for its Jenkins rebuild.
- [x] Authorized QQ progress/final-status delivery test; start, running, and final messages verified through QQ history and get_msg readback.

- [x] Shared host OpenCode desktop/server uses CPA Astra with local Qwen3.8 vLLM failover; forced provider failure passed Python-tool and final-response checks.
