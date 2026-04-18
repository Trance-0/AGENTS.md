# AGENTS.md — Canonical Agent Handoff Template

This repo is the **reference template** for how coding agents (Claude Code,
Codex, Cursor, Copilot, etc.) should collaborate on any of
`Trance-0`'s / the owner's projects. Copy or symlink the sections below into a
target repo's own `AGENTS.md` and adapt the project-specific bits.

Other agent-entry files in a target repo should **point here** rather than
duplicate it:

- `CLAUDE.md` → single line `@AGENTS.md` (Claude Code include syntax) or a
  symlink to `AGENTS.md`. Nothing else goes in this file.
- `CODEX.md`  → symlink or include of `AGENTS.md`.
- Any tool-specific file → thin wrapper that `@`-includes `AGENTS.md`.

Keep one source of truth. Do not fork agent rules per tool.

---

## 1. Abstract development contract

These rules apply to **every** project owned by the repo owner unless a
project-local `docs/AGENTS.md` explicitly overrides a specific point.

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

### 1.4 Safety, secrets, and file size

- Destructive git actions (`reset --hard`, `push --force`, branch deletion,
  stash drop, worktree removal) require explicit owner approval per-invocation.
  A previous approval does not carry forward.
- Never `--no-verify` a commit or skip hooks to make something "just pass".
- **Never commit `.env` files to GitHub.** Treat this as a critical security
  issue, not a style preference. Only a clearly non-secret `.env.example` or
  `sample.env` with obvious placeholder values may ship. `.env`, `.env.local`,
  `.env.production`, `.env.*` with real values must be in `.gitignore` and
  never staged. Also never commit real credentials, private keys, real phone
  numbers, real emails, or vendor dumps.
- **Never commit a file larger than 300 MB** unless the owner explicitly
  asked for it and Git LFS (or an equivalent) is configured. Check staged
  sizes (`git diff --cached --stat`) before pushing, not after.
- Never commit platform-mismatched binaries (Linux `.so`, macOS `.dylib`,
  Windows `.dll`, `.exe`) or build artifacts from another architecture.
- `.gitignore` must cover, at minimum, the language caches and build output
  of every toolchain the repo actually uses:
  - Python: `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/`, `.mypy_cache/`,
    `.ruff_cache/`, `.venv/`, `venv/`, `dist/`, `build/`, `*.egg-info/`.
  - Node / JS / TS: `node_modules/`, `.next/`, `.nuxt/`, `.turbo/`, `dist/`,
    `build/`, `.pnpm-store/`, `coverage/`.
  - Dart / Flutter: `.dart_tool/`, `build/`, `.flutter-plugins*`.
  - JVM / Go / Rust: `target/`, `out/`, `bin/`, `.gradle/`.
  - OS / editor junk: `.DS_Store`, `Thumbs.db`, `.idea/`, `.vscode/` (when
    not repo-shared).
  When you add a new language or toolchain to a repo, extend `.gitignore` in
  the same commit.
- Do not touch another agent's in-progress work in a shared worktree. If you
  see unrecognized files, keep going on your own scope — do not delete them.

### 1.5 Style defaults

- American English in code, comments, docs, UI strings.
- Write comments only when the **why** is non-obvious (hidden constraint,
  subtle invariant, workaround for a known upstream bug). No "what does this
  line do" comments.
- Keep files under ~500 LOC when feasible; split by responsibility, not by
  arbitrary line count.

### 1.6 Root-directory hygiene (agent-authored files)

Agent-authored files at the repo root are the user's first impression of the
project. Keep the root minimal.

- The **only** files an agent may author at repo root on its own initiative:
  - `README.md` — brief project description.
  - `AGENTS.md` — this file; invariant rules + pointer to `docs/`.
  - `CLAUDE.md` — single line `@AGENTS.md` (Claude Code include). No other
    content goes in this file.
  - `CODEX.md` — symlink or single-line include of `AGENTS.md`.
  - `VERSION` — current docs or deployment version string only. Not a
    changelog, not a release notes dump.
  - `LICENSE`, `.gitignore`, and the project's required build / config files
    (`package.json`, `pyproject.toml`, `Dockerfile`, `requirements*.txt`,
    `pubspec.yaml`, etc.).
