---
name: machine-stats
description: Check CPU, RAM and disk usage of a connected BB machine, list the staging slugs and Traefik-exposed docker services running on it, or destroy a staging slug stack, with the `bb machine-stats` CLI. Use when the user asks how loaded a machine is, whether a disk is filling up, before heavy work (builds, test suites, Docker), or when they ask which staging slugs or Traefik URLs exist or want to tear one down.
---

# Machine stats

The Machine Stats plugin reads live CPU, memory and disk figures and the docker engine of any connected BB machine. The same data shows in the sidebar footer card (the server icon), which follows the machine of the open thread.

## Commands

| Command | Effect |
| --- | --- |
| `bb machine-stats machines` | List connected machines with their host ids. `(server)` marks the BB server's machine. |
| `bb machine-stats show [<host-id>]` | CPU, RAM and disk usage of the server machine, or of one specific machine. |
| `bb machine-stats stacks [--host <host-id>]` | Staging slugs and Traefik services, with running/total containers and Traefik hosts. |
| `bb machine-stats stacks --cleanup [--host <host-id>]` | Same, plus whether each slug's Linear ticket is done and its PRs merged (`READY TO DESTROY`). |
| `bb machine-stats destroy <slug> --yes [--host <host-id>]` | `docker compose -p <project> down --volumes --remove-orphans` for the slug's frontend then backend project. |

Add `--json` to any command for machine-readable output.

## Reading the usage

CPU is sampled over half a second, so a single reading is noisy. Check the load average next to it for the trend. RAM "used" excludes reclaimable cache (Linux `MemAvailable`, macOS free + inactive pages). Disk percentages match `df`, so root-reserved blocks count as neither used nor free. Only real block devices are listed: tmpfs, overlay, snap loop mounts and boot partitions are skipped.

## Stacks

Every compose project named `staging-<slug>` (plus its `staging-<slug>-app` frontend) is a slug. Other compose projects appear only when they're exposed through Traefik, and they can't be destroyed from here.

`--cleanup` only marks a slug ready when its ticket (`gig-5697` is `GIG-5697`) is Done or Canceled and no PR for it is still open. Slugs without a ticket in their name, or whose lookup failed, get no verdict line. Use it to suggest what to clean up, but still ask before destroying anything.

Destroy deletes the staging database and Redis volumes. It's irreversible, so confirm with the user first and name the slug you're about to remove. It leaves the git worktree and `/var/apps/runtime/<slug>` in place; `remove-worktree.sh` in the gigapay repo handles those.
