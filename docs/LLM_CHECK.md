# LLM_CHECK.md — Canonical End-of-Round Checklist

This file is the **reference template** for the `docs/LLM_CHECK.md` that every
project in this owner's workspace should ship. Copy it into a target repo's
`docs/` directory and adapt the project-specific items. The agent reads this
at the end of a modification round **before** declaring the round done.

This file lives at `docs/LLM_CHECK.md`. Do not keep a second copy at repo
root — the root-directory hygiene rule in `AGENTS.md` §1.6 forbids it. If
you find `LLM_CHECK.md` at repo root, the migration step in `AGENTS.md` §2.4
(point 4) applies: move it here and update every reference in the same
commit.

If you are an agent reading this inside the `AGENTS.md` repo itself: there is
no project to verify here; use this as the shape, not as the live checklist.

---

## 1. Common mistakes seen in prior rounds

These are real footguns seen across this owner's repos. Scan this list before
you start a round, and again before you claim it's done.

### 1.1 Reporting

1. Claiming a test or command passed when it was never run in the current
   environment.
2. Reporting partial success as success. Separate verified work from
   unverified work explicitly.
3. Ending a round without preparing a commit message and push command.

### 1.2 Docs and handoff drift

4. Editing code without updating `docs/readme.md` / `docs/index.md` when the
   change affects architecture, deployment, or the project recipe.
5. Leaving `AGENTS.md` claiming a layout that the repo no longer matches
   (e.g. describing a monolith after a three-app split).
6. Documentation that references paths, scripts, or env var names that no
   longer exist.
7. Dropping an agent-authored doc at repo root. Everything except
   `README.md`, `AGENTS.md`, `CLAUDE.md` (single-line `@AGENTS.md` only),
   `CODEX.md`, `VERSION`, `LICENSE`, `.gitignore`, and required build /
   config files belongs under `docs/`. `LLM_CHECK.md` lives at
   `docs/LLM_CHECK.md`, not at root.
8. Renaming a task file without updating its references. If you rename
   `TASK.md` / `tasks.md` to `docs/TODO.md`, every mention in other docs,
   CI scripts, in-code comments, and commit templates must change in the
   same commit.
9. `CLAUDE.md` with content other than `@AGENTS.md`. This file is a pointer,
   not a place to cache notes.

### 1.3 Cleanup

10. Leaving dead links after removing a feature.
11. Removing UI code but forgetting the related settings import/export,
    config schema, or type definitions.
12. Leaving unused dependencies in `package.json` / `pubspec.yaml` /
    `requirements.txt` / `pyproject.toml`.
13. Editing `.gitignore` with OS- or editor-specific noise the project does
    not need, or inadvertently ignoring tracked source.

### 1.4 Infra, deploy, and repository hygiene

14. Assuming a host port (`80`, `443`, `8080`, `5432`, …) is free without
    confirming it on the target machine. You do not know host-machine state
    until you check.
15. Hard-coding `localhost` or `host.docker.internal` for container-to-container
    traffic; in Compose, use the service name.
16. Volume-mounting over a directory that contains baked-in code; this
    produces "random missing package" bugs that look like dependency drift.
17. Wait loops in container scripts with no timeout, or waiting on a tool
    that isn't installed in the image (`nc` in `entrypoint.sh` without
    `netcat` in the build).
18. Parsing `.env` files with naive `source` when values can contain spaces.
19. GitHub project-site Pages deploys that forget the `/<repo>/` base path
    (Next.js `basePath`, mkdocs `site_url`, Flutter `--base-href`).
20. **Staging a real `.env` / `.env.local` / `.env.production` for commit.**
    This is a critical security issue, not a style nit. Only
    `.env.example` / `sample.env` with obvious placeholder values may ship.
21. Staging a file larger than 300 MB without the owner's explicit ask and
    Git LFS (or equivalent) configured. Big blobs pollute history and are
    hard to remove.
22. `.gitignore` missing the project's language caches — `__pycache__/`,
    `node_modules/`, `.venv/`, `.dart_tool/`, `target/`, `.next/`, `.turbo/`,
    `dist/`, `build/`, `coverage/`. Also missing platform-mismatched
    binaries (`.so`, `.dylib`, `.dll`, `.exe`) that aren't a deliberate
    distribution artifact.
23. Committing a cache / build directory from another architecture (e.g.
    Linux `node_modules` shipped from a dev's laptop, Windows
    `__pycache__`). These produce "works on my machine" bugs that only show
    up in CI.

### 1.5 Code shape

24. Module-import-time initialization of vendor SDK clients (OpenAI, Stripe,
    etc.); do it lazily at call time so missing env vars don't break unrelated
    tests or URL imports.
25. Mixing `await import("x")` with static `import ... from "x"` for the
    same module in the same production code path.
26. Using prototype mutation or `Object.defineProperty` on `.prototype` to
    share behavior instead of explicit inheritance / composition.
27. Leaving UI strings with mojibake or placeholder artifacts in shipped
    copy.

### 1.6 Multi-agent safety

28. Touching another agent's in-progress work — unrecognized files, stashes,
    worktrees, branches — in a shared checkout.
29. Auto-stashing (`git pull --rebase --autostash`) without being explicitly
    asked; silently mutating global git state.
30. Scope creep: expanding a bug-fix round into a refactor without checking
    whether the owner wanted that.

---

## 2. Round-end checklist

Run these **in order**. Do not mark the round done until every applicable
item is either confirmed or explicitly called out as skipped-with-reason.

### 2.1 Truthfulness

- [ ] Every command or test I reported as passing was actually executed in
      this environment, and I can name the terminal it ran in.
- [ ] Every command or test I did **not** run is called out explicitly, with
      the reason (environment limitation, missing toolchain, blocked by
      sandbox, etc.).
