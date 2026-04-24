# Maintainer Documentation Audit

Last updated: 2026-04-23

This document is a code-grounded audit of the current repository documentation.

It is written for maintainers, not end users. The goal is to identify which
docs accurately describe the current `main` branch, which ones mix old and new
models, and which ones should no longer be treated as architecture references.

## Scope

- Code review basis:
  - `src/`
  - `container/agent-runner/src/`
  - `setup/`
  - `scripts/`
  - selected tests under `src/`
- Markdown review basis:
  - all `49` `.md` files currently in the repository
- Verification note:
  - `npm test` was not runnable in this checkout because `vitest` is not
    installed in the local environment

## Executive Summary

The current codebase is more coherent than the docs make it appear.

The active runtime on `main` is a host/container architecture with a central DB
plus per-session split DBs, host-owned routing and delivery, and a Bun-based
container poll loop. The strongest sources for understanding current behavior
are the code itself plus a subset of newer docs such as `README.md`,
`docs/build-and-runtime.md`, `docs/db.md`, `docs/db-session.md`, and
`docs/setup-flow.md`.

The main documentation problem is not random inaccuracy. It is layered drift:

- a newer set of docs reflects the current two-DB and module-based model
- a middle layer partially reflects the new model but still contains old schema
  names, old setup assumptions, or old privilege descriptions
- an older layer still describes a pre-current architecture and should not be
  used for system understanding without an explicit historical label

The most important concrete drift is around setup and schema naming.
`setup/register.ts` still uses fields associated with older wiring
documentation, while the runtime path in `src/db/messaging-groups.ts` expects
the newer engagement/access model.

## Current Runtime Model

This section is the maintainer mental model that best matches the code on
`main`.

### Host / container split

The host process is started from `src/index.ts`.

Responsibilities:

- initialize central SQLite DB at `data/v2.db`
- run migrations
- initialize channels
- route inbound events
- manage sessions and wake containers
- poll outbound session state and deliver responses
- sweep stale or orphaned work

The container process is started from
`container/agent-runner/src/index.ts`.

Responsibilities:

- load per-agent container config from `groups/<folder>/container.json`
- construct provider runtime
- poll session `inbound.db`
- write responses and actions to `outbound.db`

### Central DB vs session DBs

The storage model is intentionally split.

Central DB:

- `data/v2.db`
- host-owned
- stores durable system metadata such as agents, messaging groups, wiring,
  destinations, schedules, and cross-session state

Per-session DBs:

- `inbound.db`: host writes, container reads
- `outbound.db`: container writes, host reads
- plus `.heartbeat` file for liveness

This is not an incidental implementation detail. It is the core isolation model
used to avoid SQLite cross-writer problems across host/container boundaries.

### Message lifecycle

The active message path is:

1. A channel adapter emits an inbound event.
2. `src/router.ts` resolves the messaging group, sender identity, agent wiring,
   access policy, and session.
3. The host writes inbound work to the session `inbound.db`.
4. `src/container-runner.ts` wakes or starts the container for the session.
5. The container poll loop reads pending work, invokes the provider, and writes
   outbound messages or system actions to `outbound.db`.
6. `src/delivery.ts` reads `outbound.db`, delivers messages through the
   adapter, and updates host-owned state.

### Capability surface on trunk

Current `main` is narrower than some docs imply.

- Default channel barrel on trunk imports only the CLI channel.
- Container-side providers registered on trunk are `claude` and `mock`.
- Runtime modules on trunk include:
  - approvals
  - interactive
  - scheduling
  - permissions
  - agent-to-agent
  - self-mod

This means some docs that describe a broad multi-channel system are only true as
project intent or branch-installable extension model, not as the default
shipped runtime in this branch.

## Highest-Value Drift Findings

### 1. Setup and runtime schema are not fully aligned

`setup/register.ts` still uses old wiring field names such as:

- `trigger_rules`
- `response_scope`

The active runtime path in `src/db/messaging-groups.ts` and related types uses
newer concepts such as:

- `engage_mode`
- `engage_pattern`
- `sender_scope`
- `ignored_message_policy`

This is the most important code/doc mismatch because it affects maintainer
understanding of what setup is actually expected to produce.

### 2. Some docs still describe `messages.db` and `registered_groups`

That model is no longer the authoritative one for trunk runtime behavior.

