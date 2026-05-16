---
name: add-remote-browser
description: Wire the Playwright MCP server (`@playwright/mcp`) into your agent and connect it to a Chrome instance already running on the local network with `--remote-debugging-port`. The agent drives that remote browser via CDP — no Chromium ships in your container, no headless instance is spawned. Use when you have a long-lived Chrome session on another machine (logged-in tabs, dev profile, etc.) that you want the agent to operate.
---

# Add Remote Browser (Playwright MCP via CDP)

This skill wires `@playwright/mcp` as a stdio MCP server in your agent's container and points it at a Chrome instance running elsewhere on the LAN via the Chrome DevTools Protocol. The agent gets the full `mcp__playwright__*` tool surface (navigate, click, type, screenshot, evaluate, snapshot, etc.) but drives a **real, persistent** browser instead of a fresh container-side headless one.

**When to use this vs `/add-agent-browser`:**
- This skill (`add-remote-browser`) — you have a long-lived browser already running on another machine (your laptop, a desktop on the LAN, a Chromebox in a corner) and you want the agent to drive *that* session. Logged-in tabs survive. The agent doesn't ship Chromium.
- `/add-agent-browser` — you want the agent to spawn a headless browser on demand inside its own container. No remote dependency.

**Platform:** the profile-picker step (Phase 2) reads `~/Library/Application Support/Google/Chrome/`, so the primary path is macOS. Brief Linux/Windows guidance is given inline.

## Phase 1: Ask for the host's IP

Ask the user, as a standalone question:

> What is the IP address (or hostname) of the machine running Chrome?
>
> Examples: `192.168.1.42`, `desktop.local`, or `host.docker.internal` if Chrome is on the same machine as nanoclaw.

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
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome" \
  --profile-directory="<PROFILE_DIR>"
```

When you give this to the user, substitute the literal `<PORT>` and `<PROFILE_DIR>` values. If `PROFILE_DIR` contains a space (e.g. `Profile 1`), the surrounding double-quotes already handle it — don't escape further.

Linux form (only if the user said they're on Linux):

```bash
google-chrome \
  --remote-debugging-port=<PORT> \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/.config/google-chrome" \
  --profile-directory="<PROFILE_DIR>"
```

Then tell the user, in plain terms:

> 1. Make sure all Chrome windows are closed (`⌘Q` on Mac, not just close-window) — Chrome refuses the remote-debugging port if another process is already using that profile.
> 2. Paste the command above into a terminal on the Chrome host. Chrome will open with your `<PROFILE_DIR>` profile and start listening on `<HOST>:<PORT>`.
> 3. Reply "ready" when Chrome is open.

### Security caveat — say this before they run the command

`--remote-debugging-address=0.0.0.0` exposes a fully unauthenticated CDP port. Anyone on the network segment that can reach `<HOST>:<PORT>` can drive that browser, including extracting cookies and session tokens for whatever's logged in under `<PROFILE_DIR>`. **Tell the user this explicitly** before they run the command. On a trusted home/office LAN this is usually fine; on public Wi-Fi, a conference network, or a shared coworking LAN, it isn't. For stricter isolation, suggest binding to a tailscale or wireguard interface IP instead of `0.0.0.0`.

### Sanity check from the agent container (optional but useful)

Once the user says "ready," if you have a shell in the agent's container, confirm reachability:

```bash
curl -sS http://<HOST>:<PORT>/json/version
```

That returns a small JSON blob with `Browser`, `webSocketDebuggerUrl`, etc. If it does, wiring will work. If it hangs or returns nothing, fix the network (firewall on the Chrome host, container-to-host routing) before going further — registering the MCP server first will just produce a broken wiring you then have to remove.

For a container on the same host as Chrome: use `host.docker.internal` (Docker Desktop) or `172.17.0.1` (Linux Docker) instead of `127.0.0.1` — the container's loopback isn't the host's.

## Phase 5: Register the MCP server

Call `add_mcp_server` (one of your self-mod MCP tools):

```
add_mcp_server({
  name: "playwright",
  command: "pnpm",
  args: [
    "dlx",
    "@playwright/mcp@latest",
    "--cdp-endpoint",
    "http://<HOST>:<PORT>"
  ]
})
```

This is fire-and-forget — admin approval is requested, and on approve the host updates your container config and restarts your container. You'll be notified when approval is granted or rejected.

Notes:
- `pnpm dlx` is the standard wrapper for one-shot npm MCP servers (matches `/CLAUDE.md`'s module-self-mod guidance). First launch downloads `@playwright/mcp` into pnpm's content-addressable cache; subsequent restarts reuse the cached copy.
- The CDP URL is the Chrome debug-port URL — Chrome serves HTTP at `--remote-debugging-port`, and Playwright resolves the WebSocket endpoint from `<url>/json/version`. Don't pass `ws://...` directly; the `http://` form is the documented input.
- Naming the server `playwright` is the upstream convention — tools surface as `mcp__playwright__navigate`, `mcp__playwright__click`, etc. Pick another name only if you already have a different `playwright` MCP wired in this group.