- Every other agent-authored doc — end-of-round checklists, TODO lists,
  architecture narratives, migration notes, deploy runbooks, project-specific
  agent overrides — lives under `docs/`. Specifically:
  - `LLM_CHECK.md` lives at `docs/LLM_CHECK.md`, never at root.
  - `TODO.md` lives at `docs/TODO.md` (see §2.5).
  - A project-specific extension of this file lives at `docs/AGENTS.md`; the
    root `AGENTS.md` stays as the invariant entry point.
- Exception: the owner explicitly asked for a root-level file. That approval
  covers that file only, not a precedent.

### 1.7 Error and info messages (IMPORTANT)

Applies to every user-visible error/warning/info prompt, alert, toast, modal,
flash message, and every log line emitted for debugging or operations. "Simple"
messages like `"Invalid token"`, `"Session expired"`, `"Something went wrong"`,
or `"Error"` are **never acceptable**. They hide the blast radius from the user
and the root cause from the next maintainer.

Every error, warning, or diagnostic message must contain all three of the
following components:

1. **Consequence** — what the user or system can no longer do as a result.
   Examples: "unable to log in", "note cannot be synchronized", "upload
   aborted", "draft not saved".
2. **Source module + process** — a uniquely defined module name and the
   specific process inside it that triggered the message. Examples: "user
   authentication / token refresh", "remote notes synchronization / pull",
   "note data validation / schema check", "payments / webhook verification".
   Use names that are stable and greppable across the codebase; do not use
   ad-hoc phrasing that changes per call site.
3. **Cause / triggering condition** — the specific condition that produced
   the message. Examples: "incorrect password", "server connection timed
   out after 10s", "session key mismatch", "schema version 4 expected, got
   3", "rate limit exceeded (429)".

Shape (informal): `"<consequence>: <module>/<process> — <cause>"`. Wording can
vary per UI surface, but all three pieces must be present.

Examples:

- Bad: `"Invalid token"`
- Good: `"Unable to log in: user authentication / token refresh — session
  token signature mismatch. Please sign in again."`

- Bad: `"Sync failed"`
- Good: `"Note cannot be synchronized: remote notes synchronization / pull —
  server connection timed out after 10s. Will retry in the background."`

- Bad: `"Validation error"`
- Good: `"Draft not saved: note data validation / schema check — required field 'title' is empty."`

Rules:

- This applies to **every** surface: end-user-facing prompts/alerts/toasts,
  developer-facing logs, telemetry events, assertion failures, thrown
  exception messages, and CLI stderr output. End-user wording may be gentler
  than log wording, but all three components must still be present.
- Never swallow the cause to "simplify" the user-facing message. If the raw
  cause is too technical, keep a user-friendly consequence + module/process
  in the UI string and include the precise cause in the accompanying log
  line; do not drop it.
- Any log message, alert, or user feedback that is missing any of the three
  components is considered **INVALID** and must be revised in the same round
  it is discovered. Do not defer these fixes.
- When adding or editing an error path, audit nearby existing messages in
  the same module for this rule; bring them into compliance as part of the
  same change if the scope allows.

---

## 2. Docs-in-`docs/` rule (IMPORTANT)

This is the rule the owner cares about most; follow it aggressively.

### 2.1 When a `docs/` directory is required

In practice, **every agent-managed repo needs `docs/`**, because
`docs/LLM_CHECK.md` lives there. Create `docs/` at the repo root on first
round. You also need it if:

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
    `docs/index.md` and leave root `AGENTS.md` as a short pointer file.
- `docs/LLM_CHECK.md` — end-of-round checklist (see §5). Do not keep a second
  copy at repo root.
- `docs/TODO.md` — user-visible task / todo tracker (see §2.5). Present when
  the project is complex enough to warrant one.
- `docs/AGENTS.md` — optional. Project-specific agent rules that extend or
  override the root `AGENTS.md`. Use when project-specific rules outgrow a
  pointer file.
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
     product, see docs/ for deep detail, see docs/LLM_CHECK.md for end-of-round
     checklist".

2. If the content is **too long to be ergonomic** for agents (very roughly:
   more than ~200 lines of project-specific narrative, or more than one
   scroll-screen of deploy runbook):
   - Move the long-form content into `docs/index.md`.
   - Move deploy runbooks into `docs/deployment/<target>.md`.
   - Leave `AGENTS.md` at the root with only:
     - the invariant rules an agent must obey before touching code,
     - a pointer to `docs/index.md` for architecture,
     - a pointer to `docs/LLM_CHECK.md` for the end-of-round checklist.

