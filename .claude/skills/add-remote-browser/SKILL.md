---
name: add-remote-browser
description: Wire the Playwright MCP server to a Chrome instance already running on the LAN via the Chrome DevTools Protocol. Drives a real, persistent browser — logged-in tabs survive.
---

# Add Remote Browser (Playwright MCP via CDP)

**When to use this vs `/add-agent-browser`:**
- This skill — there's a long-lived browser already running on another machine (a laptop, a desktop on the LAN, a Chromebox in a corner) and the agent should drive *that* session. Logged-in tabs survive. The container doesn't ship Chromium.
- `/add-agent-browser` — the agent spawns a headless browser on demand inside its own container. No remote dependency.

The skill wires `@playwright/mcp` as a stdio MCP server in an agent group's container and points it at the remote Chrome. The agent gets the full `mcp__playwright__*` tool surface (navigate, click, type, screenshot, evaluate, snapshot, etc.).

**Platform:** the profile-picker step (Phase 3) reads `~/Library/Application Support/Google/Chrome/`, so the primary path is macOS. Brief Linux/Windows guidance is given inline.

## Prerequisites

Before starting, confirm:

- **Outbound internet from the agent container.** First container restart after wiring runs `pnpm dlx @playwright/mcp@<version>`, which fetches the package from the npm registry. Offline containers will fail at MCP startup. If unsure, check that other pnpm-based MCP servers in this group have been working.
- **Network reachability from the container to the Chrome host.** The container has to open a TCP connection to `<HOST>:<PORT>`. Same-host setups: `host.docker.internal` resolves on Docker Desktop (Mac/Windows) only; on Linux Docker use `172.17.0.1` or the host's LAN IP directly. Cross-host: the Chrome machine's IP on a shared LAN, or a tailscale/wireguard address.
- **Admin approval reachable.** Both `ncl` commands in Phase 5 (`config add-mcp-server` and `restart`) are admin-approval gated. The agent group needs an admin reachable via a DM channel to approve them.

## Phase 1: Ask for the host's IP

Ask the user, as a standalone question:

> What is the IP address (or hostname) of the machine running Chrome?
>
> Examples: `192.168.1.42`, `desktop.local`. If Chrome is on the same machine as nanoclaw: `host.docker.internal` (Docker Desktop on Mac/Windows) or `172.17.0.1` (Linux Docker).

Hold the answer as `HOST`.

## Phase 2: Ask for the debug port

Ask the user, as a separate question:

> What port should Chrome listen on for the DevTools protocol? *(default: `9222`)*

Hold the answer as `PORT`. If the user just says "default" or doesn't answer, use `9222`.

## Phase 3: Ask the user to list available Chrome profiles, then pick one

Chrome does **not** expose installed user profiles through the CDP API — there is no `/json/profiles` endpoint. The only reliable way to enumerate them is to look at the profile directory on disk. Tell the user (macOS):

> Run this on the Mac that has Chrome installed, and paste the output back to me:
>
> ```bash
> ls ~/Library/Application\ Support/Google/Chrome/ | grep -E "^(Default|Profile)"
> ```

Linux equivalent (if the user mentions Linux): `ls ~/.config/google-chrome/ | grep -E "^(Default|Profile)"`.
Windows: ask the user to open `chrome://version` in Chrome and read off the "Profile Path" — there's no clean one-liner.

Each line of output is one Chrome profile directory. `Default` is the first profile; subsequent ones are `Profile 1`, `Profile 2`, etc. To translate directory names into the display names the user sees in Chrome's profile switcher, the user can open `chrome://settings/manageProfile` in each profile — but for picking, the directory name is what gets passed to Chrome.

Present the list back as a numbered choice (single-line per option), and ask which one the agent should drive. If they only have one (`Default`), still confirm — they may not want the agent touching their main browsing profile.

Hold the chosen value as `PROFILE_DIR` (literally `Default`, `Profile 1`, etc., including any space).

## Phase 4: Hand the user a copy-pasteable Chrome launch command

Compose the launch command with `HOST`, `PORT`, and `PROFILE_DIR` baked in, and present it to the user. macOS form:

```bash
# Quit Chrome fully first (⌘Q on every window), then run:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=<PORT> \
  --remote-allow-origins=* \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome" \
  --profile-directory="<PROFILE_DIR>"
```

When giving this to the user, substitute the literal `<PORT>` and `<PROFILE_DIR>` values. If `PROFILE_DIR` contains a space (e.g. `Profile 1`), the surrounding double-quotes already handle it — don't escape further.