Current behavior is centered on:

- `data/v2.db`
- `inbound.db`
- `outbound.db`
- current central schema tables and module-managed state

Docs that still center the system on `messages.db`, `registered_groups`, or old
IPC flows should be treated as stale or historical.

### 3. Privilege and admin language drift exists

Some docs still describe a strong "main group" or older trust model in ways
that do not line up cleanly with the current user/role/access implementation.

Current runtime authorization behavior is influenced by the permissions module,
sender scope, unknown sender policy, approvals, and per-wiring engagement
settings, rather than just a simplistic "main group controls everything" model.

### 4. Group prompt docs are operationally stale

The prompt docs under `groups/` still mention old paths and registration models.
They should not currently be treated as accurate operator references for the
storage or group registration model.

## Documentation Classification

### Authoritative or Mostly Aligned

These are the docs I would trust first when onboarding a maintainer to current
`main`.

#### Root

- `README.md`
- `README_ja.md`
- `README_zh.md`
- `FORK.md`
- `CHANGELOG.md`

Assessment:

- `README*` are broadly aligned with the modern system direction and current
  runtime framing
- `CHANGELOG.md` is useful for history and migration context, not as a sole
  architecture reference
- `FORK.md` is fork-local and intentionally scoped

#### Core docs

- `docs/build-and-runtime.md`
- `docs/db.md`
- `docs/db-session.md`
- `docs/setup-flow.md`
- `docs/docker-sandboxes.md`
- `docs/skills-as-branches.md`

Assessment:

- these generally reflect the current host/container and split-DB model
- they are good starting points for maintainers
- `docs/skills-as-branches.md` should be treated as extension-system guidance,
  not trunk runtime architecture

#### Module docs

- `src/modules/approvals/project.md`
- `src/modules/approvals/agent.md`
- `src/modules/interactive/project.md`
- `src/modules/interactive/agent.md`
- `src/modules/self-mod/project.md`
- `src/modules/self-mod/agent.md`

Assessment:

- these are close to the code and describe current module behavior well
- they are among the least drift-prone docs in the repo

#### Container tool instructions

- `container/agent-runner/src/mcp-tools/core.instructions.md`
- `container/agent-runner/src/mcp-tools/scheduling.instructions.md`
- `container/agent-runner/src/mcp-tools/interactive.instructions.md`
- `container/agent-runner/src/mcp-tools/agents.instructions.md`
- `container/agent-runner/src/mcp-tools/self-mod.instructions.md`

Assessment:

- these are implementation-adjacent and broadly consistent with the live tool
  model

### Mixed: Useful but Needs Repair

These docs contain real value, but maintainers should read them with care.

#### `CLAUDE.md`

Status: mixed

Why:

- contains useful current maintainer guidance
- still references outdated concepts and paths in places
- includes older assumptions such as `trigger_rules` and some no-longer-current
  file references

Action:

- keep
- split into "current maintainer guide" and "historical notes" or perform a
  focused cleanup pass

#### `docs/db-central.md`

Status: mixed

Why:

- captures important central DB intent
- still includes older schema naming in some examples
- not fully consistent with current `messaging_group_agents` semantics

Action:

- keep
- update schema examples and terminology to match `src/db/schema.ts` and
  `src/db/messaging-groups.ts`

#### `docs/architecture-diagram.md`

Status: mixed

Why:

- much of the system shape is still recognizable
- some ownership, table, and flow descriptions lag current runtime

Action:

- keep if updated soon
- otherwise clearly mark as partially stale

#### `docs/isolation-model.md`

Status: mixed

Why:

- modern and valuable overall
- contains stale entity snippets and some older field naming

Action:

- keep
- refresh the schema examples

#### `docs/SECURITY.md`

Status: mixed

Why:

- still useful as a security intent document
- contains older trust/mount/IPC framing that does not cleanly match the
  current runtime

Action:

- keep
- rewrite the architecture-specific sections against the current container and
  DB ownership model

#### `docs/REQUIREMENTS.md`

Status: mixed-to-historical

Why:

- very useful for original intent and philosophy
- explicitly describes a smaller earlier conceptual model
- not safe as a present-tense implementation reference

Action:

- keep as design-history document
- label it as historical requirements rather than current architecture

#### `docs/setup-wiring.md`

Status: mixed but operationally risky

