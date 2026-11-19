# slice-opencode

SLICE for OpenCode adds one tool, `context_history`, that searches and reads this session's original history after OpenCode has compacted it.

A compaction summary keeps the task moving but drops exact values, quotes and timestamps. With this tool the model can go back to the stored originals instead of guessing, and every result cites native part IDs on 1.x or message and tool call IDs on 2.3.2. It reads only the current session, never writes to it, and leaves compaction to OpenCode.

## Install

On 1.x, add the package to `plugin` in `opencode.json`, in a project or in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["slice-opencode"] }
```

OpenCode installs it from npm on its next start. A bare name installs the latest version once and keeps it; to choose a version, write `slice-opencode@<version>`. The tool asks for OpenCode's `context_history` permission, which is allowed unless your configuration says otherwise.

The source build also supports OpenCode 2.3.2 with its managed service. Add its built package directory to `plugins` in `opencode.json`. Once this support is released, the same field accepts `"slice-opencode"`. For a one-off CLI run, use `opencode service start` first. History is scoped to the current root session. The plugin verifies the service process and excludes the in-flight message. Standalone servers, forked sessions and reverted sessions are outside this scope.

To remove it, delete the entry and restart OpenCode.

## Without npm

Each release is also tagged in Git. With Git installed, `"plugin": ["github:youxi-huang/slice#opencode-v<version>"]` installs the same package; OpenCode resolves the tag again at each start, so it needs the network then.

## More

The [host adapter guide](https://github.com/youxi-huang/slice/blob/main/docs/context-memory/host-adapters.md) covers the APIs it uses, what it does not support and the evidence behind it. SLICE itself is at [github.com/youxi-huang/slice](https://github.com/youxi-huang/slice).
