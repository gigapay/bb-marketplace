See at a glance how busy the machine behind your thread is.

## What you get

- A Machine stats card in the sidebar footer (activity icon), next to Usage Bar.
- Live CPU, RAM and per-disk bars, refreshed every 3 seconds while the card is open.
- Colors that turn amber at 75% and red at 90%.
- A `bb machine-stats` command so agents can check load before heavy work.

## How it works

The card follows the machine running the open thread, and falls back to the BB server's machine when no thread is open. A small host worker on that machine reads the numbers locally (`os.cpus()`, `/proc/meminfo` or `vm_stat`, `df`) and nothing leaves your BB setup.
