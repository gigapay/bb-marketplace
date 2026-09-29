# Origin

`host/`, `vendor/` and `contract.ts` are copied from BB's bundled Worktree environment provider, under BB's MIT license (Copyright (c) 2026 Michael Yong). Source: https://github.com/get-bb/bb

- `vendor/` comes from `packages/environment-provider-host/src`, a private workspace package that third-party plugins can't import.
- `host/` and `contract.ts` come from `plugins/environment-git-worktree`.

Local changes are kept small and marked with `// linear-issues:` comments, so the copy is easy to diff against upstream. They add a configurable worktrees folder with readable directory names, and a pre-flight check so a Linear branch name is never reused or reset.
