See and clean up the staging slugs running on your dev machine.

## What you get

- A Traefik stacks card in the sidebar footer (network icon), next to Usage Bar.
- One row per `staging-<slug>` stack with container health, age and links to its Traefik hosts.
- A destroy button per slug that runs `docker compose down --volumes` on both the backend and frontend projects.
- The other Traefik-exposed services, listed read-only.
- A `bb traefik-stacks` command so agents can list and destroy slugs too.

## How it works

A small host worker on the thread's machine reads `docker inspect` and groups containers by compose project. Destroy re-checks the slug before touching anything and never targets non-staging projects.
