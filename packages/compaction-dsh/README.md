# slice-dsh

SLICE for DeepSeek Harness adds one tool, `context_history`, that searches and reads this session's original history after DSH has compacted it.

A compaction summary keeps the task moving but drops exact values, quotes and timestamps. With this tool the model can go back to the stored originals instead of guessing, and every result cites DSH's own event IDs. It reads only the current session, never writes to it, and leaves compaction to DSH.

## Install

```sh
dsh plugin --profile <profile> add slice-dsh
```

The profile must be built on DSH's base bundle, which provides the sessions, persistence and tools the plugin needs. The package declares a DSH bundle, so the same command enables it; a profile without hot reload, such as `headless`, picks it up at its next start. For about a day after a release pnpm installs the previous version of a bare name; `slice-dsh@<version>` installs the one you name.

It supports DSH 0.2.1-rc.3 and later 0.2.x releases. DSH refuses it on other versions before anything is downloaded.

If you added a `slice-history` row to the profile's `cordis.patch.yml` for an earlier build, remove that row: the tool refuses to register twice.

To remove the plugin, run `dsh plugin --profile <profile> remove slice-dsh`.

## Without npm

Each release is also tagged in Git: `dsh plugin --profile <profile> add github:youxi-huang/slice#dsh-v<version>` installs the same package.

## More

The [host adapter guide](https://github.com/youxi-huang/slice/blob/main/docs/context-memory/host-adapters.md) covers the APIs it uses, what it does not support and the evidence behind it. SLICE itself is at [github.com/youxi-huang/slice](https://github.com/youxi-huang/slice).
