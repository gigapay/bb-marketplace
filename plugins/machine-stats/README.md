# bb-plugin-machine-stats

A BB plugin that shows how the machine behind your thread is doing, and what's running on it. Click the server icon in the sidebar footer and a compact card opens above it, in the same spot as Usage Bar.

The top half has one bar for CPU, one for RAM, and one per disk. Hover a row for the details (CPU model and load average, available memory, device and mount point).

The bottom half lists the staging slugs running on the machine's docker engine, with a destroy button per slug, plus the other Traefik-exposed services. Each slug row has a status dot, the running/total container count, the stack's age, and a chip per Traefik host (`api`, `app`, `mail`) that opens it in the browser.

## Which machine

The card follows the machine running the open thread, and shows its name in the status line. With no thread open (home page, settings), it reads the BB server's machine.

## How it reads the numbers

The plugin ships a `bb.host` entry that runs in the target machine's daemon, so everything is measured locally on that machine:

- CPU: `os.cpus()` sampled twice, 500 ms apart, plus the load average.
- RAM: Linux `MemAvailable`, macOS `vm_stat` free + inactive + speculative pages. `os.freemem()` would ignore page cache and make every machine look full.
- Disks: `df -kP`, real block devices only (no tmpfs, overlay, snap loops or `/boot`). On macOS the Data volume replaces the sealed `/` snapshot. Percentages match `df`.
- Stacks: `docker inspect` on every container, grouped by compose project.

## What counts as a slug

Every docker compose project named `staging-<slug>` is a slug, and its `staging-<slug>-app` frontend project is folded into the same row. That's what `worktree-staging.sh` and `create-worktree.sh` produce. Other compose projects show up under "Other services" only when one of their containers has `traefik.enable=true` (the gateway, dev-dashboard, storybook...). Those are read-only: no destroy button. Machines without docker show "Docker isn't reachable".

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
bb machine-stats stacks [--host <host-id>] [--json]
bb machine-stats destroy <slug> --yes [--host <host-id>] [--json]
```

## Limits

The stats poll every 3 seconds and the stacks every 10, but only while the card is open and the window is visible. Closed, it costs nothing, and the host worker stops after five idle minutes.

BB keeps one footer disclosure open at a time, across plugins. Opening this card hides Usage Bar's card, which comes back when you close this one.

This plugin replaces Traefik Stacks, which used to be a separate plugin. Uninstall that one if you still have it.
