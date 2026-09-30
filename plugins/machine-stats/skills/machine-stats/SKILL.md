---
name: machine-stats
description: Check CPU, RAM and disk usage of a connected BB machine with the `bb machine-stats` CLI. Use when the user asks how loaded a machine is, whether a disk is filling up, or before starting heavy work (builds, test suites, Docker) on a machine.
---

# Machine stats

The Machine Stats plugin reads live CPU, memory and disk figures from any connected BB machine. The same numbers show in the sidebar footer card (the activity icon), which follows the machine of the open thread.

## Commands

| Command | Effect |
| --- | --- |
| `bb machine-stats machines` | List connected machines with their host ids. `(server)` marks the BB server's machine. |
| `bb machine-stats show` | Usage of the server machine. |
| `bb machine-stats show <host-id>` | Usage of one specific machine. |

Add `--json` to either command for machine-readable output.

## Reading the output

CPU is sampled over half a second, so a single reading is noisy. Check the load average next to it for the trend. RAM "used" excludes reclaimable cache (Linux `MemAvailable`, macOS free + inactive pages). Disk percentages match `df`, so root-reserved blocks count as neither used nor free. Only real block devices are listed: tmpfs, overlay, snap loop mounts and boot partitions are skipped.