3. If the content is a **mix of rules and project description**:
   - Split along that seam. Rules stay in `AGENTS.md`. Description moves to
     `README.md` (short) and `docs/index.md` (long).

4. If the repo has a legacy `LLM_CHECK.md` at root, move it to
   `docs/LLM_CHECK.md` in the same commit and update every in-repo reference
   (root `AGENTS.md`, README, CI scripts, commit templates) to the new path.

Never delete the original content without first landing the moved copy; the
move and the delete can be one commit, but both must be in the diff.

### 2.5 Project-level TODO list

- Any user-visible task / todo list the owner wants to track lives at
  `docs/TODO.md`.
- If the repo currently has a `TASK.md`, `tasks.md`, `TODOS.md`, or similarly
  named task-tracking file at root (or anywhere else), rename it to
  `docs/TODO.md` and update **every** reference in the same commit:
  docs, in-code comments, CI scripts, commit-message templates, any linked
  section headings. Stale `TASK.md` links are a common drift footgun.
- `docs/TODO.md` is for owner-visible, multi-round work items. Don't use it
  for per-round agent scratch — those go in the agent's live plan / todo
  tool and do not get committed.
- Skip creating `docs/TODO.md` for trivial repos where the whole project
  fits in a single round. Create it on first round the project grows beyond
  that.

### 2.6 Keep `docs/` and `README.md` in sync with material changes

- A change is **material** if it adds, removes, or renames any of: a runtime,
  a deploy target, an env var, a required CLI tool, a CI pipeline step, an
  entry-point script, or the "how to rebuild this with an LLM" recipe.
- Material changes ship with an accompanying edit to `README.md`,
  `docs/readme.md`, and whichever `docs/<area>/...` file documents the
  affected piece, **in the same commit** as the code change. No "docs will
  catch up later" commits.
- Before closing the round, reopen `README.md` and `docs/readme.md` and
  confirm they still describe what actually runs. If they don't, fix them in
  that same round; do not punt.

---

## 3. Standard repo layout this template encourages

```text
<repo>/
├── README.md                  ← brief: what + why + quick start
├── AGENTS.md                  ← agent rules only; pointer to docs/
├── CLAUDE.md                  ← single line `@AGENTS.md`
├── CODEX.md                   ← symlink or include of AGENTS.md
├── VERSION                    ← optional; docs / deploy version only
├── .gitignore                 ← caches, node_modules, .env, build output, OS junk
├── docs/
│   ├── readme.md              ← how the project works (human-facing)
│   ├── index.md               ← long-form agent / architecture notes
│   ├── LLM_CHECK.md           ← end-of-round checklist (see §5)
│   ├── TODO.md                ← user task tracker (when warranted)
│   ├── AGENTS.md              ← optional project-specific override
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
pre-emptively. Only `README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, and
`docs/LLM_CHECK.md` are expected on day one for any agent-managed project.

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
- `.gitignore` must include `__pycache__/`, `*.pyc`, `.pytest_cache/`,
  `.mypy_cache/`, `.ruff_cache/`, `.venv/`, `venv/`, `*.egg-info/`, `dist/`,
  `build/`.

### 4.2 TypeScript / Next.js

- Strict mode on. No `any`. No `@ts-nocheck`.
- Server Components by default; add `"use client"` only when interactivity is
  required.
- Do not mix static `import` and `await import()` for the same module in
  production code paths.
- Static-export sites on GitHub project Pages: set `basePath: "/<repo>"` and
  `trailingSlash: true`. Verify built HTML bootstraps with the correct base
  href before claiming the deploy works.
- `.gitignore` must include `node_modules/`, `.next/`, `.turbo/`, `dist/`,
  `build/`, `coverage/`, `.pnpm-store/`.

### 4.3 Flutter

- Three-app / multi-app Flutter repos: each app has its own `pubspec.yaml`,
  `lib/`, `web/`, `test/`, `Dockerfile`, and nginx template. Do not merge
  them back into a monolith.
- Widget tests avoid `pumpAndSettle()` when the page has long-lived timers
  (carousels, polling); use bounded pumps.
- Pages deploys for Flutter web: use `--no-web-resources-cdn`, disable the
  service worker in the final bootstrap, confirm `useLocalCanvasKit: true`.