Linux form (only if the user said they're on Linux):

```bash
google-chrome \
  --remote-debugging-port=<PORT> \
  --remote-allow-origins=* \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/.config/google-chrome" \
  --profile-directory="<PROFILE_DIR>"
```

Then tell the user, in plain terms:

> 1. Make sure all Chrome windows are closed (`⌘Q` on Mac, not just close-window) — Chrome refuses the remote-debugging port if another process is already using that profile.
> 2. Paste the command above into a terminal on the Chrome host. Chrome will open with the `<PROFILE_DIR>` profile and start listening on `<HOST>:<PORT>`.
> 3. Reply "ready" when Chrome is open.

### Why `--remote-allow-origins=*`

Chrome (M108+) rejects the DevTools WebSocket upgrade with `403 Forbidden` when the request's `Origin` header doesn't match an allow-listed origin. Connections from a Playwright client running on a different host (which is the whole point of this skill) fail without it. `*` is the broadest setting — combined with `--remote-debugging-address=0.0.0.0` it makes the port fully open on the LAN segment. If that's too loose for the environment, swap to an exact-origin form like `--remote-allow-origins=http://<HOST>:<PORT>` instead, at the cost of a more brittle setup if the client side ever changes hosts.

### Security caveat — say this before they run the command

`--remote-debugging-address=0.0.0.0` plus `--remote-allow-origins=*` exposes a fully unauthenticated CDP port. Anyone on the network segment that can reach `<HOST>:<PORT>` can drive that browser, including extracting cookies and session tokens for whatever's logged in under `<PROFILE_DIR>`. **Tell the user this explicitly** before they run the command. On a trusted home/office LAN this is usually fine; on public Wi-Fi, a conference network, or a shared coworking LAN, it isn't. For stricter isolation, suggest binding to a tailscale or wireguard interface IP instead of `0.0.0.0`.

### Sanity check from the nanoclaw host (optional but useful)

Once the user says "ready," confirm reachability from the nanoclaw host:

```bash
curl -sS http://<HOST>:<PORT>/json/version
```

That returns a small JSON blob with `Browser`, `webSocketDebuggerUrl`, etc. If it does, wiring will work. If it hangs or returns nothing, fix the network (firewall on the Chrome host, container-to-host routing) before going further — registering the MCP server first will just produce a broken wiring that has to be removed.

For Chrome on the same host as the nanoclaw container: `host.docker.internal` works on Docker Desktop (Mac/Windows) only; on Linux Docker use `172.17.0.1` or the host's LAN IP directly. The container's loopback isn't the host's.

## Phase 5: Register the MCP server (host-side `ncl`)

Run on the nanoclaw host (the machine running `ncl`). Find the target agent group id (filter by display name if you have many groups):

```bash
ncl groups list
```

Then add the MCP server, substituting `<agent-group-id>`, `<HOST>`, and `<PORT>`:

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name playwright \
  --command pnpm \
  --args '["dlx", "@playwright/mcp@0.0.75", "--cdp-endpoint", "http://<HOST>:<PORT>"]'
```

This is an admin-approval-gated write — when you submit it, you'll get a DM with the approval prompt; approve from your channel and the config update applies. Then trigger a restart so the new MCP server is picked up:

```bash
ncl groups restart --id <agent-group-id>
```

Same approval flow — DM, approve, container restarts.

Notes:
- **Version pin.** `@playwright/mcp@0.0.75` is the current stable as of this skill. **Don't use `@latest`** — it bypasses `minimumReleaseAge: 4320` (3 days) on every restart, which is a real supply-chain risk. To track upstream, manually bump to a specific version after it's been published for a few days: `ncl groups config remove-mcp-server --id <agent-group-id> --name playwright`, then re-add Phase 5 with the new version.
- **Idempotent.** If a `playwright` entry already exists in this group's config, the handler overwrites it cleanly — re-running this phase to change the host, port, or pinned version is safe.
- **`pnpm dlx` on each restart.** Containers run with `--rm` and the pnpm store path (`/home/node/.local/share/pnpm/store`) isn't mounted, so the package is re-downloaded every restart. `@playwright/mcp` is small (a few MB), so this adds seconds of overhead, not a problem in practice.
- **CDP URL.** Chrome serves HTTP at `--remote-debugging-port`; Playwright resolves the WebSocket endpoint from `<url>/json/version`. Pass `http://...`, not `ws://...` — `http://` is the documented input.
- **Naming.** `playwright` matches upstream convention — tools surface as `mcp__playwright__navigate`, `mcp__playwright__click`, etc. Pick another name only if the group already has a different `playwright` MCP wired in.

## Phase 6: Wait for the restart to finish

After the `ncl groups restart` approval, the container is killed and respawned.

**First restart takes a few seconds longer than normal — do not interrupt it.** `pnpm dlx` downloads `@playwright/mcp` from the npm registry. Chromium is **not** downloaded: `pnpm-workspace.yaml`'s `onlyBuiltDependencies` allowlist blocks any package's postinstall script, including Playwright's browser-fetch step, and the CDP transport doesn't need a local browser anyway.

To confirm the wiring landed in the group's config:

```bash
ncl groups config get --id <agent-group-id>
```

Look for `mcpServers.playwright` with the `command`/`args` submitted.

## Phase 7: Verify

After the container is back up, exercise the connection from the agent:

```
mcp__playwright__navigate({ url: "https://example.com" })
mcp__playwright__snapshot({})
```

Expected: `navigate` returns successfully, and `snapshot` returns an accessibility tree / DOM summary for `example.com`. On the remote Chrome itself the user should *see* the tab change (or open) — that's the strongest signal the right browser and the right profile are being driven.

Then ask the user:

> Look at the Chrome window on `<HOST>` — do you see example.com in one of the tabs?

If yes: done. The agent now drives that Chrome instance for the rest of the session (and across restarts).

## Troubleshooting

**`ECONNREFUSED <HOST>:<PORT>`** — Chrome isn't listening, or it's bound to `127.0.0.1`. Re-run the Phase 4 launch command and double-check the port. From the nanoclaw host: `curl -sS http://<HOST>:<PORT>/json/version`.

**`getaddrinfo ENOTFOUND <HOST>`** — hostname isn't resolvable from inside the container. Use the IP address instead. `host.docker.internal` only works on Docker Desktop (Mac/Windows); on Linux Docker use `172.17.0.1` or the host's LAN IP.

**`403 Forbidden` on the WebSocket upgrade** — Chrome rejected the connection because the request's `Origin` header isn't on its allow-list. Confirm the launch command includes `--remote-allow-origins=*` (or an exact-origin form). If you used an exact origin, double-check it matches what Playwright's CDP transport actually sends.

**Chrome opens but the debug port isn't listening** — usually means another Chrome process is already running with the same profile. Quit *all* Chrome processes (Activity Monitor → search "Google Chrome" → quit every entry), then rerun the launch command.

**MCP tools missing after restart (`mcp__playwright__*` not in the tool list)** — registration didn't land. Check `ncl groups config get --id <agent-group-id>` for the `playwright` entry. If absent, the approval was rejected — re-run Phase 5 and make sure the admin approves. If present but tools are still missing, check container logs (`logs/nanoclaw.log` and `data/v2-sessions/<group>/<session>/stderr.log`) for `pnpm dlx` install errors.

**Tools work but operate on a different profile than expected** — the launch command was missing `--profile-directory`, or a different `--user-data-dir` was used. Quit Chrome, rerun the Phase 4 command exactly as given.

**`Target page, context or browser has been closed`** — the remote Chrome was quit (or crashed) after Playwright connected. Relaunch Chrome with the Phase 4 command; no MCP re-registration needed, just retry the call.

**`pnpm dlx` fails to install on container start** — usually a transient network problem; `ncl groups restart --id <agent-group-id>` and try again. If it persists, the container's outbound network is misconfigured — check `logs/nanoclaw.log` and re-read the Prerequisites section.

## Removal

When the remote-browser integration is no longer wanted:

```bash
ncl groups config remove-mcp-server --id <agent-group-id> --name playwright
ncl groups restart --id <agent-group-id>
```

Both are admin-approval gated. After approval, the `mcp__playwright__*` tools disappear from the agent's tool list. The remote Chrome is unaffected — quit it manually if the debug port is no longer needed.

## Notes

- **Per agent group.** The wiring is scoped to whichever agent group `--id` points at. Repeat the skill for each group that needs remote-browser access.
- **CDP endpoint is baked into args.** If the remote Chrome moves to a different host or port, re-run Phase 5 with the new URL — the entry overwrites cleanly. The arg list stored in `container_configs.mcp_servers` is literal; there's no env-var indirection today.
- **Profile is baked into Chrome's launch, not into the MCP wiring.** The MCP server connects to whatever profile Chrome was launched with. To switch profiles, quit Chrome, rerun the Phase 4 command with a different `--profile-directory` — no MCP re-registration needed.
- **Bumping the Playwright MCP version.** Treat it like any other pinned dependency: pick a version that's been published for at least a few days (passes `minimumReleaseAge`), `remove-mcp-server`, re-add with the new pin. Don't use `@latest`.

## References

- Upstream MCP server: [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (Microsoft).
- Chrome remote debugging protocol: [Chrome DevTools Protocol — Connecting](https://chromedevtools.github.io/devtools-protocol/).
- `ncl groups config` reference: `src/cli/resources/groups.ts` (and `ncl groups config help`).
- Skill pattern modeled on `/add-github` (host-side `ncl`-driven install with idempotent prerequisites and a pinned version).
