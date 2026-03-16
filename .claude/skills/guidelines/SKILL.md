---
name: guidelines
description: Load contributor guidelines before starting development on something you plan to contribute. Sets expectations on simplicity, code quality, and contribution workflow.
---

# NanoClaw Contributor Guidelines

Load these guidelines before you start building something you plan to contribute back to NanoClaw. They set expectations so your work gets merged quickly.

## Build First, Contribute Later

This is not a shortcut to develop and ship something in one go. Before you contribute:

1. **Build it** — get it working in your own installation
2. **Use it** — run it for a few days, find the rough edges, iterate
3. **Then contribute** — once it's stable and you've confirmed it works

If you haven't built and used it yet, start there. Come back when it's ready.

## Core Philosophy

**Handle 80-90% of use cases, not the 10% edge cases. Works for 90% of people, 90% of the time.** That's the bar — not 100%, not every edge case, not every platform. The simplest version that covers the common case.

NanoClaw values minimal code that provides maximum value. Don't over-engineer, don't add defensive handling for unlikely scenarios, and don't invest in polished user feedback for uncommon paths — no friendly error messages for misuse, no guidance when someone uses a feature wrong. Let it fail silently and move on.

### What This Means in Practice

- If a command only works in the main group and someone sends it in a non-main group — let it pass silently. Don't add handling that sends back "this only works in the main group."
- If someone sends four messages in half a second and the agent misses one — that's on them. Don't add queuing or debouncing for that edge case.
- If an edge case matters to a specific user, they can adjust their own installation. Contributions should serve the majority.

## The Golden Rule: Value Must Match Lines of Code

The importance of what you're contributing should be proportional to the amount of code it adds.

| Contribution | Acceptable Size |
|---|---|
| Small bug fix or edge case | A few lines |
| Core fix or improvement | < 20-30 lines (unless pre-discussed) |
| New skill (SKILL.md only) | As needed for instructions |
| Large core change | Must be discussed in Discord first |

**Red flags:**
- 300+ lines for a small improvement
- 400+ lines for an edge case fix
- Any PR to core over 30 lines that wasn't discussed beforehand

## What Gets Accepted

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full policy. The short version:

**Source code changes:** Bug fixes, security fixes, simplifications only. Features and enhancements must be skills.

**Skills:** Must be generic enough to be useful to many users. A usage dashboard — great, many people would use it. A smart home connector — too niche. If you're unsure, ask in Discord before building.

Skills are SKILL.md files with **instructions** for Claude to follow, not pre-built code. A skill PR should not modify source files.

## Simplicity Checklist

Before contributing, check your work against these:

- [ ] No handling for edge cases that affect < 10% of users
- [ ] No error messages or user feedback for misuse scenarios — let them fail silently
- [ ] No over-defensive validation for things that can't realistically happen
- [ ] Value matches lines of code — small fix = small diff
- [ ] I've built this, used it, and confirmed it works

## Where to Contribute

### Determine the Right Target

1. **Bug fix or simplification to core?** → PR to `main` on `qwibitai/nanoclaw`
2. **New SKILL.md-only skill?** → PR to `main` on `qwibitai/nanoclaw` (we'll create a branch if needed)
3. **Fix to a channel integration (Telegram, Discord, Slack, WhatsApp, Gmail)?** → PR to that channel's fork (e.g., `qwibitai/nanoclaw-telegram`)
4. **Fix to an existing code-carrying skill?** → PR to that skill's branch on the relevant fork

If you're not sure where something belongs, ask in Discord.

### Branch and Commit Conventions

Branch prefixes: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`

Commit messages follow conventional commits: `type: description` (e.g., `feat: add pdf reader skill`, `fix: scheduler race condition`)

## Before You Start a Large Contribution

If your contribution to core will be more than 20-30 lines, or if you're unsure whether a skill is generic enough:

1. **Discuss it first** — open a thread in Discord or a GitHub issue
2. **Tag maintainers** — get confirmation this is something we actually want
3. **Agree on scope** — align on what's in and what's out before writing code

Taking this step avoids wasted effort on PRs that won't be accepted.

## Testing

- Test your work thoroughly before contributing
- For skills: test on a fresh clone
- For code changes: ensure `npm run build && npm test` passes
- Describe what you tested in your PR

## Next Step

Once you've built, used, and tested your feature — run `/contribute` to package it up and submit a clean PR.
