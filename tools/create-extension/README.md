# create-bn-ext

Create a standalone bilibili-notify extension with Vite+, TypeScript, tests, Git hooks and GitHub Actions.

Generated projects also include `AGENTS.md`, a `CLAUDE.md` entry, and a `bn-extension-development` skill discoverable through `.agents/skills/` and `.claude/skills/`. The workflow body is shared with the SDK package; its `AGENT_GUIDE.md` and public declarations remain the contract references.

```sh
pnpm create bn-ext@alpha
# Or: npm create bn-ext@alpha
cd my-extension
vp run verify
```

In a terminal, the wizard asks for the project directory, extension ID, GitHub `owner/repo` and display name. Enter accepts the directory/display defaults; invalid IDs and repositories are asked again. Input cancellation leaves no project directory. Information passed as arguments is kept; scripts can provide every required value without prompts:

```sh
vp dlx create-bn-ext@alpha ./my-extension --id example.demo --repository owner/repository --name "Example"
```

`--interactive` explicitly enables prompts when standard input is redirected. Without a terminal, missing required arguments fail immediately. npm/pnpm are launcher alternatives; generated projects use the same Vite+ toolchain. The package name `create-bn-ext` follows the `create-*` initializer convention. Alpha releases need `@alpha`; unqualified `pnpm create bn-ext` becomes available when a version is published to `latest`.

Requires Node 24.15.0+, Git 2.32+ and the global Vite+ CLI. The generated project pins its package manager and tooling, and carries its own lockfile. Use `--sdk file:/path/sdk.tgz --tools file:/path/tools.tgz --offline` to check unpublished local packages; these overrides are for local acceptance and must be removed before sharing the project.

The SDK is the only entry to host APIs. Build settings from the exported Zod schema through `@bilibili-notify/extension/build`; keep runtime side effects in `activate` and the host context. The SDK ships a standalone `DEVELOPMENT.md` author guide for the current `apiVersion: 1` / `apiRevision: 0` contract. The generated README describes the full development and publishing workflow.

The `bn-extension` binary packages ZIPs, checks commit ranges and publishes releases. `vp run release --tag v0.1.0 --dry-run` runs real checks and creates local preview artifacts without contacting GitHub. A real publication requires a clean tagged commit, matching GitHub tag, and a token with repository contents write permission. The tool publishes version ZIP/checksum assets before updating the rolling `bn-marketplace` index, never overwrites version assets, and resumes interrupted drafts on rerun.
