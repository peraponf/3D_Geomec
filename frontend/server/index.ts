import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 4000;
const JULIA_PROJECT = path.resolve(__dirname, "../../julia_io");
const UPLOAD_DIR = path.resolve(__dirname, "../uploads");
const RESULTS_DIR = path.resolve(__dirname, "../results");

// Ensure directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

const upload = multer({ dest: UPLOAD_DIR });

// Current model state
let currentState: {
  meshPath: string | null;
  material: { E: number; nu: number; rho: number };
  bcs: Array<{ face: string; type: string; values: number[] }>;
  resultsPath: string | null;
} = {
  meshPath: null,
  material: { E: 20e9, nu: 0.25, rho: 2400 },
  bcs: [{ face: "bottom", type: "fixed", values: [0, 0, 0] }],
  resultsPath: null,
};

// --- Helper: run Julia script ---
function runJulia(script: string, wsClient?: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("julia", ["--project=" + JULIA_PROJECT, "-e", script], {
      cwd: JULIA_PROJECT,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const msg = data.toString();
      stdout += msg;
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: "log", message: msg.trim(), level: "info" }));
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString();
      stderr += msg;
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: "log", message: msg.trim(), level: "warning" }));
      }
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Julia process exited with code ${code}`));
      }
    });
  });
}

// --- API Routes ---

// Generate box mesh
app.post("/api/mesh/generate", async (req, res) => {
  const { Lx = 1.0, Ly = 1.0, Lz = 1.0, nx = 10, ny = 10, nz = 10, material, bcs } = req.body;

  const meshPath = path.join(RESULTS_DIR, "mesh.msh");

  const script = `
    include("src/GeomecSolver.jl")
    using .GeomecSolver
    mesh = generate_box_mesh("${meshPath}";
      Lx=${Lx}, Ly=${Ly}, Lz=${Lz},
      nx=${nx}, ny=${ny}, nz=${nz})
    using JSON
    println(JSON.json(Dict(
      "n_nodes" => mesh.n_nodes,
      "n_elements" => mesh.n_elements,
      "path" => mesh.path
    )))
  `;

  try {
    const output = await runJulia(script);
    const jsonLine = output.split("\n").filter(l => l.startsWith("{")).pop();
    const result = jsonLine ? JSON.parse(jsonLine) : { n_nodes: 0, n_elements: 0 };

    currentState.meshPath = meshPath;
    if (material) currentState.material = material;
    if (bcs) currentState.bcs = bcs;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Upload mesh file (Abaqus or GOCAD)
app.post("/api/mesh/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const destPath = path.join(UPLOAD_DIR, file.originalname);
  fs.renameSync(file.path, destPath);

  const mshPath = path.join(RESULTS_DIR, "mesh.msh");

  let script: string;
  if (ext === ".inp") {
    script = `
      include("src/GeomecSolver.jl")
      using .GeomecSolver
      abq = read_abaqus("${destPath}")
      nsets = collect(keys(abq.nsets))
      abaqus_to_msh(abq, "${mshPath}"; bc_nsets=nsets)
      println("{\\"n_nodes\\": $(length(abq.nodes)), \\"n_elements\\": $(length(abq.elements))}")
    `;
  } else if (ext === ".ts") {
    script = `
      include("src/GeomecSolver.jl")
      using .GeomecSolver
      tsurf = read_tsurf("${destPath}")
      tsurf_to_msh(tsurf, "${mshPath}")
      println("{\\"n_nodes\\": $(length(tsurf.vertices)), \\"n_elements\\": $(length(tsurf.triangles))}")
    `;
  } else if (ext === ".sg") {
    script = `
      include("src/GeomecSolver.jl")
      using .GeomecSolver
      sgrid = read_sgrid("${destPath}")
      sgrid_to_msh(sgrid, "${mshPath}")
      println("{\\"n_nodes\\": $(length(sgrid.vertices)), \\"n_elements\\": $(length(sgrid.tetrahedra))}")
    `;
  } else {
    res.status(400).json({ error: `Unsupported file type: ${ext}` });
    return;
  }

  try {
    const output = await runJulia(script);
    const jsonLine = output.split("\n").filter(l => l.startsWith("{")).pop();
    const result = jsonLine ? JSON.parse(jsonLine) : {};
    currentState.meshPath = mshPath;

    if (req.body.material) currentState.material = JSON.parse(req.body.material);
    if (req.body.bcs) currentState.bcs = JSON.parse(req.body.bcs);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Run solver
app.post("/api/solve", async (req, res) => {
  if (!currentState.meshPath) {
    res.status(400).json({ error: "No mesh loaded. Generate or upload a mesh first." });
    return;
  }

  const { E, nu, rho } = currentState.material;
  const resultsPath = path.join(RESULTS_DIR, "results");

  // Build BC strings
  const dirichletTags = currentState.bcs
    .filter(bc => bc.type === "fixed")
    .map(bc => `"${bc.face}"`);
  const dirichletValues = currentState.bcs
    .filter(bc => bc.type === "fixed")
    .map(() => "VectorValue(0.0, 0.0, 0.0)");

  const neumannTags = currentState.bcs
    .filter(bc => bc.type === "traction" || bc.type === "pressure")
    .map(bc => `"${bc.face}"`);
  const neumannValues = currentState.bcs
    .filter(bc => bc.type === "traction" || bc.type === "pressure")
    .map(bc => `VectorValue(${bc.values[0]}, ${bc.values[1]}, ${bc.values[2]})`);

  const script = `
    include("src/GeomecSolver.jl")
    using .GeomecSolver
    using Gridap

    mat = ElasticMaterial(${E}, ${nu}, ${rho})
    result = solve_elasticity(
      "${currentState.meshPath}", mat;
      dirichlet_tags = [${dirichletTags.join(", ")}],
      dirichlet_values = [${dirichletValues.join(", ")}],
      neumann_tags = [${neumannTags.join(", ")}],
      neumann_values = [${neumannValues.join(", ")}],
      body_force = VectorValue(0.0, 0.0, -${rho} * 9.81),
      output_path = "${resultsPath}"
    )
    println("{\\"status\\": \\"done\\", \\"vtk_path\\": \\"${resultsPath}.vtu\\"}")
  `;

  try {
    const output = await runJulia(script);
    currentState.resultsPath = resultsPath + ".vtu";
    const jsonLine = output.split("\n").filter(l => l.startsWith("{")).pop();
    const result = jsonLine ? JSON.parse(jsonLine) : { status: "done" };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Export results
app.get("/api/results/export", (req, res) => {
  const format = req.query.format || "vtk";

  if (!currentState.resultsPath) {
    res.status(400).json({ error: "No results available" });
    return;
  }

  if (format === "vtk") {
    const vtkPath = currentState.resultsPath;
    if (fs.existsSync(vtkPath)) {
      res.download(vtkPath);
    } else {
      res.status(404).json({ error: "VTK file not found" });
    }
  } else {
    res.status(400).json({ error: `Format not supported: ${format}` });
  }
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", julia_project: JULIA_PROJECT });
});

// --- WebSocket for live solver updates ---
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.action === "solve") {
      if (!currentState.meshPath) {
        ws.send(JSON.stringify({ type: "error", message: "No mesh loaded" }));
        return;
      }

      const { E, nu, rho } = currentState.material;
      const resultsPath = path.join(RESULTS_DIR, "results");

      const dirichletTags = currentState.bcs
        .filter(bc => bc.type === "fixed")
        .map(bc => `"${bc.face}"`);
      const dirichletValues = currentState.bcs
        .filter(bc => bc.type === "fixed")
        .map(() => "VectorValue(0.0, 0.0, 0.0)");
      const neumannTags = currentState.bcs
        .filter(bc => bc.type === "traction" || bc.type === "pressure")
        .map(bc => `"${bc.face}"`);
      const neumannValues = currentState.bcs
        .filter(bc => bc.type === "traction" || bc.type === "pressure")
        .map(bc => `VectorValue(${bc.values[0]}, ${bc.values[1]}, ${bc.values[2]})`);

      const script = `
        include("src/GeomecSolver.jl")
        using .GeomecSolver
        using Gridap
        mat = ElasticMaterial(${E}, ${nu}, ${rho})
        result = solve_elasticity(
          "${currentState.meshPath}", mat;
          dirichlet_tags = [${dirichletTags.join(", ")}],
          dirichlet_values = [${dirichletValues.join(", ")}],
          neumann_tags = [${neumannTags.join(", ")}],
          neumann_values = [${neumannValues.join(", ")}],
          body_force = VectorValue(0.0, 0.0, -${rho} * 9.81),
          output_path = "${resultsPath}"
        )
      `;

      try {
        await runJulia(script, ws);
        currentState.resultsPath = resultsPath + ".vtu";
        ws.send(JSON.stringify({ type: "done", results: { vtk_path: currentState.resultsPath } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`3D Geomec server running on http://localhost:${PORT}`);
  console.log(`Julia project: ${JULIA_PROJECT}`);
});