- [ ] For any bug fix, I can point at the root-cause line in code, not just
      the symptom that disappeared.

### 2.2 Docs and handoff

- [ ] `README.md` still matches reality (quick start, prerequisites, what
      the project is).
- [ ] `docs/readme.md` still describes how the project works, including any
      deployment topology I just changed.
- [ ] `docs/index.md` and `AGENTS.md` reflect any architectural change
      material enough that a new agent would need it next round.
- [ ] If the repo has per-version docs (`docs/versions/<semver>.md`), the
      current round's user-facing changes are captured there.
- [ ] If I created new deploy steps, a matching `docs/deployment/<target>.md`
      exists and names the exact commands.
- [ ] Every agent-authored doc created this round lives under `docs/`
      (unless the owner explicitly asked otherwise). Root contains only the
      files listed in `AGENTS.md` §1.6.
- [ ] `docs/LLM_CHECK.md` exists here; there is no root-level `LLM_CHECK.md`
      copy lingering.
- [ ] `CLAUDE.md` at root contains only `@AGENTS.md` (no other content).
- [ ] If I renamed `TASK.md` / `tasks.md` to `docs/TODO.md` this round,
      every reference in docs, in-code comments, CI scripts, and commit
      templates has been updated in the same commit.
- [ ] If this round is a material change (runtime / deploy target / env var
      / CI step / entry-point script / agent recipe), `README.md`,
      `docs/readme.md`, and the relevant `docs/<area>/` file are updated in
      the **same commit** as the code.

### 2.3 Code hygiene

- [ ] Searched for references to any feature I removed (`rg`), and all
      dangling imports / routes / settings fields are gone.
- [ ] Unused deps removed from the relevant manifest and its lockfile.
- [ ] `.gitignore` ignores only local junk; no tracked source is hidden.
- [ ] `.gitignore` covers the project's language caches and build output
      for every toolchain it uses (Python, Node, Dart, JVM, etc. — see
      `AGENTS.md` §1.4).
- [ ] No `.env` / `.env.local` / `.env.production` / `.env.*` with real
      values is staged. Only `.env.example` / `sample.env` with obvious
      placeholders may ship. Checked with `git diff --cached --name-only`.
- [ ] No single staged file exceeds 300 MB. Checked with
      `git diff --cached --stat` (or `git ls-files -s` + sort) before
      pushing.
- [ ] No platform-mismatched binaries or cross-architecture cache dirs are
      staged.
- [ ] UI strings are plain, intentional, free of mojibake and placeholder
      artifacts.
- [ ] Any new comment explains a non-obvious **why**, not a **what**.

### 2.4 Build / test / lint

Adapt to the repo's stack. Default bar:

- [ ] Type-check / analyze: `npm run typecheck` or `pnpm tsgo` or
      `dart analyze` (mark skipped-with-reason if the toolchain cannot run
      here).
- [ ] Lint / format: `npm run lint`, `pnpm check`, `ruff`, `flake8`,
      `dart format --set-exit-if-changed`.
- [ ] Unit tests: `npm test`, `pnpm test`, `pytest`, `python manage.py
      test`, `flutter test`.
- [ ] Build: `npm run build`, `pnpm build`, `flutter build web
      --no-web-resources-cdn`, `docker compose build --pull --no-cache`
      (only when debugging dependency drift).
- [ ] Integration / smoke: whatever the repo's smoke command is (e.g.
      Notechondria's `pnpm test:parallels:*`, index's `npm run build` +
      visual check).

### 2.5 Infra and deploy sanity

- [ ] Every host port I assigned was explicitly verified for the target
      machine — no assumed-free ports.
- [ ] Container-to-container traffic uses service names, not `localhost`.
- [ ] CI scripts and Dockerfiles agree on invocation syntax, env var names,
      and mounted paths.
- [ ] Pages deploys for project sites use `/<repo>/` as the base path, and
      the built bootstrap was inspected to confirm it.
- [ ] Secrets / tokens / personal data are not committed. Placeholder values
      are obviously fake.

### 2.6 Multi-agent safety

- [ ] No unrelated user changes were reverted, stashed, or force-pushed.
- [ ] No `git worktree` / branch / stash state was created, dropped, or
      switched without explicit approval.
- [ ] Unrecognized files and in-progress branches were left alone.

### 2.7 Handoff

- [ ] Commit message drafted (action-oriented, scoped, Conventional-Commit-ish).
- [ ] Push command prepared (or noted that the round should not be pushed
      yet).
- [ ] `AGENTS.md` / `docs/index.md` updated if any rule or architectural
      invariant changed during the round.
- [ ] If the round materially changes the "how to rebuild this project with
      an LLM" recipe, the relevant section (§2 of the template) is updated.
- [ ] `docs/TODO.md` reflects closed / opened items if the project tracks
      them there.

---

## 3. Current round log

Append, do not rewrite. One bullet per concrete change or decision. Keep
bullets specific: filenames, command names, outcomes.

> _This is the template's own log. Project repos replace this section with
> their real per-round entries._

- 2026-04-13: Initialized the canonical `AGENTS.md` / `LLM_CHECK.md`
  template in the `AGENTS.md` repo, derived from patterns already in use
  across `openclaw`, `Notechondria`, `Leetcode_Checker`, `TestLover`,
  `Sheaf`, and `index`.
- 2026-04-13: Added root-directory hygiene rule (`AGENTS.md` §1.6), secrets
  / 300 MB / cache `.gitignore` rules (§1.4), `docs/TODO.md` rename policy
  (§2.5), material-change docs sync rule (§2.6). Moved `LLM_CHECK.md` from
  repo root to `docs/LLM_CHECK.md`, added `CLAUDE.md` at root as the
  `@AGENTS.md` include, and updated every in-repo path reference.
