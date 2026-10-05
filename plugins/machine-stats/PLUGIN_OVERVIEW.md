See at a glance how busy the machine behind your thread is, and clean up the staging slugs running on it.

## What you get

- A Machine card in the sidebar footer (server icon), next to Usage Bar.
- Four tabs: Usage, Processes, Disk and Slugs.
- CPU and RAM charts over the last 15 minutes, next to the top 3 processes.
- Live CPU, RAM and per-disk bars, refreshed every 3 seconds while the card is open. Colors turn amber at 75% and red at 90%.
- The busiest processes by CPU or RAM, tagged with their docker container and slug.
- Folder sizes you can drill into, filled in by a background scan.
- One row per `staging-<slug>` stack with container health, age and links to its Traefik hosts.
- A "done" tag on slugs whose Linear ticket is Done and whose PRs are all merged, so you know which ones to clean up.
- A destroy button per slug that runs `docker compose down --volumes` on both the backend and frontend projects.
- The other Traefik-exposed services, listed read-only.
- A `bb machine-stats` command so agents can check load before heavy work, and list or destroy slugs.

## How it works

The card follows the machine running the open thread, and falls back to the BB server's machine when no thread is open. A small host worker on that machine reads the numbers locally (`os.cpus()`, `/proc/meminfo` or `vm_stat`, `df`, `docker inspect`) and nothing leaves your BB setup. Destroy re-checks the slug before touching anything and never targets non-staging projects.
