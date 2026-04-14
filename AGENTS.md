# AGENTS.md — Canonical Agent Handoff Template

This repo is the **reference template** for how coding agents (Claude Code,
Codex, Cursor, Copilot, etc.) should collaborate on any of
`Trance-0`'s / the owner's projects. Copy or symlink the sections below into a
target repo's own `AGENTS.md` and adapt the project-specific bits.

Other agent-entry files in a target repo should **point here** rather than
duplicate it:

- `CLAUDE.md` → single line `@AGENTS.md` (Claude Code include syntax) or a
  symlink to `AGENTS.md`.
- `CODEX.md`  → symlink or include of `AGENTS.md`.
- Any tool-specific file → thin wrapper that `@`-includes `AGENTS.md`.

Keep one source of truth. Do not fork agent rules per tool.

---

## 1. Abstract development contract

These rules apply to **every** project owned by the repo owner unless a
project-local `AGENTS.md` explicitly overrides a specific point.

### 1.1 Tone and output

- Be concise. Prefer a direct answer or a diff over a narrative.
- No emojis in committed files, commit messages, PR titles, or docs unless the
  owner explicitly asks.
- No trailing "summary of what I just did" when a diff already shows it.
- File references in chat: repo-root-relative paths (`src/foo.ts:42`), never
  absolute Windows paths (`d:\...`) or `~/...`.

### 1.2 Scope discipline

- Do what was asked. Do not refactor, rename, "clean up", or "harden" unrelated
  code in the same change.
- Do not invent features, flags, or config knobs "for future use".
- Do not add backwards-compat shims, feature flags, or deprecation wrappers
  unless the task requires them.
- Three similar lines beats a premature abstraction. Split only when it
  actually improves clarity or testability.

### 1.3 Correctness over speed

- Verify before claiming: if you report a command passed, you must have run it
  in the current environment. If a command could not be run, say so and why.
- No guessed facts. If you do not know a version, path, port availability, or
  dependency behavior — check it. Do not guess host port availability.
- Bug fixes need a named root cause in code (file:line), not "I tweaked
  something and the symptom went away".

### 1.4 Safety and reversibility

- Destructive git actions (`reset --hard`, `push --force`, branch deletion,
  stash drop, worktree removal) require explicit owner approval per-invocation.
  A previous approval does not carry forward.
- Never `--no-verify` a commit or skip hooks to make something "just pass".
- Never commit secrets, real phone numbers, real emails, private keys,
  `.env` files, or vendor dumps. Use obvious placeholders.
- Do not touch another agent's in-progress work in a shared worktree. If you
  see unrecognized files, keep going on your own scope — do not delete them.

### 1.5 Style defaults

- American English in code, comments, docs, UI strings.
- Write comments only when the **why** is non-obvious (hidden constraint,
  subtle invariant, workaround for a known upstream bug). No "what does this
  line do" comments.
- Keep files under ~500 LOC when feasible; split by responsibility, not by
  arbitrary line count.

---

## 2. Docs-in-`docs/` rule (IMPORTANT)

This is the rule the owner cares about most; follow it aggressively.

### 2.1 When a `docs/` directory is required

Create a `docs/` directory at the **repo root** if any of the following is true:

- The project has a deployment method **other than one-click deploy** (Vercel
  import, Render Blueprint, Netlify import, a single `docker compose up`, a
  single `npm run deploy`, etc. are one-click; anything with multiple manual
  steps, host prep, DNS wiring, secret provisioning, or a CI pipeline is not).
- The project is split across multiple runtimes (frontend + backend, multiple
  apps, worker + web, mobile + web).
- The project has environment-specific deploy targets (Jenkins self-hosted
  plus a PaaS, multi-region, multi-tenant).
- The project has any long-form architectural narrative that would otherwise
  inflate `README.md` past ~200 lines.

### 2.2 What goes inside `docs/`

- `docs/readme.md` — **human-facing summary of how the project works**.
  - What problem it solves.
  - System diagram in words (who calls whom, what the storage tier is,
    where the build artifacts live).
  - Runtime shape (languages, frameworks, package managers).
  - Deployment topology (one subsection per deploy target).
  - Local-dev bootstrap (exact commands, in order).
- `docs/index.md` — **agent-facing / long-form detail**.
  - If the original `AGENTS.md` is too long to be ergonomic
    (roughly > 200 lines of project-specific detail), move the deep
    architectural content, deploy runbooks, and pitfall lists into
    `docs/index.md` and leave `AGENTS.md` as a short pointer file.
- Subfolders for major topic areas, mirroring how the project is actually
  deployed / tested / shipped:
  - `docs/deployment/<target>.md` per deploy target (Jenkins, Render, Docker,
    Pages, Fly, Northflank, etc.).
  - `docs/development/` for local-dev specifics.
  - `docs/operations/` for on-call / migration runbooks.
  - `docs/api/` for API surface specs.
  - `docs/versions/<semver>.md` for per-release change notes when the project
    tracks them that way (see Notechondria for precedent).

