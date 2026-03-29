# 3D Geomec — Geomechanics Stress/Strain Modeling Platform

A multi-agent geomechanics modeling application for 3D stress/strain analysis, built with **Gridap.jl** (Julia FEM solver), **Node.js/React** (web interface), and **Three.js** (3D visualization).

Built entirely through conversational AI pair-programming with **Claude Code (Opus 4)** over a single extended session.

---

## Features

### Mesh Input (5 methods)
- **Simple Box** — parametric box mesh via Gmsh
- **Templates** — Borehole (Kirsch quarter-model) and Eshelby Inclusion (full 2D) with automatic mesh refinement near boundaries
- **Draw 2D** — Fabric.js canvas for drawing domains, holes, and inclusions with boolean operations
- **Image Trace** — upload a geological cross-section image as background, trace geometry on top
- **File Upload** — Abaqus `.inp` and SKUA-GOCAD `.sg/.ts/.vo` parsers with partition support

### 3D Viewer
- Server-side boundary surface extraction (handles 10M+ element meshes)
- Partition visualization with color-coded regions and toggle controls
- Node set display with colored point overlays
- Cross-section cutting plane (X/Y/Z axis, draggable position, flip direction)
- Z-up geological orientation
- Wireframe toggle, orbit controls, XYZ gizmo

