## Cursor Cloud specific instructions

### Overview

NanoClaw is a personal AI assistant platform with two runtime components:
- **Host** (Node.js 22, pnpm): orchestrates sessions and routes messages
- **Agent-runner** (Bun, inside Docker containers): executes Claude Agent SDK per session

### Development commands

All standard commands are in `package.json` scripts. Quick reference:

| Task | Command | Notes |
|------|---------|-------|
| Host dev server | `pnpm run dev` | Uses tsx hot-reload |
| Host build | `pnpm run build` | TypeScript → `dist/` |
| Host typecheck | `pnpm run typecheck` | `tsc --noEmit` |
| Host lint | `pnpm run lint` | ESLint; pre-existing warnings exist |
| Host tests | `pnpm test` | Vitest |
| Format | `pnpm run format:fix` | Prettier (also the pre-commit hook) |
| Agent-runner typecheck | `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | From repo root |
| Agent-runner tests | `cd container/agent-runner && bun test` | Uses `bun:test` |
| Container image build | `./container/build.sh` | Requires Docker running |

### Gotchas

- **Docker is required for `pnpm run dev`**: The host checks `docker info` at startup and exits fatally if Docker is unavailable. Start dockerd before running the dev server.
- **Agent-runner tests that touch session DBs fail outside containers**: Tests in `container/agent-runner/src/poll-loop.test.ts` and `integration.test.ts` expect `/workspace/inbound.db` and `/workspace/outbound.db` to exist (the path used inside containers). Only the unit-style tests (timezone, session-state, factory) pass on the host.
- **`bun test` vs `pnpm test`**: Host tests use Vitest (Node); container tests use `bun:test`. Don't mix them — Vitest config explicitly excludes `container/agent-runner/`.
- **OneCLI credentials**: Full end-to-end message processing (container spawn) requires OneCLI Agent Vault configured with an Anthropic API key. Without it, the host routes messages but container spawn fails with a 401.
- **Pre-commit hook**: Runs `pnpm run format:fix` (Prettier). Husky is configured.
- **Bun must be on PATH**: After install, ensure `~/.bun/bin` is in PATH for agent-runner commands.
