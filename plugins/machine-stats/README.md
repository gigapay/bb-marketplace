# bb-plugin-machine-stats

A BB plugin that shows how the machine behind your thread is doing, and what's running on it. Click the server icon in the sidebar footer and a compact card opens above it, in the same spot as Usage Bar.

The card has three tabs, and it remembers the last one you opened.

Usage has one bar for CPU, one for RAM, and one per disk. Hover a row for the details (CPU model and load average, available memory, device and mount point).

Processes lists the busiest processes, sorted by CPU or RAM (toggle in the tab). A process running in a docker container shows its compose project and service next to its name (`gig-6565 · django`), so you can tell which slug is eating the machine. Hover a row for the PID and full command line. CPU is a percent of one core, like `top`, so a multithreaded process can pass 100%.

Slugs lists the staging slugs running on the machine's docker engine, with a destroy button per slug, plus the other Traefik-exposed services. Each slug row has a status dot, the running/total container count, the stack's age, and a chip per Traefik host (`api`, `app`, `mail`) that opens it in the browser.

## Which machine

The card follows the machine running the open thread, and shows its name in the status line. With no thread open (home page, settings), it reads the BB server's machine.

## How it reads the numbers

The plugin ships a `bb.host` entry that runs in the target machine's daemon, so everything is measured locally on that machine:

- CPU: `os.cpus()` sampled twice, 500 ms apart, plus the load average.
- RAM: Linux `MemAvailable`, macOS `vm_stat` free + inactive + speculative pages. `os.freemem()` would ignore page cache and make every machine look full.
- Disks: `df -kP`, real block devices only (no tmpfs, overlay, snap loops or `/boot`). On macOS the Data volume replaces the sealed `/` snapshot. Percentages match `df`.
- Processes: on Linux, `/proc/<pid>/stat` sampled twice 500 ms apart, `VmRSS` for memory, and the cgroup for the container. On macOS, `ps`, whose %cpu is a short decaying average.
- Stacks: `docker inspect` on every container, grouped by compose project.

## What counts as a slug

Every docker compose project named `staging-<slug>` is a slug, and its `staging-<slug>-app` frontend project is folded into the same row. That's what `worktree-staging.sh` and `create-worktree.sh` produce. Other compose projects show up under "Other services" only when one of their containers has `traefik.enable=true` (the gateway, dev-dashboard, storybook...). Those are read-only: no destroy button. Machines without docker show "Docker isn't reachable".

## Which slugs are done

For slugs named after a Linear ticket (`gig-5697` is `GIG-5697`), the card checks whether the work behind them has shipped. A green "done" tag means the ticket is Done (or Canceled) and every pull request found for it is merged, so the stack is safe to destroy. Hover it for the details. A yellow "no worktree" tag means the slug's worktree under `/var/apps` is gone but its containers still run.

The check runs on the slug's machine. It reads the ticket with `bb linear show` (so the Linear Issues plugin must be installed with an API key) and the PRs with `gh pr list` in each repository of the "GitHub repositories" setting (default `gigapay/gigapay, gigapay/gigapay-app`). A PR counts when its branch or title names the ticket. Results are cached for five minutes; the refresh button skips the cache.

## Destroying

The trash icon asks for a confirmation, then runs on the target machine:

```
docker compose -p staging-<slug>-app down --volumes --remove-orphans
docker compose -p staging-<slug> down --volumes --remove-orphans
```

It goes by project name from a neutral directory, so it works even when the worktree has already been removed. It's the same as `./worktree-staging.sh destroy`: containers, networks and named volumes (the staging Postgres and Redis data) are gone. The git worktree under `/var/apps` and `/var/apps/runtime/<slug>` stay put, so use `remove-worktree.sh` if you want those gone too. The host only destroys projects it just saw grouped under that slug, so a typo can't reach anything else.

## CLI

```
bb machine-stats machines [--json]
bb machine-stats show [<host-id>] [--json]
bb machine-stats top [--memory] [--host <host-id>] [--json]
bb machine-stats stacks [--cleanup] [--host <host-id>] [--json]
bb machine-stats destroy <slug> --yes [--host <host-id>] [--json]
```

## Limits

Only the open tab polls: usage and processes every 3 seconds, slugs every 10, and only while the card is open and the window is visible. Closed, it costs nothing, and the host worker stops after five idle minutes.

BB keeps one footer disclosure open at a time, across plugins. Opening this card hides Usage Bar's card, which comes back when you close this one.

This plugin replaces Traefik Stacks, which used to be a separate plugin. Uninstall that one if you still have it.