- `.gitignore` must include `.dart_tool/`, `build/`, `.flutter-plugins*`,
  per-app `ios/Pods/`, `android/.gradle/`.

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

Every agent-managed repo ships a `docs/LLM_CHECK.md`. It is the **end-of-round
checklist** the agent runs before declaring a modification round done. See
this repo's [docs/LLM_CHECK.md](docs/LLM_CHECK.md) for the canonical template.

`LLM_CHECK.md` lives at `docs/LLM_CHECK.md`. There is no root-level copy. If
you find one at root, move it in the current commit and update every
reference.

Minimum sections each project's `docs/LLM_CHECK.md` must have:

1. **Common mistakes seen in prior rounds** — concrete, with enough context
   to avoid repeating the mistake.
2. **Round-end checklist** — commands actually run, commands skipped with
   reason, docs path audit, config/env consistency audit, host-port audit,
   unrelated-changes audit, secrets / size / gitignore audit.
3. **Current round log** — append-only list of what this round actually did.

The `docs/LLM_CHECK.md` is read **before finalizing** the round. If a check
fails, fix the underlying issue; do not just remove the check.

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
- **Commit, but do not push by default.** When a round finishes cleanly
  (no known bugs, no outstanding architectural concerns), stage the work
  and commit it locally with a clear message and stop there. Leave `git
  push` to the repo owner unless they explicitly asked you to push this
  round. If the round leaves known bugs, missing tests, or architectural
  concerns that should block a push, call them out in the final message
  and leave the work either uncommitted or on a scratch branch — do not
  quietly ship half-done work.
- Branch discipline:
  - If the repo has any branch other than `main` (release branches, feature
    branches, protected `develop`, a `gh-pages`, etc.), work on a feature
    branch and open a PR; do not commit directly to `main` / `origin/main`.
  - If `main` is the **only** branch **and** the repo has GitHub Actions
    wired up (i.e. CI is the review gate), committing to `main` directly
    is fine. Pushing still follows the commit-without-push default above —
    the owner decides when `main` moves forward on the remote.
- Force-pushing to `main` / `origin/main` is never allowed without explicit
  per-task approval. Pulling `--rebase` to integrate is fine; force-pushing
  is not.
- Before any push: `git diff --cached --stat` (and `git log origin/<branch>..HEAD`
  for already-committed work) to confirm no `.env` files and no > 300 MB
  blobs are in the range. If either appears, unstage / amend the history
  and fix `.gitignore` before you push.

---

## 7. Owner-specific shorthand

Expand these only when encountered:

- **`sync`**: if working tree is dirty, commit all with a sensible
  Conventional Commit message, then `git pull --rebase`; stop on unresolved
  conflicts; otherwise `git push`.
- **"update docs"**: edit `docs/readme.md` (+ `docs/index.md` if the change
  affects architecture) in the same commit as the code change it documents.
  This is the manual version of §2.6; the rule applies whether or not the
  owner says the word.
- **"one-click push"**: use the repo's review-and-push helper if present
  (see `scripts/review-and-push.ps1` in the `index` repo for the pattern).

---

## 8. How to use this template in a new repo

1. Copy `AGENTS.md` into the new repo's root and copy `docs/LLM_CHECK.md`
   into the new repo's `docs/` directory (create `docs/` if it doesn't
   exist yet).
2. Add `CLAUDE.md` at root as a single-line `@AGENTS.md` include; add
   `CODEX.md` as a symlink or include of `AGENTS.md`.
3. Add a `.gitignore` that covers the project's language caches, build
   output, and `.env*` (keeping only `.env.example` / `sample.env`
   trackable). Cross-check against §1.4.
4. Trim §4 down to only the stacks the new repo actually uses.
5. Replace this §1–§3 boilerplate **only** with a short note saying "this
   project inherits the canonical rules from
   `github.com/<owner>/AGENTS.md`; overrides below".
6. Add project-specific sections: repo map, invariants, build/test commands,
   deployment topology, open-work / caution list. If those sections outgrow
   a pointer file, move them into `docs/AGENTS.md` and keep the root
   `AGENTS.md` short.
7. If the repo already has a bloated `AGENTS.md` (or a root `LLM_CHECK.md`,
   `TASK.md`, `tasks.md`), follow the migration policy in §2.4 and §2.5
   before adding new rules.

That is the whole contract. Keep it boring, keep it truthful, keep it short.
