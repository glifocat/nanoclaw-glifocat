# NanoClaw — Agent Instructions

See [CLAUDE.md](CLAUDE.md) for architecture, entity model, key files, and development commands.

## Cursor Cloud specific instructions

### Two package trees

The host (Node + pnpm) and agent-runner (Bun) are separate package trees with separate lockfiles:

- **Host:** `pnpm install --frozen-lockfile` at repo root
- **Agent-runner:** `cd container/agent-runner && bun install --frozen-lockfile`

Do not run `pnpm install` inside `container/agent-runner/` or `bun install` at root.

### Running the CI check suite

The full CI sequence (matches `.github/workflows/ci.yml`):

```bash
pnpm run format:check
pnpm exec tsc --noEmit                                          # host typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit   # container typecheck
pnpm exec vitest run                                             # host tests (257 tests)
cd container/agent-runner && bun test                            # container tests (59 tests)
```

`pnpm run lint` has 6 pre-existing errors and ~81 warnings on trunk — these are known and not CI-gated.

### Starting the host

```bash
pnpm run dev   # tsx hot-reload; requires Docker running
```

The host requires Docker at startup (`docker info` is checked). Without Docker, startup fatals.

### Docker in Cloud Agent VMs

Docker must be installed with `fuse-overlayfs` storage driver and `iptables-legacy` for the nested container environment. The daemon must be started manually (`sudo dockerd &`) before running `pnpm run dev`.

### Container image build — known issue

`./container/build.sh` fails because `corepack enable` inside the `node:22-slim` base image resolves pnpm 11.x, which changed the global bin directory from `$PNPM_HOME` to `$PNPM_HOME/bin`. The Dockerfile's `PATH` only includes `/pnpm`, not `/pnpm/bin`. This is a pre-existing upstream issue; host development, tests, and typechecks all work without a built container image.

### Hello-world flow

To verify the host works end-to-end:

```bash
pnpm exec tsx scripts/init-cli-agent.ts --display-name "Dev" --agent-name "TestAgent"
pnpm run dev &
pnpm run chat hello
```

The CLI message will route through the host. The container spawn will fail without OneCLI/Anthropic credentials, but the routing + session creation confirms the host is operational.