### 2.3 GitHub Actions to deploy the docs page

**Only when the repo owner explicitly asks for it.** Do not add this workflow
on your own initiative.

When asked, add a workflow that publishes `docs/` to GitHub Pages. Prefer the
minimal shape:

```yaml
# .github/workflows/docs.yml
name: docs
on:
  push:
    branches: [main]
    paths: ["docs/**", ".github/workflows/docs.yml"]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: "pages"
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      # Pick ONE of: mkdocs, docusaurus, next-export, plain static.
      # Example: mkdocs-material
      - run: pip install mkdocs-material
      - run: mkdocs build --strict --site-dir _site
      - uses: actions/upload-pages-artifact@v3
        with: { path: _site }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Rules for the docs workflow:

- **Pages path on a GitHub project site is `/<repo>/`.** If the docs tool has
  a base-path option (mkdocs `site_url`, docusaurus `baseUrl`, Next.js
  `basePath`), set it to `/<repo>/`. Past mistakes: Notechondria shipped a
  Pages build with root-level `/editor/` etc. that 404'd under the project
  path — always prefix with the repo name.
- The workflow must not be the only thing that can push to `main`. Keep it
  scoped to Pages artifacts only.
- If docs live alongside app code, use `paths:` filters so doc-only changes
  don't rebuild the app, and vice versa.

### 2.4 Migration policy for legacy single-file repos

When you land in a repo whose existing `AGENTS.md` (or `CODEX.md`, or
`CLAUDE.md`) is really just a project description dumped into one file:

1. If the content is a **project description only** (what the project is, what
   stack it uses, how to run it):
   - Move it into `README.md` as a **brief** summary (what + why + how to
     start). Trim aggressively; `README.md` is not a design doc.
   - Leave `AGENTS.md` as a short pointer file that says "see README.md for
     product, see docs/ for deep detail, see LLM_CHECK.md for end-of-round
     checklist".

2. If the content is **too long to be ergonomic** for agents (very roughly:
   more than ~200 lines of project-specific narrative, or more than one
   scroll-screen of deploy runbook):
   - Move the long-form content into `docs/index.md`.
   - Move deploy runbooks into `docs/deployment/<target>.md`.
   - Leave `AGENTS.md` at the root with only:
     - the invariant rules an agent must obey before touching code,
     - a pointer to `docs/index.md` for architecture,
     - a pointer to `LLM_CHECK.md` for the end-of-round checklist.

3. If the content is a **mix of rules and project description**:
   - Split along that seam. Rules stay in `AGENTS.md`. Description moves to
     `README.md` (short) and `docs/index.md` (long).

Never delete the original content without first landing the moved copy; the
move and the delete can be one commit, but both must be in the diff.

---

## 3. Standard repo layout this template encourages

```
<repo>/
├── README.md                  ← brief: what + why + quick start
├── AGENTS.md                  ← agent rules only; pointer to docs/
├── CLAUDE.md                  ← symlink or `@AGENTS.md` include
├── CODEX.md                   ← symlink or include of AGENTS.md
├── LLM_CHECK.md               ← end-of-round checklist (see §5)
├── docs/
│   ├── readme.md              ← how the project works (human-facing)
│   ├── index.md               ← long-form agent/architecture notes
│   ├── deployment/<target>.md
│   ├── development/
│   ├── operations/
│   ├── api/
│   └── versions/<semver>.md
├── .github/workflows/
│   └── docs.yml               ← only if the owner asked for Pages deploy
└── <project source>
```

Not every repo needs every folder. Create folders on first real content, not
pre-emptively.

---

## 4. Per-language / per-stack expectations

Cribbed from the active repos. Apply the one that matches; if several match,
apply all of them.

### 4.1 Python (Django / scripts)

- Target Python 3.11+ unless the repo pins otherwise. Use `from __future__
  import annotations` and PEP 604 unions.
- Tests: `python manage.py test` or `pytest` depending on repo; always set
  `DJANGO_SETTINGS_MODULE` explicitly in CI shell.
- Settings split: `settings.py` (prod) and `settings_test.py` (test) must both
  define a non-empty `SECRET_KEY`.
- OpenAI / vendor SDK clients: initialize **lazily at call time**, never at
  module import. Import-time init breaks unrelated tests whenever the API key
  is missing.
- `requirements-<target>.txt` variants are allowed (e.g. `requirements-render.txt`
  excluding heavy ML deps for free-tier hosts).

### 4.2 TypeScript / Next.js

- Strict mode on. No `any`. No `@ts-nocheck`.
- Server Components by default; add `"use client"` only when interactivity is
  required.
- Do not mix static `import` and `await import()` for the same module in
  production code paths.
- Static-export sites on GitHub project Pages: set `basePath: "/<repo>"` and
  `trailingSlash: true`. Verify built HTML bootstraps with the correct base
  href before claiming the deploy works.

### 4.3 Flutter

- Three-app / multi-app Flutter repos: each app has its own `pubspec.yaml`,
  `lib/`, `web/`, `test/`, `Dockerfile`, and nginx template. Do not merge
  them back into a monolith.
- Widget tests avoid `pumpAndSettle()` when the page has long-lived timers
  (carousels, polling); use bounded pumps.
- Pages deploys for Flutter web: use `--no-web-resources-cdn`, disable the
  service worker in the final bootstrap, confirm `useLocalCanvasKit: true`.

### 4.4 Bash / shell scripts

- Every `curl`/`wget`/network call has a timeout. No unbounded waits.
- Container wait-loops have an explicit timeout **and** exit non-zero on
  expiry; never wait forever on `db` readiness.
- Do not `source` `.env` files with naive shell parsing when values can
  contain spaces. Use `env -i` + explicit exports, or Jenkins Environment
  Injector, not `set -a; source .env`.

### 4.5 Docker / Compose

- In-container service-to-service routing uses the Compose service name
  (e.g. `db`), **never** `localhost` or `host.docker.internal` unless that
  routing was actually verified on the target machine.
- Host port assignments are never assumed. Verify the port is free on the
  target host before picking it; prefer configurable `*_HOST_PORT` env vars.
- Do not volume-mount over a directory that contains baked-in code; that
  turns "random missing-package" bugs into multi-hour debugging sessions.

### 4.6 GitHub Actions

- Pin toolchain versions (`python-version: "3.11"`, `node-version: "20"`).
- Only the intended workflow should ever push to `main`. Bot commits use an
  identified bot author so humans can filter them.
- When debugging dependency drift, rebuild with `--pull --no-cache`.

---

## 5. `LLM_CHECK.md` contract

Every repo gets an `LLM_CHECK.md`. It is the **end-of-round checklist** the
agent runs before declaring a modification round done. See this repo's
[LLM_CHECK.md](LLM_CHECK.md) for the canonical template.

Minimum sections each project's `LLM_CHECK.md` must have:

1. **Common mistakes seen in prior rounds** — concrete, with enough context
   to avoid repeating the mistake.
2. **Round-end checklist** — commands actually run, commands skipped with
   reason, docs path audit, config/env consistency audit, host-port audit,
   unrelated-changes audit.
3. **Current round log** — append-only list of what this round actually did.

The `LLM_CHECK.md` is read **before finalizing** the round. If a check fails,
fix the underlying issue; do not just remove the check.

---

## 6. Commits and PRs (defaults)

- Commit messages are action-oriented and scoped: `backend: add recycle bin
  API`, `frontend/editor: split learner.dart into note_editor + metadata`,
  `docs: add Render free-tier deploy runbook`.
- One logical change per commit. Refactor + behavior change in the same
  commit is a review trap — split them.
- Do not amend a pushed commit. Create a new commit.
- Lint/format-only churn: auto-resolve if no semantic change. If the user
  already asked to commit, include formatting in the same commit.
- PR titles stay under 70 characters. Use the body for detail.
- Do not push to `main` / `origin/main` without explicit per-task approval.
  Pulling `--rebase` to integrate is fine; force-pushing is not.

---

## 7. Owner-specific shorthand

Expand these only when encountered:

- **`sync`**: if working tree is dirty, commit all with a sensible
  Conventional Commit message, then `git pull --rebase`; stop on unresolved
  conflicts; otherwise `git push`.
- **"update docs"**: edit `docs/readme.md` (+ `docs/index.md` if the change
  affects architecture) in the same commit as the code change it documents.
- **"one-click push"**: use the repo's review-and-push helper if present
  (see `scripts/review-and-push.ps1` in the `index` repo for the pattern).

---

## 8. How to use this template in a new repo

1. Copy `AGENTS.md` and `LLM_CHECK.md` from this repo into the new repo's
   root.
2. Trim §4 down to only the stacks the new repo actually uses.
3. Replace this §1–§3 boilerplate **only** with a short note saying "this
   project inherits the canonical rules from
   `github.com/<owner>/AGENTS.md`; overrides below".
4. Add project-specific sections: repo map, invariants, build/test commands,
   deployment topology, open-work / caution list.
5. If the repo already has a bloated `AGENTS.md`, follow the migration
   policy in §2.4 before adding new rules.
6. Add `CLAUDE.md` and `CODEX.md` as symlinks or single-line `@`-includes
   pointing at `AGENTS.md`.

That is the whole contract. Keep it boring, keep it truthful, keep it short.
