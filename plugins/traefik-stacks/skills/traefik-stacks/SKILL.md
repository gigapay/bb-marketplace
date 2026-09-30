---
name: traefik-stacks
description: List the staging slugs and Traefik-exposed docker services on a BB machine, or destroy a staging slug stack, with the `bb traefik-stacks` CLI. Use when the user asks which staging environments or slugs are running, which Traefik URLs exist, or wants to tear down a staging stack to free resources.
---

# Traefik stacks

The Traefik Stacks plugin reads the docker engine of a connected BB machine. Every compose project named `staging-<slug>` (plus its `staging-<slug>-app` frontend) is a slug. Other compose projects appear only when they're exposed through Traefik, and they can't be destroyed from here.

## Commands

| Command | Effect |
| --- | --- |
| `bb traefik-stacks list` | Slugs and services on the server machine, with running/total containers and Traefik hosts. |
| `bb traefik-stacks list --host <host-id>` | Same, on another machine (`bb machine-stats machines` lists host ids). |
| `bb traefik-stacks destroy <slug> --yes` | `docker compose -p <project> down --volumes --remove-orphans` for the slug's frontend then backend project. |

Add `--json` for machine-readable output.

## Before destroying

Destroy deletes the staging database and Redis volumes. It's irreversible, so confirm with the user first and name the slug you're about to remove. It leaves the git worktree and `/var/apps/runtime/<slug>` in place; `remove-worktree.sh` in the gigapay repo handles those.