Why:

- describes real work that happened in the newer architecture
- still embeds older entity model and field names such as `trigger_rules`
- likely to mislead maintainers doing setup work

Action:

- either rewrite promptly or deprecate in favor of `docs/setup-flow.md`

#### `groups/global/CLAUDE.md`

Status: stale

Why:

- references `store/messages.db`, `registered_groups`, and older mount/layout
  assumptions
- no longer matches current trunk storage and registration model

Action:

- rewrite if group prompt docs are still meant to be generated from checked-in
  sources
- otherwise remove from maintainer-facing trust set

#### `groups/main/CLAUDE.md`

Status: stale

Why:

- same issues as `groups/global/CLAUDE.md`
- still frames admin/group management through older DB and IPC flows

Action:

- same as above

### Obsolete as Current Architecture References

These docs may still be useful historically, but I would not use them to
understand or modify the current runtime on `main`.

- `docs/SPEC.md`
- `docs/architecture.md`
- `docs/api-details.md`
- `docs/agent-runner-details.md`

Common issues:

- center the system around older database assumptions
- describe old IPC or control flows
- use outdated schema names
- no longer line up with the current host/container split as implemented

Action:

- either move under a clearly labeled `historical/` area or mark them with a
  prominent historical warning at the top

## Non-Architecture Docs

These were reviewed, but they are not the source of architecture confusion.

- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `CONTRIBUTORS.md`
- `docs/README.md`
- `docs/BRANCH-FORK-MAINTENANCE.md`
- `docs/APPLE-CONTAINER-NETWORKING.md`
- `docs/SDK_DEEP_DIVE.md`
- `docs/ollama.md`
- `repo-tokens/README.md`
- `container/CLAUDE.md`
- `container/skills/*/SKILL.md`

Assessment:

- some may still need normal upkeep
- none of these are the primary cause of maintainer confusion about the runtime
- container skill docs should be read as skill/runtime behavior guidance, not
  as the single source of truth for host architecture

## Maintainer Trust Order

If a maintainer needs to understand current behavior quickly, this is the
recommended order:

1. Code in `src/`, `container/agent-runner/src/`, and `src/db/`
2. `README.md`
3. `docs/build-and-runtime.md`
4. `docs/db.md`
5. `docs/db-session.md`
6. `docs/setup-flow.md`
7. module docs under `src/modules/`
8. `CHANGELOG.md`
9. everything else only after checking whether it is historical

## Recommended Cleanup Plan

### Priority 1: stop maintainers from using stale docs accidentally

- add a historical warning banner to:
  - `docs/SPEC.md`
  - `docs/architecture.md`
  - `docs/api-details.md`
  - `docs/agent-runner-details.md`
- add a stale warning or rewrite for:
  - `groups/global/CLAUDE.md`
  - `groups/main/CLAUDE.md`

### Priority 2: repair operationally important mixed docs

- align `setup/register.ts` with the current runtime schema, or explicitly note
  the compatibility layer if intentional
- update `docs/setup-wiring.md`
- update `docs/db-central.md`
- clean up root `CLAUDE.md`

### Priority 3: consolidate architecture references

- pick one canonical architecture doc
- pick one canonical schema doc
- pick one canonical setup doc
- demote the rest to historical or supplementary references

## Specific Maintainer Notes

### Do not assume channel breadth from docs alone

Some docs correctly describe the project vision or branch-based extension model,
but trunk currently ships a narrower capability set than the most ambitious docs
imply.

### Do not assume setup docs reflect current schema

The most dangerous false confidence comes from docs that look recent but still
embed old field names or old wiring semantics.

### Do not use checked-in group prompt docs as current operator truth

Those docs appear to lag the current storage and registration model and are not
safe as authoritative references without regeneration or rewrite.

## Confidence

Confidence in this audit: high for runtime architecture, moderate-to-high for
doc classification.

Reasons:

- architecture conclusions are grounded primarily in active code paths
- doc classifications were cross-checked against the code model and against
  repeated stale-pattern scans
- operational verification is limited by missing local test dependencies

## Suggested Follow-Up

The next most useful maintainer task would be one of:

1. rewrite the mixed operational docs to match the current schema and setup
   model
2. add explicit historical banners to obsolete docs
3. fix `setup/register.ts` so code and docs stop disagreeing at the setup layer
