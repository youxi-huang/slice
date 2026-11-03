# slice-dsh

SLICE for DeepSeek Harness adds one tool, `context_history`, that searches and reads this session's original history after DSH has compacted it.

A compaction summary keeps the task moving but drops exact values, quotes and timestamps. With this tool the model can go back to the stored originals instead of guessing, and every result cites DSH's own event IDs. The default entry reads only the current session and leaves compaction to DSH. Manual Slice writing is a separate opt-in preview.

## Install

```sh
dsh plugin --profile <profile> add slice-dsh
```

The profile must be built on DSH's base bundle, which provides the sessions, persistence and tools the plugin needs. The package declares a DSH bundle, so the same command enables it; a profile without hot reload, such as `headless`, picks it up at its next start. For about a day after a release pnpm installs the previous version of a bare name; `slice-dsh@<version>` installs the one you name.

It supports DSH 0.2.1-rc.3 and later 0.2.x releases. DSH refuses it on other versions before anything is downloaded.

If you added a `slice-history` row to the profile's `cordis.patch.yml` for an earlier build, remove that row: the tool refuses to register twice.

To remove the plugin, run `dsh plugin --profile <profile> remove slice-dsh`.

## Manual writing preview

On DSH 0.2.1-rc.5, add this to the profile's `cordis.patch.yml` after installing the package:

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: slice-compaction
      name: slice-dsh/compaction
```

`/compact` writes a source-linked note with the session's routed model and reasoning setting. It validates the note and reads the checkpoint back from DSH's durable log. `/compaction-status` reports whether the session is clear or blocked. The package's automatic bundle patch still enables only `context_history`.

This is stage 1: there is **no automatic compaction**. A session that outgrows its model's window fails at the provider until you run `/compact`. Region compaction, forks, seeded sessions and sessions with another engine's compactions are refused. A failed attempt blocks the next request. That rejected message was not sent: run `/compact` successfully, then send the message again.

The structured checkpoint relies on `rawOutput`, a field DSH owns, in the native `compaction/summary` event. The chat and replacement message contain only the rendered note; the Trajectory inspector can show the structured record. A process restart reads the log afresh: a complete, validated checkpoint confirms the commit; an unfinished or invalid attempt remains blocked. An interrupted attempt is never closed by Slice. DSH's resume marker allows a later `/compact` to recover it.

Remove these two profile patch rows to return to `compaction-basic`; a Slice-compacted session still opens under it. Leave the default history entry enabled for retrieval. The [writing brief](https://github.com/youxi-huang/slice/blob/main/docs/context-memory/dsh-writing.md) records the contract and the stage 1 acceptance requirements.

## Without npm

Each release is also tagged in Git: `dsh plugin --profile <profile> add github:youxi-huang/slice#dsh-v<version>` installs the same package.

## More

The [host adapter guide](https://github.com/youxi-huang/slice/blob/main/docs/context-memory/host-adapters.md) covers the APIs it uses, what it does not support and the evidence behind it. SLICE itself is at [github.com/youxi-huang/slice](https://github.com/youxi-huang/slice).
