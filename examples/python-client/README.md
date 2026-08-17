# Linear Autopilot — Python MCP client

A small, type-hinted **Python** client for the Linear Autopilot
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, built
with the official [MCP Python SDK](https://pypi.org/project/mcp/).

It complements the TypeScript server in this repo (`src/mcp/`) by showing the
**client** side of MCP in Python: launch the server over stdio, complete the
MCP handshake, discover tools, and call one — the same pattern an agent runtime
uses to consume MCP tools.

## What it does

`client.py`:

1. Launches the Autopilot MCP server as a subprocess (`npm run mcp`) and speaks
   MCP to it over **stdio**.
2. Opens a `ClientSession` and performs the MCP handshake (`initialize`).
3. Calls `list_tools()` and prints the server's four read-only tools
   (`list_queue`, `get_agent_status`, `get_costs`, `get_status`).
4. Calls one tool (`get_status` by default) and pretty-prints the text result.

It has type hints throughout, docstrings, and graceful error handling for the
common failure modes (npm not on PATH, server fails to start, API unreachable).

## Prerequisites

- **Python 3.10+** (the SDK and this client use 3.10+ typing).
- **Node.js + npm**, with the repo's dependencies installed so `npm run mcp`
  works. From the repo root:
  ```bash
  npm install
  ```
- The Python SDK:
  ```bash
  cd examples/python-client
  python -m venv .venv && source .venv/bin/activate   # optional but recommended
  pip install -r requirements.txt
  ```

### Live data is optional

The MCP server is a thin, read-only wrapper over the Autopilot **dashboard HTTP
API** (default `http://localhost:3000`). The tools return real data **only when
that dashboard/app is running** (e.g. `npm start` from the repo root).

You do **not** need the dashboard running to try this client:

- The stdio handshake and `list_tools()` always succeed — you will see the four
  tools listed.
- Without the dashboard, the tool call returns the server's agent-readable
  "Could not reach the Autopilot API …" message (with `is_error` set). The
  client prints that message and exits cleanly — the MCP round-trip itself
  worked; there was simply no API to read from.

To point at a non-default API (or supply a token), set the same environment
variables the server documents; the client forwards them to the subprocess:

```bash
export AUTOPILOT_API_URL=http://localhost:3000
export DASHBOARD_TOKEN=your-token-if-configured   # optional
```

## Running

From this directory (`examples/python-client/`):

```bash
python client.py            # lists tools, then calls get_status
python client.py get_costs  # call a different tool by name
```

The client resolves the repo root automatically (two directories up from
`client.py`), so `npm run mcp` runs in the right place regardless of your
current working directory.

## Notes

- **Read-only.** Every tool is annotated `readOnlyHint: true`; this client only
  observes Autopilot and never mutates state.
- **stdio hygiene.** The server keeps stdout clean for the MCP protocol and logs
  diagnostics to stderr, so you may see a `[linear-autopilot-mcp] ready …` line
  on stderr — that is expected. The client launches the server with
  `npm run --silent mcp`: the `--silent` flag suppresses npm's own run banner,
  which would otherwise be written to stdout and corrupt the JSON-RPC channel.
- See [`docs/MCP.md`](../../docs/MCP.md) for the full server/tool reference.
