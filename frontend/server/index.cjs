const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const PORT = 4000;
const JULIA_PROJECT = path.resolve(__dirname, "../../julia_io");
const UPLOAD_DIR = path.resolve(__dirname, "../uploads");
const RESULTS_DIR = path.resolve(__dirname, "../results");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

const upload = multer({ dest: UPLOAD_DIR });

// Current model state
let currentState = {
  meshPath: null,
  material: { E: 20e9, nu: 0.25, rho: 2400 },
  bcs: [{ face: "bottom", type: "fixed", values: [0, 0, 0] }],
  resultsPath: null,
  elsets: null,
  nsets: null,
};

// Run Julia script (writes to temp file to avoid E2BIG)
function runJulia(script, wsClient) {
  return new Promise((resolve, reject) => {
    const scriptFile = path.join(RESULTS_DIR, "_run_" + Date.now() + ".jl");
    fs.writeFileSync(scriptFile, script);
    const proc = spawn("julia", ["--project=" + JULIA_PROJECT, scriptFile], {
      cwd: JULIA_PROJECT,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const msg = data.toString();
      stdout += msg;
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: "log", message: msg.trim(), level: "info" }));
      }
    });

    proc.stderr.on("data", (data) => {
      const msg = data.toString();
      stderr += msg;
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: "log", message: msg.trim(), level: "warning" }));
      }
    });

    proc.on("close", (code) => {
      try { fs.unlinkSync(scriptFile); } catch {}
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Julia exited with code ${code}`));
      }
    });
  });
}

// Generate box mesh
app.post("/api/mesh/generate", async (req, res) => {
  const { Lx = 1.0, Ly = 1.0, Lz = 1.0, nx = 10, ny = 10, nz = 10, material, bcs } = req.body;
  const meshPath = path.join(RESULTS_DIR, "mesh.msh");

  const script = `
    include("${JULIA_PROJECT}/src/GeomecSolver.jl")
    using .GeomecSolver
    mesh = generate_box_mesh("${meshPath}";
      Lx=${parseFloat(Lx).toFixed(6)}, Ly=${parseFloat(Ly).toFixed(6)}, Lz=${parseFloat(Lz).toFixed(6)},
      nx=${parseInt(nx)}, ny=${parseInt(ny)}, nz=${parseInt(nz)})
    println("{\\"n_nodes\\": $(mesh.n_nodes), \\"n_elements\\": $(mesh.n_elements), \\"path\\": \\"${meshPath.replace(/\\/g, "\\\\")}\\"}")
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

// Generate from drawn geometry
app.post("/api/mesh/from-drawing", async (req, res) => {
  const { geometries, h_fine = 0.1, h_coarse = 1.0 } = req.body;
  const meshPath = path.join(RESULTS_DIR, "mesh.msh");
  const geoFile = path.join(RESULTS_DIR, "drawn_geometry.json");

  // Write geometry data to temp file
  fs.writeFileSync(geoFile, JSON.stringify(geometries));

  // Build Julia script that reads the geometry and creates Gmsh mesh
  const script = `
    include("${JULIA_PROJECT}/src/GeomecSolver.jl")
    using .GeomecSolver
    using Gmsh
    using JSON

    geos = JSON.parsefile("${geoFile}")

    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 2)
    gmsh.model.add("drawn_geometry")

    # Create geometry from drawn shapes
    domain_tags = Int[]
    hole_tags = Int[]
    inclusion_tags = Int[]

    for geo in geos
        gtype = geo["type"]
        grole = geo["role"]
        x = Float64(geo["x"])
        y = Float64(geo["y"])

        tag = 0
        if gtype == "rectangle"
            w = Float64(geo["width"])
            h = Float64(geo["height"])
            tag = gmsh.model.occ.addRectangle(x, y, 0.0, w, h)
        elseif gtype == "circle"
            r = Float64(geo["radius"])
            tag = gmsh.model.occ.addDisk(x, y, 0.0, r, r)
        elseif gtype == "ellipse"
            rx = Float64(geo["rx"])
            ry = Float64(geo["ry"])
            tag = gmsh.model.occ.addDisk(x, y, 0.0, rx, ry)
            if haskey(geo, "angle") && abs(Float64(geo["angle"])) > 0.01
                gmsh.model.occ.rotate([(2, tag)], x, y, 0, 0, 0, 1, Float64(geo["angle"]) * pi / 180)
            end
        end

        if tag > 0
            if grole == "domain"
                push!(domain_tags, tag)
            elseif grole == "hole"
                push!(hole_tags, tag)
            elseif grole == "inclusion"
                push!(inclusion_tags, tag)
            end
        end
    end

    # Boolean operations
    if isempty(domain_tags)
        error("No domain geometry drawn")
    end

    domain = [(2, t) for t in domain_tags]

    # Cut holes from domain
    if !isempty(hole_tags)
        holes = [(2, t) for t in hole_tags]
        domain, _ = gmsh.model.occ.cut(domain, holes)
    end

    # Fragment inclusions with domain (keeps both as separate regions)
    if !isempty(inclusion_tags)
        incl = [(2, t) for t in inclusion_tags]
        domain, _ = gmsh.model.occ.fragment(domain, incl)
    end

    gmsh.model.occ.synchronize()

    # Tag physical groups
    surfaces = gmsh.model.getEntities(2)
    if !isempty(inclusion_tags)
        # Identify inclusion vs matrix by area
        for (dim, tag) in surfaces
            mass = gmsh.model.occ.getMass(dim, tag)
            # Small surfaces near inclusions
            xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
            sx, sy = xmax - xmin, ymax - ymin
            total_domain_area = sum(gmsh.model.occ.getMass(2, t) for (_, t) in surfaces)
            if mass < total_domain_area * 0.3
                pg = gmsh.model.addPhysicalGroup(2, [tag])
                gmsh.model.setPhysicalName(2, pg, "Inclusion")
            else
                pg = gmsh.model.addPhysicalGroup(2, [tag])
                gmsh.model.setPhysicalName(2, pg, "Domain")
            end
        end
    else
        for (dim, tag) in surfaces
            pg = gmsh.model.addPhysicalGroup(2, [tag])
            gmsh.model.setPhysicalName(2, pg, "Domain")
        end
    end

    # Tag boundary curves
    curves = gmsh.model.getEntities(1)
    # Get domain bounding box
    all_pts = Float64[]
    for (dim, tag) in surfaces
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
        push!(all_pts, xmin, ymin, xmax, ymax)
    end
    gxmin = minimum(all_pts[1:4:end])
    gymin = minimum(all_pts[2:4:end])
    gxmax = maximum(all_pts[3:4:end])
    gymax = maximum(all_pts[4:4:end])
    tol = min(gxmax - gxmin, gymax - gymin) * 0.01

    for (dim, tag) in curves
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
        if abs(xmin - gxmin) < tol && abs(xmax - gxmin) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag])
            gmsh.model.setPhysicalName(1, pg, "left")
        elseif abs(xmin - gxmax) < tol && abs(xmax - gxmax) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag])
            gmsh.model.setPhysicalName(1, pg, "right")
        elseif abs(ymin - gymin) < tol && abs(ymax - gymin) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag])
            gmsh.model.setPhysicalName(1, pg, "bottom")
        elseif abs(ymin - gymax) < tol && abs(ymax - gymax) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag])
            gmsh.model.setPhysicalName(1, pg, "top")
        end
    end

    # Mesh
    gmsh.option.setNumber("Mesh.Algorithm", 6)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", ${parseFloat(h_fine).toFixed(6)})
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", ${parseFloat(h_coarse).toFixed(6)})
    gmsh.model.mesh.generate(2)

    node_tags, _, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)
    etypes, etags, _ = gmsh.model.mesh.getElements(2)
    n_elements = isempty(etags) ? 0 : sum(length(et) for et in etags)

    gmsh.write("${meshPath}")
    gmsh.finalize()

    println("RESULT_JSON_START")
    println(JSON.json(Dict(
      "n_nodes" => n_nodes,
      "n_elements" => n_elements,
      "nset_names" => ["left", "right", "bottom", "top"]
    )))
    println("RESULT_JSON_END")
  `;

  try {
    const output = await runJulia(script);
    let result;
    const startM = output.indexOf("RESULT_JSON_START");
    const endM = output.indexOf("RESULT_JSON_END");
    if (startM >= 0 && endM >= 0) {
      result = JSON.parse(output.substring(startM + "RESULT_JSON_START".length, endM).trim());
    } else {
      result = { n_nodes: 0, n_elements: 0 };
    }
    currentState.meshPath = meshPath;
    currentState.elsets = null;
    currentState.nsets = null;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Generate from template
app.post("/api/mesh/template", async (req, res) => {
  const { template, params, material, bcs } = req.body;
  const meshPath = path.join(RESULTS_DIR, "mesh.msh");

  let juliaCall;
  if (template === "borehole") {
    const p = params || {};
    juliaCall = `generate_borehole_kirsch("${meshPath}";
      domain_x=${parseFloat(p.domain_x || 10).toFixed(6)},
      domain_y=${parseFloat(p.domain_y || 10).toFixed(6)},
      radius=${parseFloat(p.radius || 0.5).toFixed(6)},
      depth=${parseFloat(p.depth || 1).toFixed(6)},
      h_fine=${parseFloat(p.h_fine || 0.05).toFixed(6)},
      h_coarse=${parseFloat(p.h_coarse || 1.0).toFixed(6)})`;
  } else if (template === "eshelby") {
    const p = params || {};
    juliaCall = `generate_eshelby_inclusion("${meshPath}";
      domain_x=${parseFloat(p.domain_x || 10).toFixed(6)},
      domain_y=${parseFloat(p.domain_y || 10).toFixed(6)},
      semi_a=${parseFloat(p.semi_a || 2).toFixed(6)},
      semi_b=${parseFloat(p.semi_b || 1).toFixed(6)},
      angle=${parseFloat(p.angle || 0).toFixed(6)},
      depth=${parseFloat(p.depth || 1).toFixed(6)},
      h_fine=${parseFloat(p.h_fine || 0.1).toFixed(6)},
      h_coarse=${parseFloat(p.h_coarse || 1.0).toFixed(6)})`;
  } else {
    return res.status(400).json({ error: `Unknown template: ${template}` });
  }

  const script = `
    include("${JULIA_PROJECT}/src/GeomecSolver.jl")
    using .GeomecSolver
    using Gmsh
    mesh = ${juliaCall}
    println("{\\"n_nodes\\": $(mesh.n_nodes), \\"n_elements\\": $(mesh.n_elements)}")
  `;

  try {
    const output = await runJulia(script);
    const jsonLine = output.split("\n").filter(l => l.startsWith("{")).pop();
    const result = jsonLine ? JSON.parse(jsonLine) : { n_nodes: 0, n_elements: 0 };
    currentState.meshPath = meshPath;
    currentState.elsets = null;
    currentState.nsets = null;
    if (material) currentState.material = material;
    if (bcs) currentState.bcs = bcs;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Upload mesh file
app.post("/api/mesh/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const ext = path.extname(file.originalname).toLowerCase();
  const destPath = path.join(UPLOAD_DIR, file.originalname);
  fs.renameSync(file.path, destPath);

  const mshPath = path.join(RESULTS_DIR, "mesh.msh");
  let script;

  if (ext === ".inp") {
    script = `
      include("${JULIA_PROJECT}/src/GeomecSolver.jl")
      using .GeomecSolver
      using JSON
      abq = read_abaqus("${destPath}")
      nset_names = collect(keys(abq.nsets))
      abaqus_to_msh(abq, "${mshPath}"; bc_nsets=nset_names)
      # Output elsets and nsets for partition tracking
      elsets_out = Dict(k => v for (k,v) in abq.elsets)
      nsets_out = Dict(k => v for (k,v) in abq.nsets)
      println("RESULT_JSON_START")
      println(JSON.json(Dict(
        "n_nodes" => length(abq.nodes),
        "n_elements" => length(abq.elements),
        "elsets" => elsets_out,
        "nsets" => nsets_out
      )))
      println("RESULT_JSON_END")
    `;
  } else if (ext === ".ts") {
    script = `
      include("${JULIA_PROJECT}/src/GeomecSolver.jl")
      using .GeomecSolver
      tsurf = read_tsurf("${destPath}")
      tsurf_to_msh(tsurf, "${mshPath}")
      println("{\\"n_nodes\\": $(length(tsurf.vertices)), \\"n_elements\\": $(length(tsurf.triangles))}")
    `;
  } else if (ext === ".sg") {
    script = `
      include("${JULIA_PROJECT}/src/GeomecSolver.jl")
      using .GeomecSolver
      using JSON
      sgrid = read_sgrid("${destPath}")
      sgrid_to_msh(sgrid, "${mshPath}")

      # Extract region-based partitions
      # Re-read file to get region_names
      rnames = String[]
      for line in readlines("${destPath}")
        s = strip(line)
        if startswith(s, "*region_names:")
          raw = strip(replace(s, "*region_names:" => ""))
          global rnames = String[strip(String(n), [' ', ',']) for n in split(raw) if !isempty(strip(n, [' ', ',']))]
          break
        end
      end
      elsets = extract_sgrid_elsets(sgrid; region_names=rnames)

      println("RESULT_JSON_START")
      println(JSON.json(Dict(
        "n_nodes" => length(sgrid.vertices),
        "n_elements" => length(sgrid.tetrahedra),
        "elsets" => elsets,
        "nsets" => Dict{String,Vector{Int}}()
      )))
      println("RESULT_JSON_END")
    `;
  } else {
    return res.status(400).json({ error: `Unsupported file type: ${ext}` });
  }

  try {
    const output = await runJulia(script);
    let result;
    const startM = output.indexOf("RESULT_JSON_START");
    const endM = output.indexOf("RESULT_JSON_END");
    if (startM >= 0 && endM >= 0) {
      const jsonStr = output.substring(startM + "RESULT_JSON_START".length, endM).trim();
      result = JSON.parse(jsonStr);
    } else {
      const jsonLine = output.split("\n").filter(l => l.startsWith("{")).pop();
      result = jsonLine ? JSON.parse(jsonLine) : {};
    }

    currentState.meshPath = mshPath;
    currentState.elsets = result.elsets || null;
    currentState.nsets = result.nsets || null;

    if (req.body.material) currentState.material = JSON.parse(req.body.material);
    if (req.body.bcs) currentState.bcs = JSON.parse(req.body.bcs);

    const nsetNames = result.nsets ? Object.keys(result.nsets) : [];
    const elsetNames = result.elsets ? Object.keys(result.elsets) : [];
    res.json({
      n_nodes: result.n_nodes,
      n_elements: result.n_elements,
      nset_names: nsetNames,
      elset_names: elsetNames,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Get mesh geometry as JSON for 3D preview
app.get("/api/mesh/geometry", async (req, res) => {
  if (!currentState.meshPath) {
    return res.status(400).json({ error: "No mesh loaded" });
  }

  // Write elsets/nsets to temp file to avoid E2BIG on large models
  const setsFile = path.join(RESULTS_DIR, "mesh_sets.json");
  const setsData = {
    elsets: currentState.elsets || {},
    nsets: currentState.nsets || {},
  };
  fs.writeFileSync(setsFile, JSON.stringify(setsData));

  const script = `
    include("${JULIA_PROJECT}/src/GeomecSolver.jl")
    using .GeomecSolver
    using JSON

    sets_data = JSON.parsefile("${setsFile}")
    elsets = Dict{String,Vector{Int}}(k => Int.(v) for (k,v) in sets_data["elsets"])
    nsets = Dict{String,Vector{Int}}(k => Int.(v) for (k,v) in sets_data["nsets"])

    result = extract_boundary_surface("${currentState.meshPath}"; elsets=elsets, nsets=nsets)
    println("MESH_JSON_START")
    println(JSON.json(result))
    println("MESH_JSON_END")
  `;

  try {
    const output = await runJulia(script);
    const startMarker = output.indexOf("MESH_JSON_START");
    const endMarker = output.indexOf("MESH_JSON_END");
    if (startMarker >= 0 && endMarker >= 0) {
      const jsonStr = output.substring(startMarker + "MESH_JSON_START".length, endMarker).trim();
      const result = JSON.parse(jsonStr);
      res.json(result);
    } else {
      res.status(500).json({ error: "Failed to extract mesh geometry" });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Run solver
app.post("/api/solve", async (req, res) => {
  if (!currentState.meshPath) {
    return res.status(400).json({ error: "No mesh loaded" });
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
    include("${JULIA_PROJECT}/src/GeomecSolver.jl")
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
  if (!currentState.resultsPath) return res.status(400).json({ error: "No results" });
  if (fs.existsSync(currentState.resultsPath)) {
    res.download(currentState.resultsPath);
  } else {
    res.status(404).json({ error: "VTK file not found" });
  }
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", julia_project: JULIA_PROJECT });
});

// WebSocket
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
      const dirichletTags = currentState.bcs.filter(bc => bc.type === "fixed").map(bc => `"${bc.face}"`);
      const dirichletValues = currentState.bcs.filter(bc => bc.type === "fixed").map(() => "VectorValue(0.0, 0.0, 0.0)");
      const neumannTags = currentState.bcs.filter(bc => bc.type === "traction" || bc.type === "pressure").map(bc => `"${bc.face}"`);
      const neumannValues = currentState.bcs.filter(bc => bc.type === "traction" || bc.type === "pressure").map(bc => `VectorValue(${bc.values[0]}, ${bc.values[1]}, ${bc.values[2]})`);

      const script = `
        include("${JULIA_PROJECT}/src/GeomecSolver.jl")
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
  ws.on("close", () => console.log("WebSocket disconnected"));
});

server.listen(PORT, () => {
  console.log(`3D Geomec server running on http://localhost:${PORT}`);
  console.log(`Julia project: ${JULIA_PROJECT}`);
});