### Solver
- Gridap.jl 3D linear elasticity (Hooke's law)
- Stress tensor (σ_xx, σ_yy, σ_zz, τ_xy, τ_xz, τ_yz)
- Strain tensor, principal stresses, Von Mises
- VTK export for ParaView
- Material presets (Sandstone, Shale, Limestone, Granite)

### Pre-Run Validation
- Live checklist: mesh status, material property validation, BC completeness
- Physical range checks (E > 0, 0 < ν < 0.5, density range)
- Boundary condition warnings (missing fixed BC, zero loads)

---

## Architecture

### Multi-Agent Design

The project is architected as a multi-agent system using the **Claude Agent SDK**:

| Agent | Role | Stack |
|-------|------|-------|
| **Planner** | Decomposes requests into dev tasks, routes to specialists | — |
| **Input/Mesh Agent** | Mesh generation (Gmsh), Abaqus/GOCAD parsing | Julia |
| **Solver Agent** | Gridap FEM stress/strain simulations | Julia |
| **Interface Agent** | Web UI, 3D visualization, API routes | Node.js/React |
| **Reviewer** | Validates mesh quality, BCs, material props, results | Domain knowledge |

### Tech Stack

```
├── julia_io/          # Julia backend
│   ├── src/
│   │   ├── GeomecSolver.jl       # Main module
│   │   ├── mesh.jl               # Box mesh generator (Gmsh)
│   │   ├── materials.jl          # Material definitions + Lamé parameters
│   │   ├── elasticity.jl         # Gridap 3D linear elasticity solver
│   │   ├── abaqus_reader.jl      # Abaqus .inp parser
│   │   ├── abaqus_to_gridap.jl   # Abaqus → Gmsh converter
│   │   ├── gocad_reader.jl       # SKUA-GOCAD parser (TSurf/Voxet/SGrid)
│   │   ├── gocad_to_gridap.jl    # GOCAD → Gmsh converter
│   │   ├── mesh_export.jl        # Server-side boundary extraction (2D/3D)
│   │   └── geometry_templates.jl # Borehole/Eshelby template generators
│   └── examples/                 # Test cases and sample files
│
├── frontend/          # Node.js web application
│   ├── src/
│   │   ├── app/                  # Next.js pages
│   │   └── components/
│   │       ├── ModelSetup.tsx     # Mesh source, materials, BCs, validation
│   │       ├── Viewer3D.tsx      # Three.js 3D viewer with partition/nset sidebar
│   │       ├── GeometryDrawing.tsx # Fabric.js 2D drawing canvas
│   │       ├── RunManager.tsx    # Solver control + WebSocket logs
│   │       ├── ResultsPanel.tsx  # Stress/strain results + export
│   │       └── MeshPreview.tsx   # Mesh preview component
│   └── server/
│       └── index.cjs             # Express API ↔ Julia bridge
│
├── agents/            # Multi-agent orchestration definitions
│   ├── planner.py
│   ├── mesh_agent.py
│   ├── solver_agent.py
│   ├── interface_agent.py
│   ├── reviewer.py
│   └── orchestrator.py           # Claude Agent SDK wiring
```

---

## Quick Start

### Prerequisites
- **Julia 1.9+** — [Download](https://julialang.org/downloads/)
- **Node.js 18+** — [Download](https://nodejs.org/)
- **Git** — for cloning the repo

### Install (Linux / macOS)

```bash
git clone https://github.com/peraponf/3D_Geomec.git
cd 3D_Geomec

# Julia dependencies
cd julia_io
julia --project=. -e 'using Pkg; Pkg.instantiate()'

# Node.js dependencies
cd ../frontend
npm install
```

### Install (Windows)

```powershell
git clone https://github.com/peraponf/3D_Geomec.git
cd 3D_Geomec

# Julia dependencies
cd julia_io
julia --project=. -e "using Pkg; Pkg.instantiate()"

# Node.js dependencies
cd ..\frontend
npm install
```

> **Note for Windows users**: No admin rights needed. Julia and Node.js can both be installed per-user. No Docker required.

### Run (Linux / macOS)

Open two terminal tabs:

```bash
# Terminal 1: Express backend (port 4000)
cd frontend
node server/index.cjs

# Terminal 2: Next.js frontend (port 3000)
cd frontend
npx next dev
```

### Run (Windows — PowerShell)

Open two PowerShell windows:

```powershell
# PowerShell 1: Express backend (port 4000)
cd frontend
node server\index.cjs

# PowerShell 2: Next.js frontend (port 3000)
cd frontend
npx next dev
```

### Run (Windows — single command)

```powershell
cd frontend
npx concurrently "node server\index.cjs" "npx next dev"
```

Open **http://localhost:3000** in your browser.

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Julia package errors | Run `julia --project=. -e "using Pkg; Pkg.resolve(); Pkg.instantiate()"` in `julia_io/` |
| Port 3000/4000 in use | Kill existing: `lsof -ti:3000 \| xargs kill` (Linux) or `netstat -ano \| findstr :3000` then `taskkill /PID <pid> /F` (Windows) |
| First mesh generation slow | Normal — Julia compiles on first run (~15-30s). Subsequent calls are fast. |
| Upload not working | Ensure backend is running on port 4000. Check `http://localhost:4000/api/health` |

---

## How It Was Built — Claude Code Production Experience

This entire project was built in a single extended conversation with **Claude Code (Opus 4)**, Anthropic's CLI-based AI coding assistant. Below is a transparent account of the process, including what worked, what didn't, and how Claude's memory and tool systems contributed.

### Session Overview

- **Duration**: ~6 hours of active development across one session
- **Model**: Claude Opus 4.6 (1M context)
- **Tools used**: Claude Code CLI with Bash, Read, Write, Edit, Grep, Glob, Agent (sub-agents), TaskCreate/TaskUpdate, WebSearch
- **Lines of code produced**: ~5,000+ across Julia, TypeScript, JavaScript

### Claude's Memory System

Claude Code maintains persistent memory across conversations. The following memories were active during this build:

**User memories:**
- User is a petrophysics engineer in oil & gas, focused on well log interpretation
- Prefers files in `~/Documents/` with dedicated folders (not Desktop)
- Wants blanket auto-approval for all tools — no repeated permission prompts

**Project memories:**
- Previous attempt with Paperclip AI orchestration was paused (didn't work)
- This project superseded it with Gridap.jl + Node.js approach
- Scope: stress/strain only, no Docker/MOOSE (no admin rights)

**Feedback memories:**
- Permission prompts break flow — resolved by fixing `~/.claude/settings.json`

### Development Flow

1. **Architecture Design** (conversational)
   - Started with a CEO/VP agent hierarchy — user corrected: "CEO doesn't assign tasks, agents need to write code"
   - Redesigned around tech stacks (Julia, Python, Node.js) instead of domain roles
   - User narrowed scope from general subsurface to geomechanics stress/strain only
   - Dropped MOOSE (Docker needed admin rights) → Gridap.jl as sole solver

2. **Phase 1: Gridap Solver** — Built and tested in ~20 minutes
   - Box mesh generator, material definitions, 3D linear elasticity solver
   - Validated against analytical uniaxial compression solution

3. **Phase 2: Abaqus Parser** — Built and tested in ~15 minutes
   - .inp file parser (NODE, ELEMENT, NSET, ELSET, MATERIAL, BOUNDARY)
   - Converter to Gmsh .msh format for Gridap consumption
   - One type bug (SubString vs String) — fixed in 1 iteration

4. **Phase 3: GOCAD Parser** — Built and tested in ~15 minutes
   - TSurf, Voxet, SGrid parsers
   - Region/partition extraction from vertex properties

5. **Phase 4: Node.js Frontend** — Built in ~30 minutes
   - Next.js + React + TypeScript + Tailwind
   - Three.js 3D viewer (react-three-fiber)
   - Express API server bridging UI ↔ Julia

6. **Iteration Cycles** (majority of time)
   - Upload not working → Next.js proxy aborting multipart uploads → switched to direct port 4000
   - Julia E2BIG error → scripts too long for OS argument limit → write to temp files
   - Mesh rendering incorrect → rewrote boundary extraction with proper face winding
   - Permission prompts → old rule in global settings.json conflicting with project settings
   - Quad meshing → Gmsh recombine issues → reverted to triangles per user request
   - 2D vs 3D → user wanted pure 2D for borehole/Eshelby, 3D only for imported meshes

### What Worked Well

- **Sub-agents for parallel research**: Launched Explore agent for codebase analysis and claude-code-guide agent for SDK docs simultaneously
- **Task tracking**: TaskCreate/TaskUpdate provided visible progress to the user
- **Incremental testing**: Each phase tested via curl before UI integration
- **Memory persistence**: User preferences (file locations, permissions) carried across the session

### What Required Multiple Iterations

- **Gmsh node ordering**: Different between Gmsh, Gridap, and Abaqus — boundary face extraction needed 3 rewrites
- **Permission system**: User added rules via `/permissions` but they went to different config files (global vs project)
- **Next.js proxy**: Silently aborting large uploads with no error — took debugging server logs to find
- **Quad meshing**: Gmsh's recombine algorithms don't reliably produce 100% quads with boolean geometries

### Tools and Skills Used

| Tool | Purpose | Usage |
|------|---------|-------|
| **Bash** | Run Julia, npm, curl, server management | ~100 calls |
| **Write** | Create new files (Julia modules, React components, server) | ~40 files |
| **Edit** | Modify existing files (fix bugs, add features) | ~80 edits |
| **Read** | Inspect code before editing | ~60 reads |
| **Agent (Explore)** | Deep codebase analysis of existing petrophys library | 1 call |
| **Agent (claude-code-guide)** | Research Claude Agent SDK APIs | 1 call |
| **TaskCreate/Update** | Track progress across 26 tasks | ~50 calls |
| **Grep/Glob** | Find code patterns, locate files | ~30 calls |

---

## Examples

### Borehole (Kirsch) Problem
Quarter-model with symmetry BCs, refined mesh near borehole wall:
```
Templates → Borehole → Domain radius: 10m, Borehole radius: 0.5m → Generate
```

### Eshelby Inclusion
Full 2D model with elliptical inclusion (two material partitions):
```
Templates → Eshelby → Semi-axes: 2m x 1m, Angle: 30° → Generate
```

### Large Partitioned Model
Upload `partitioned_model.inp` (3-layer: Shale/Sandstone/Shale):
```
Abaqus .inp → Upload → 3D Viewer shows colored partitions with toggle controls
```

### Custom Geometry (Draw)
```
Draw 2D → Rectangle (domain) → Circle (hole) → Generate Mesh from Drawing
```

---

## License

MIT

---

## Acknowledgments

Built with [Claude Code](https://claude.ai/claude-code) (Anthropic's Opus 4.6 model) as an AI pair-programming experiment in geomechanics software development.
