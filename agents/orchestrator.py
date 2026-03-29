"""Orchestrator — wires all agents together using Claude Agent SDK."""

import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

from agents.planner import AGENT_DEF as PLANNER
from agents.mesh_agent import AGENT_DEF as MESH_AGENT
from agents.solver_agent import AGENT_DEF as SOLVER_AGENT
from agents.interface_agent import AGENT_DEF as INTERFACE_AGENT
from agents.reviewer import AGENT_DEF as REVIEWER


def build_agents() -> dict[str, AgentDefinition]:
    """Build the agent registry from module definitions."""
    registry = {
        "planner": PLANNER,
        "mesh-agent": MESH_AGENT,
        "solver-agent": SOLVER_AGENT,
        "interface-agent": INTERFACE_AGENT,
        "reviewer": REVIEWER,
    }
    return {
        name: AgentDefinition(
            description=defn["description"],
            prompt=defn["prompt"],
            tools=defn["tools"],
        )
        for name, defn in registry.items()
    }


ORCHESTRATOR_PROMPT = """\
You are the orchestrator for a 3D geomechanics multi-agent system.

When you receive a request:
1. Use the **planner** agent to decompose it into tasks
2. Delegate tasks to the appropriate agents:
   - **mesh-agent** for mesh generation (Gmsh), Abaqus .inp parsing, SKUA-GOCAD parsing
   - **solver-agent** for Gridap FEM stress/strain simulations
   - **interface-agent** for Node.js UI and 3D visualization
   - **reviewer** for domain validation (mesh quality, BCs, material props, results)
3. Coordinate results and report back

Project root: /home/pfakcharoenphol/Documents/3D_Geomec/
Julia code: /home/pfakcharoenphol/Documents/3D_Geomec/julia_io/
Frontend: /home/pfakcharoenphol/Documents/3D_Geomec/frontend/
"""


async def run(prompt: str):
    """Run a request through the multi-agent system."""
    agents = build_agents()

    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            system_prompt=ORCHESTRATOR_PROMPT,
            allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
            agents=agents,
            permission_mode="acceptEdits",
        ),
    ):
        if hasattr(message, "result") and message.result:
            print(message.result)
        elif hasattr(message, "content"):
            for block in message.content:
                if hasattr(block, "text"):
                    print(block.text)


async def main():
    import sys
    if len(sys.argv) > 1:
        prompt = " ".join(sys.argv[1:])
    else:
        prompt = input("Enter your request: ")
    await run(prompt)


if __name__ == "__main__":
    asyncio.run(main())
