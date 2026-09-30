# bb-plugin-machine-stats

A BB plugin that shows CPU, RAM and disk usage of the machine behind your thread. Click the activity icon in the sidebar footer and a compact card opens above it, in the same spot as Usage Bar: one bar for CPU, one for RAM, and one per disk. Hover a row for the details (CPU model and load average, available memory, device and mount point).

## Which machine

The card follows the machine running the open thread, and shows its name in the status line. With no thread open (home page, settings), it reads the BB server's machine.

## How it reads the numbers

The plugin ships a `bb.host` entry that runs in the target machine's daemon, so everything is measured locally on that machine:

- CPU: `os.cpus()` sampled twice, 500 ms apart, plus the load average.
- RAM: Linux `MemAvailable`, macOS `vm_stat` free + inactive + speculative pages. `os.freemem()` would ignore page cache and make every machine look full.
- Disks: `df -kP`, real block devices only (no tmpfs, overlay, snap loops or `/boot`). On macOS the Data volume replaces the sealed `/` snapshot. Percentages match `df`.

The card polls every 3 seconds, but only while it's open and the window is visible. Closed, it costs nothing, and the host worker stops after five idle minutes.

## CLI

```
bb machine-stats machines [--json]
bb machine-stats show [<host-id>] [--json]
```

## Limits

BB keeps one footer disclosure open at a time, across plugins. Opening this card hides Usage Bar's card, which comes back when you close this one.
