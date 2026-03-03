# Zulip Knowledge Miner

A TUI-driven tool that points an LLM agent at your Zulip workspace to extract, organize, and persist structured knowledge. The agent reads conversations, identifies decisions, patterns, processes, and key people, and records its findings as persistent lessons with confidence scores and source provenance.

Built on the Connectome agent framework stack as a practical application and dogfooding exercise.

## What it does

- **Reads Zulip**: Connects to your Zulip instance via MCP, browses streams and topics, reads message history
- **Extracts knowledge**: Identifies decisions, processes, recurring patterns, key people, and technical facts
- **Parallel exploration**: Forks subagents to analyze multiple streams/topics concurrently, then synthesizes findings
- **Persistent memory**: Stores extracted knowledge as "lessons" with confidence scores, tags, and source references; surfaces relevant lessons before each inference
- **Produces reports**: Writes analysis reports, team profiles, process maps, and other documents to disk
- **Time-travel**: Chronicle-backed undo/redo, named checkpoints, branch exploration

## Prerequisites

- [Bun](https://bun.sh/) runtime (not Node.js)
- An Anthropic API key
- A Zulip bot account (for API access to your workspace)
- The [Zulip MCP server](https://github.com/antra-tess/zulip_mcp), cloned and built

## Setup

### 1. Install dependencies

```bash
cd zulip-app
bun install
```

### 2. Build the Zulip MCP server

```bash
# Clone alongside the zulip-app directory
git clone https://github.com/antra-tess/zulip_mcp.git ../zulip-mcp
cd ../zulip-mcp
npm install && npm run build
cd ../zulip-app
```

### 3. Configure Zulip credentials

Create a `.zuliprc` file in the zulip-app directory (or wherever you'll run from):

```ini
[api]
email=your-bot@your-org.zulipchat.com
key=your-bot-api-key
site=https://your-org.zulipchat.com
```

You can generate bot credentials in Zulip under **Settings > Your bots**.

### 4. Set environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Bun auto-loads `.env` files, so no additional setup is needed.

Optional variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `claude-opus-4-6` | Model for the main researcher agent |
| `STORE_PATH` | `./data/store` | Chronicle persistent storage location |

### 5. MCPL server configuration

On first run, the app auto-generates `mcpl-servers.json` with the Zulip server entry. You can also create it manually:

```json
{
  "mcplServers": {
    "zulip": {
      "command": "node",
      "args": ["../zulip-mcp/build/index.js"],
      "env": {
        "ZULIP_RC_PATH": "./.zuliprc",
        "ENABLE_ZULIP": "true",
        "ENABLE_DISCORD": "false"
      }
    }
  }
}
```

Additional MCPL servers (e.g., Discord) can be added here or via the `/mcp` commands at runtime.

## Running

```bash
# Interactive TUI (requires a terminal)
bun src/index.ts

# Readline mode (for non-TTY environments)
bun src/index.ts --no-tui

# Piped mode (CI / scripting)
echo "Analyze the #engineering stream for key decisions" | bun src/index.ts

# Dev mode with file watching
bun --watch src/index.ts
```

## Usage

Type natural language requests in the input bar. The agent will browse Zulip, fork subagents for parallel analysis, and report findings:

```
> Analyze the last month of #engineering and extract key architectural decisions

> What processes does the team follow for code review?

> Build a profile of the team — who works on what, who are the key decision makers?

> Read #incidents and create a report on recurring failure patterns
```

The agent writes reports to `./output/` and persists lessons in the Chronicle store.

## Slash Commands

| Command | Effect |
|---------|--------|
| `/help` | List all commands |
| `/status` | Show agent state, branch, queue depth |
| `/lessons` | Show lesson library sorted by confidence |
| `/clear` | Clear conversation display |
| `/undo` | Revert to state before last agent turn |
| `/redo` | Re-apply undone action |
| `/checkpoint <name>` | Save current state as named checkpoint |
| `/restore <name>` | Restore to checkpoint |
| `/branches` | List all Chronicle branches |
| `/checkout <name>` | Switch to named branch |
| `/history` | Show recent message history |
| `/mcp list` | List configured MCPL servers |
| `/mcp add <id> <cmd> [args...]` | Add or overwrite a server |
| `/mcp remove <id>` | Remove a server |
| `/mcp env <id> KEY=VALUE [...]` | Set env vars on a server |
| `/quit` | Exit |

## TUI Controls

| Key | Action |
|-----|--------|
| `Enter` | Send message or command |
| `Tab` | Toggle fleet view (subagent tree) |
| `Ctrl+C` | Exit |

**Fleet view** (when Tab is pressed):

| Key | Action |
|-----|--------|
| Up/Down | Navigate agent tree |
| Enter/Right | Expand/collapse node |
| Left | Collapse node |
| `p` | Peek at running subagent's live stream |
| `Delete` | Stop a running subagent |
| `Esc` | Exit peek mode |
| `Tab` | Return to chat |

## Adding MCPL Servers

The app supports connecting to any MCPL/MCP-compatible server. For example, to add a Discord server:

```bash
# Via slash command
/mcp add discord node --import tsx ../discord-mcpl/src/index.ts --stdio
/mcp env discord DISCORD_TOKEN=your-token-here

# Or edit mcpl-servers.json directly
```

Changes to `mcpl-servers.json` take effect on restart.

Supported server config fields:
- `command` (required), `args`, `env`
- `toolPrefix` — customize tool name prefix (default: server ID)
- `reconnect`, `reconnectIntervalMs` — auto-reconnect on disconnect
- `enabledFeatureSets`, `disabledFeatureSets`

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation including the agent architecture, module system, retrieval pipeline, and framework integration.

## Known issues

- The rollback mechanism is **untested**.
- The lessons-delivery mechanism for bridging pieces of knowledge across long context-distance is not reliable and needs further work.
- There might be occasional freezes due to dropped termination conditions such as silent tool result failures. 

## Dependencies

| Package | Source | Role |
|---------|--------|------|
| `@connectome/agent-framework` | [Anarchid/agent-framework](https://github.com/Anarchid/agent-framework) | Event-driven agent orchestration |
| `@connectome/context-manager` | [Anarchid/context-manager](https://github.com/Anarchid/context-manager) | Context window management and compression |
| `chronicle` | [Anarchid/chronicle](https://github.com/Anarchid/chronicle) | Branchable event store (Rust + N-API) |
| `membrane` | [Anarchid/membrane](https://github.com/Anarchid/membrane) | LLM provider abstraction |
| `@opentui/core` | [npm](https://www.npmjs.com/package/@opentui/core) | Terminal UI (Zig native core) |
| `zulip-mcp` | [antra-tess/zulip_mcp](https://github.com/antra-tess/zulip_mcp) | Zulip data access via MCP |
