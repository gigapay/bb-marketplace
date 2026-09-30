# bb-plugin-traefik-stacks

A BB plugin that lists the staging slugs and Traefik services running on the machine behind your thread, and lets you destroy a slug without SSHing in. Click the network icon in the sidebar footer (next to Usage Bar and Machine stats) and a card opens with one row per slug: a status dot, the running/total container count, the stack's age, and a chip per Traefik host (`api`, `app`, `mail`) that opens it in the browser.

## What counts as a slug

Every docker compose project named `staging-<slug>` is a slug, and its `staging-<slug>-app` frontend project is folded into the same row. That's what `worktree-staging.sh` and `create-worktree.sh` produce. Other compose projects show up under "Other services" only when one of their containers has `traefik.enable=true` (the gateway, dev-dashboard, storybook...). Those are read-only: no destroy button.

## Destroying

The trash icon asks for a confirmation, then runs on the target machine:

```
docker compose -p staging-<slug>-app down --volumes --remove-orphans
docker compose -p staging-<slug> down --volumes --remove-orphans
```

It goes by project name from a neutral directory, so it works even when the worktree has already been removed. It's the same as `./worktree-staging.sh destroy`: containers, networks and named volumes (the staging Postgres and Redis data) are gone. The git worktree under `/var/apps` and `/var/apps/runtime/<slug>` stay put, so use `remove-worktree.sh` if you want those gone too. The host only destroys projects it just saw grouped under that slug, so a typo can't reach anything else.

## Which machine

Like Machine stats, the card follows the machine running the open thread, and falls back to the BB server's machine when no thread is open. The machine name is in the status line. Machines without docker show "Docker isn't reachable".

## CLI

```
bb traefik-stacks list [--host <host-id>] [--json]
bb traefik-stacks destroy <slug> --yes [--host <host-id>] [--json]
```

Get host ids from `bb machine-stats machines`.

## Limits

BB keeps one footer disclosure open at a time, across plugins, so opening this card hides the other ones. The card polls every 10 seconds while it's open.
