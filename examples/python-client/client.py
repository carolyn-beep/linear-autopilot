#!/usr/bin/env python3
"""A minimal Python MCP client for the Linear Autopilot MCP server.

This script demonstrates the client side of the Model Context Protocol (MCP)
using the official MCP Python SDK. It:

  1. Launches the Autopilot MCP server (``npm run mcp``) as a subprocess and
     speaks MCP to it over stdio.
  2. Opens a :class:`~mcp.ClientSession` and performs the MCP handshake.
  3. Lists the tools the server exposes and prints them.
  4. Calls one read-only tool (``get_status`` by default) and pretty-prints
     the text result.

The Autopilot MCP server is a thin, read-only wrapper over the Autopilot
dashboard HTTP API. The tools only return *live* data when that dashboard API
is running (see the README). When it is not reachable, the handshake and
``list_tools`` still succeed; the tool call simply returns the server's
agent-readable "cannot reach the Autopilot API" message (with ``isError``).

Run it with::

    python client.py                 # calls get_status
    python client.py get_costs       # call a different tool

Requires Python 3.10+ and the ``mcp`` package (``pip install -r requirements.txt``).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import CallToolResult, TextContent, Tool

# The MCP server lives in this repository and is started via ``npm run mcp``.
# This file is examples/python-client/client.py, so the repo root is two
# directories up. Resolving it here keeps the client runnable from any cwd.
REPO_ROOT: Path = Path(__file__).resolve().parents[2]

# Default tool to call for the demo. Any of the server's four read-only tools
# works: list_queue, get_agent_status, get_costs, get_status.
DEFAULT_TOOL: str = "get_status"


def build_server_parameters() -> StdioServerParameters:
    """Describe how to launch the Autopilot MCP server over stdio.

    ``AUTOPILOT_API_URL`` (and optionally ``DASHBOARD_TOKEN``) are inherited
    from the current environment so the same configuration documented for
    Claude Desktop / Claude Code applies here.
    """
    # Start from the caller's environment so PATH (needed to find ``npm``) and
    # any AUTOPILOT_API_URL / DASHBOARD_TOKEN overrides are preserved.
    env: dict[str, str] = dict(os.environ)
    env.setdefault("AUTOPILOT_API_URL", "http://localhost:3000")

    # ``--silent`` is important: without it, npm prints a run banner
    # ("> linear-autopilot@1.0.0 mcp") to *stdout*, which corrupts the MCP
    # stdio transport (stdout must carry only JSON-RPC). The server itself is
    # careful to log only to stderr; this suppresses npm's own stdout noise.
    return StdioServerParameters(
        command="npm",
        args=["run", "--silent", "mcp"],
        cwd=str(REPO_ROOT),
        env=env,
    )


def format_tool(tool: Tool) -> str:
    """Render a single tool as a short, readable summary line."""
    description = (tool.description or "").strip().replace("\n", " ")
    # Keep the listing scannable; the full description is available on `tool`.
    if len(description) > 100:
        description = description[:97] + "..."
    return f"  - {tool.name}: {description}"


def render_result(result: CallToolResult) -> str:
    """Extract the text content from a tool result for printing.

    The Autopilot tools always return their payload as a single text block,
    so this joins any text blocks together. Non-text blocks are noted rather
    than silently dropped.
    """
    chunks: list[str] = []
    for block in result.content:
        if isinstance(block, TextContent):
            chunks.append(block.text)
        else:
            chunks.append(f"<non-text content block: {block.type}>")
    return "\n".join(chunks) if chunks else "<empty result>"


async def run(tool_name: str) -> int:
    """Connect to the server, list tools, and call ``tool_name``.

    Returns a process exit code: ``0`` on success (including the case where the
    tool reports it cannot reach the Autopilot API — that is a valid,
    well-formed response), non-zero only if the MCP session itself fails.
    """
    server_parameters = build_server_parameters()

    print(f"Launching Autopilot MCP server: npm run mcp (cwd={REPO_ROOT})")
    print(f"AUTOPILOT_API_URL = {server_parameters.env['AUTOPILOT_API_URL']}\n")

    async with stdio_client(server_parameters) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            # Perform the MCP handshake (protocol/version negotiation).
            init_result = await session.initialize()
            server_info = init_result.server_info
            print(
                f"Connected to '{server_info.name}' v{server_info.version} "
                f"(protocol {init_result.protocol_version})\n"
            )

            # 1. Discover the tools the server exposes.
            tools_result = await session.list_tools()
            print(f"Tools available ({len(tools_result.tools)}):")
            for tool in tools_result.tools:
                print(format_tool(tool))
            print()

            available = {tool.name for tool in tools_result.tools}
            if tool_name not in available:
                print(
                    f"Tool '{tool_name}' is not exposed by the server. "
                    f"Available tools: {', '.join(sorted(available))}",
                    file=sys.stderr,
                )
                return 2

            # 2. Call one tool and pretty-print its text result. These tools
            #    take no arguments.
            print(f"Calling tool '{tool_name}'...\n")
            result = await session.call_tool(tool_name, arguments={})

            print("-" * 60)
            print(render_result(result))
            print("-" * 60)

            if result.is_error:
                # A well-formed error from the tool (e.g. the Autopilot API is
                # down). The MCP round-trip itself succeeded, so this is not a
                # client failure — surface it clearly but exit 0.
                print(
                    "\nNote: the tool returned an error result (see message "
                    "above). This is expected when the Autopilot dashboard API "
                    "is not running.",
                )

    return 0


def main() -> None:
    """Entry point: parse the optional tool name and run the async client."""
    tool_name = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TOOL

    try:
        exit_code = asyncio.run(run(tool_name))
    except FileNotFoundError as error:
        # Raised if `npm` (or the configured command) cannot be found on PATH.
        print(
            f"Could not launch the MCP server: {error}. "
            "Is Node.js/npm installed and on your PATH? "
            f"The client runs 'npm run mcp' in {REPO_ROOT}.",
            file=sys.stderr,
        )
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:  # noqa: BLE001 - top-level friendly handler
        # Covers server-launch failures, handshake errors, and transport drops
        # (e.g. the server process exits before completing the handshake).
        print(
            f"MCP session failed: {type(error).__name__}: {error}\n"
            "Check that the repository dependencies are installed "
            "(npm install) and that 'npm run mcp' works from the repo root.",
            file=sys.stderr,
        )
        sys.exit(1)

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