## Phase 6: Wait for restart

After admin approval, your container is restarted automatically — you do not need to call any restart tool yourself. You'll receive a chat message when the restart completes; resume the conversation from there.

To confirm the wiring landed in your group's config (host-side):

```bash
ncl groups config get
```

Look for `mcpServers.playwright` with the `command`/`args` you submitted.

## Phase 7: Verify

After the container is back up, exercise the connection:

```
mcp__playwright__navigate({ url: "https://example.com" })
mcp__playwright__snapshot({})
```

Expected: `navigate` returns successfully, and `snapshot` returns an accessibility tree / DOM summary for `example.com`. On the remote Chrome itself you should *see* the tab change (or open) — that's the strongest signal you're driving the right browser and the right profile.

Then ask the user:

> Look at the Chrome window on `<HOST>` — do you see example.com in one of the tabs?

If yes: done. Tell them the agent now drives that Chrome instance for the rest of the session (and across restarts).

## Troubleshooting

**`ECONNREFUSED <HOST>:<PORT>`** — Chrome isn't listening, or it's bound to `127.0.0.1`. Re-run the Phase 4 launch command and double-check the port. From your container shell: `curl -sS http://<HOST>:<PORT>/json/version`.

**`getaddrinfo ENOTFOUND <HOST>`** — hostname isn't resolvable from inside the container. Use the IP address instead, or `host.docker.internal` if Chrome is on the Docker host.

**Chrome opens but the debug port isn't listening** — usually means another Chrome process is already running with the same profile. Quit *all* Chrome processes (Activity Monitor → search "Google Chrome" → quit every entry), then rerun the launch command.

**MCP tools missing after restart (`mcp__playwright__*` not in the tool list)** — registration didn't land. Check `ncl groups config get` for the `playwright` entry. If absent, the approval was rejected — re-run Phase 5 and ensure the admin approves. If present but tools still missing, check container logs (`logs/nanoclaw.log` and `data/v2-sessions/<group>/<session>/stderr.log`) for `pnpm dlx` install errors.

**Tools work but operate on a different profile than expected** — the launch command was missing `--profile-directory`, or a different `--user-data-dir` was used. Quit Chrome, rerun the Phase 4 command exactly as given.

**`Target page, context or browser has been closed`** — the remote Chrome was quit (or crashed) after Playwright connected. Relaunch Chrome with the Phase 4 command; no MCP re-registration needed, just retry the call.

**`pnpm dlx` fails to install on container start** — usually a transient network problem on first launch; restart the container. If it persists, the container's outbound network or pnpm cache is misconfigured — check `logs/nanoclaw.log`.

## Removal

When you no longer want the remote-browser integration:

```bash
ncl groups config remove-mcp-server --id <group-id> --name playwright
```

(From inside the container, `--id` auto-fills.) This triggers a config update and container restart, after which the `mcp__playwright__*` tools disappear. The remote Chrome is unaffected — quit it manually if you no longer need the debug port open.

## Notes

- **Per agent group.** This wiring is scoped to the agent group whose container called `add_mcp_server`. Repeat the skill from each group you want to give browser access.
- **CDP endpoint is baked into args.** If the remote Chrome moves to a different host or port, you have to remove and re-add the MCP server with the new URL — the entry stored in `container_configs.mcp_servers` is the literal arg list. There's no env-var indirection today.
- **Profile is baked into Chrome's launch, not into the MCP wiring.** The MCP server connects to whatever profile Chrome was launched with. To switch profiles, quit Chrome, rerun the Phase 4 command with a different `--profile-directory`, and you're done — no MCP re-registration needed.
- **Playwright MCP version.** `@latest` is convenient for tracking upstream but means a fresh `pnpm dlx` install on each container restart could fetch a newer version mid-session if a new release was published. Pin to a known version (e.g. `@playwright/mcp@<x.y.z>`) once you've confirmed a release works for your use.

## References

- Upstream MCP server: [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (Microsoft).
- Chrome remote debugging protocol: [Chrome DevTools Protocol — Connecting](https://chromedevtools.github.io/devtools-protocol/).
- Self-mod tool reference: `container/agent-runner/src/mcp-tools/self-mod.ts` (`add_mcp_server`).
- Skill pattern modeled on `/add-ollama-tool` (instructions-only) and `/add-atomic-chat-tool` (MCP-server wiring).
