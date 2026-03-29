"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";

const GeometryDrawing = dynamic(() => import("./GeometryDrawing"), { ssr: false });

interface ModelSetupProps {
  onMeshLoaded: (data: unknown) => void;
}

interface MaterialProps {
  E: number;
  nu: number;
  rho: number;
}

interface BoundaryCondition {
  face: string;
  type: "fixed" | "traction" | "pressure";
  values: number[];
}

interface CheckItem {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

export default function ModelSetup({ onMeshLoaded }: ModelSetupProps) {
  const [meshSource, setMeshSource] = useState<"generate" | "template" | "draw" | "abaqus" | "gocad">("generate");
  const [material, setMaterial] = useState<MaterialProps>({ E: 20e9, nu: 0.25, rho: 2400 });
  const [boxDims, setBoxDims] = useState({ Lx: 1.0, Ly: 1.0, Lz: 1.0, nx: 10, ny: 10, nz: 10 });
  const [template, setTemplate] = useState<"borehole" | "eshelby">("borehole");
  const [templateParams, setTemplateParams] = useState<Record<string, number>>({
    domain_x: 10, domain_y: 10, radius: 0.5, depth: 0.1, h_fine: 0.05, h_coarse: 1.0,
    semi_a: 2, semi_b: 1, angle: 0,
    width: 20, height: 30, tunnel_radius: 3, tunnel_cx: 0, tunnel_cy: 15,
  });
  const [bcs, setBcs] = useState<BoundaryCondition[]>([
    { face: "bottom", type: "fixed", values: [0, 0, 0] },
  ]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [meshStatus, setMeshStatus] = useState<string>("");
  const [meshLoaded, setMeshLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [availableFaces, setAvailableFaces] = useState<string[]>([]);

  const presets: Record<string, MaterialProps> = {
    Sandstone: { E: 20e9, nu: 0.25, rho: 2400 },
    Shale: { E: 5e9, nu: 0.30, rho: 2500 },
    Limestone: { E: 40e9, nu: 0.28, rho: 2700 },
    Granite: { E: 60e9, nu: 0.20, rho: 2650 },
  };

  const defaultFaces = ["bottom", "top", "left", "right", "front", "back"];
  const faces = availableFaces.length > 0 ? availableFaces : defaultFaces;

  // --- Validation ---
  const checklist = useMemo<CheckItem[]>(() => {
    const items: CheckItem[] = [];

    // 1. Mesh
    if (meshSource === "generate") {
      const dimsValid = boxDims.Lx > 0 && boxDims.Ly > 0 && boxDims.Lz > 0;
      const elemsValid = boxDims.nx >= 1 && boxDims.ny >= 1 && boxDims.nz >= 1;
      if (!dimsValid) {
        items.push({ id: "mesh", label: "Mesh", status: "fail", message: "All dimensions must be > 0" });
      } else if (!elemsValid) {
        items.push({ id: "mesh", label: "Mesh", status: "fail", message: "Element counts must be >= 1" });
      } else if (meshLoaded) {
        items.push({ id: "mesh", label: "Mesh", status: "pass", message: meshStatus });
      } else {
        items.push({ id: "mesh", label: "Mesh", status: "warn", message: "Configured but not generated yet. Click 'Generate Mesh'." });
      }
    } else if (meshSource === "draw") {
      if (meshLoaded) {
        items.push({ id: "mesh", label: "Mesh", status: "pass", message: meshStatus });
      } else {
        items.push({ id: "mesh", label: "Mesh", status: "warn", message: "Draw geometry and click 'Generate Mesh from Drawing'" });
      }
    } else if (meshSource === "template") {
      if (meshLoaded) {
        items.push({ id: "mesh", label: "Mesh", status: "pass", message: meshStatus });
      } else {
        const tname = template === "borehole" ? "Borehole (Kirsch)" : "Eshelby Inclusion";
        items.push({ id: "mesh", label: "Mesh", status: "warn", message: `${tname} configured. Click 'Generate Template'.` });
      }
    } else {
      if (!uploadFile && !meshLoaded) {
        items.push({ id: "mesh", label: "Mesh", status: "fail", message: `No ${meshSource === "abaqus" ? ".inp" : "GOCAD"} file selected` });
      } else if (uploadFile && !meshLoaded) {
        items.push({ id: "mesh", label: "Mesh", status: "warn", message: `File selected: ${uploadFile.name}. Click 'Upload & Parse'.` });
      } else {
        items.push({ id: "mesh", label: "Mesh", status: "pass", message: meshStatus });
      }
    }

    // 2. Material
    const matErrors: string[] = [];
    if (material.E <= 0) matErrors.push("Young's modulus must be > 0");
    if (material.E < 0.1e9) matErrors.push("E < 0.1 GPa seems too low for rock");
    if (material.E > 200e9) matErrors.push("E > 200 GPa seems too high for rock");
    if (material.nu <= 0 || material.nu >= 0.5) matErrors.push("Poisson's ratio must be between 0 and 0.5");
    if (material.rho <= 0) matErrors.push("Density must be > 0");
    if (material.rho < 1000 || material.rho > 4000) matErrors.push("Density outside typical rock range (1000-4000 kg/m3)");

    if (matErrors.length === 0) {
      items.push({ id: "material", label: "Material", status: "pass", message: `E=${(material.E/1e9).toFixed(1)} GPa, v=${material.nu}, rho=${material.rho} kg/m3` });
    } else {
      const hasCritical = material.E <= 0 || material.nu <= 0 || material.nu >= 0.5 || material.rho <= 0;
      items.push({ id: "material", label: "Material", status: hasCritical ? "fail" : "warn", message: matErrors.join(". ") });
    }

    // 3. Boundary conditions
    const hasFixed = bcs.some(bc => bc.type === "fixed");
    if (bcs.length === 0) {
      items.push({ id: "bcs", label: "Boundary Conditions", status: "fail", message: "At least one BC is required" });
    } else if (!hasFixed) {
      items.push({ id: "bcs", label: "Boundary Conditions", status: "fail", message: "At least one fixed (Dirichlet) BC is required to prevent rigid body motion" });
    } else {
      const duplicateFaces = bcs.map(b => b.face).filter((f, i, a) => a.indexOf(f) !== i);
      if (duplicateFaces.length > 0) {
        items.push({ id: "bcs", label: "Boundary Conditions", status: "warn", message: `Duplicate BCs on face: ${[...new Set(duplicateFaces)].join(", ")}` });
      } else {
        const fixedCount = bcs.filter(b => b.type === "fixed").length;
        const loadCount = bcs.filter(b => b.type !== "fixed").length;
        items.push({ id: "bcs", label: "Boundary Conditions", status: "pass", message: `${fixedCount} fixed, ${loadCount} loaded` });
      }
    }

    // 4. Loading
    const hasLoad = bcs.some(bc => bc.type === "traction" || bc.type === "pressure");
    if (!hasLoad) {
      items.push({ id: "loading", label: "Loading", status: "warn", message: "No applied loads — only gravity will act. Add a traction or pressure BC if needed." });
    } else {
      const loadBCs = bcs.filter(bc => bc.type !== "fixed");
      const zeroLoads = loadBCs.filter(bc => bc.values.every(v => v === 0));
      if (zeroLoads.length > 0) {
        items.push({ id: "loading", label: "Loading", status: "warn", message: "Some load BCs have zero values" });
      } else {
        items.push({ id: "loading", label: "Loading", status: "pass", message: `${loadBCs.length} load(s) applied` });
      }
    }

    return items;
  }, [meshSource, material, boxDims, bcs, uploadFile, meshLoaded, meshStatus, template]);

  const allPassed = checklist.every(c => c.status === "pass");
  const hasCritical = checklist.some(c => c.status === "fail");

  // --- Handlers ---
  async function handleTemplate() {
    setIsLoading(true);
    const tname = template === "borehole" ? "Borehole (Kirsch)" : "Eshelby Inclusion";
    setMeshStatus(`Generating ${tname}... (may take 15-30s on first run)`);
    try {
      const res = await fetch("http://localhost:4000/api/mesh/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, params: templateParams, material, bcs }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        setMeshStatus("Error: Invalid response"); setMeshLoaded(false); setIsLoading(false); return;
      }
      if (data.error) {
        setMeshStatus(`Error: ${data.error}`);
        setMeshLoaded(false);
      } else {
        setMeshStatus(`${data.n_nodes} nodes, ${data.n_elements} elements`);
        setMeshLoaded(true);
        // Set appropriate faces based on template
        if (template === "borehole") {
          setAvailableFaces(["symmetry_x", "symmetry_y", "far_field_x", "far_field_y", "front", "back", "borehole_wall"]);
        } else if (template === "eshelby") {
          setAvailableFaces(["left", "right", "bottom", "top"]);
        }
        onMeshLoaded(data);
      }
    } catch (err) {
      setMeshStatus(`Connection error: ${err}`);
      setMeshLoaded(false);
    }
    setIsLoading(false);
  }

  async function handleDrawMesh(geometries: any[]) {
    setIsLoading(true);
    setMeshStatus("Generating mesh from drawing...");
    try {
      const res = await fetch("http://localhost:4000/api/mesh/from-drawing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geometries, material, bcs, h_fine: 0.1, h_coarse: 1.0 }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        setMeshStatus("Error: Invalid response"); setMeshLoaded(false); setIsLoading(false); return;
      }
      if (data.error) {
        setMeshStatus(`Error: ${data.error}`);
        setMeshLoaded(false);
      } else {
        setMeshStatus(`${data.n_nodes} nodes, ${data.n_elements} elements`);
        setMeshLoaded(true);
        setAvailableFaces(data.nset_names || ["left", "right", "bottom", "top"]);
        onMeshLoaded(data);
      }
    } catch (err) {
      setMeshStatus(`Connection error: ${err}`);
      setMeshLoaded(false);
    }
    setIsLoading(false);
  }

  async function handleGenerate() {
    setIsLoading(true);
    setMeshStatus("Generating mesh... (Julia first run may take 15-30s)");
    console.log("[ModelSetup] Starting mesh generation");
    try {
      const res = await fetch("/api/mesh/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...boxDims, material, bcs }),
      });
      console.log("[ModelSetup] Generate response status:", res.status);
      const text = await res.text();
      console.log("[ModelSetup] Generate response:", text);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setMeshStatus(`Error: Invalid response from server`);
        setMeshLoaded(false);
        setIsLoading(false);
        return;
      }
      if (data.error) {
        setMeshStatus(`Error: ${data.error}`);
        setMeshLoaded(false);
      } else {
        setMeshStatus(`${data.n_nodes} nodes, ${data.n_elements} elements`);
        setMeshLoaded(true);
        // Box mesh uses default face names
        setAvailableFaces(["bottom", "top", "left", "right", "front", "back"]);
        console.log("[ModelSetup] Calling onMeshLoaded");
        onMeshLoaded(data);
      }
    } catch (err) {
      console.error("[ModelSetup] Generate error:", err);
      setMeshStatus(`Connection error: ${err}`);
      setMeshLoaded(false);
    }
    setIsLoading(false);
  }

  async function handleUpload() {
    if (!uploadFile) return;
    setIsLoading(true);
    setMeshStatus("Uploading & parsing... (Julia first run may take 15-30s)");
    const formData = new FormData();
    formData.append("file", uploadFile);
    formData.append("material", JSON.stringify(material));
    formData.append("bcs", JSON.stringify(bcs));

    console.log("[ModelSetup] Starting upload:", uploadFile.name);
    try {
      const res = await fetch("http://localhost:4000/api/mesh/upload", {
        method: "POST",
        body: formData,
      });
      console.log("[ModelSetup] Upload response status:", res.status);
      const text = await res.text();
      console.log("[ModelSetup] Upload response body:", text);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setMeshStatus(`Error: Invalid response from server`);
        setMeshLoaded(false);
        setIsLoading(false);
        return;
      }
      if (data.error) {
        setMeshStatus(`Error: ${data.error}`);
        setMeshLoaded(false);
      } else {
        setMeshStatus(`${data.n_nodes} nodes, ${data.n_elements} elements`);
        setMeshLoaded(true);
        // Update available faces from nset names
        if (data.nset_names && data.nset_names.length > 0) {
          setAvailableFaces(data.nset_names);
          // Reset BCs to use the first nset as fixed
          setBcs([{ face: data.nset_names[0], type: "fixed", values: [0, 0, 0] }]);
        }
        console.log("[ModelSetup] Calling onMeshLoaded");
        onMeshLoaded(data);
      }
    } catch (err) {
      console.error("[ModelSetup] Upload error:", err);
      setMeshStatus(`Connection error: ${err}`);
      setMeshLoaded(false);
    }
    setIsLoading(false);
  }

  function addBC() {
    setBcs([...bcs, { face: "top", type: "traction", values: [0, 0, -10e6] }]);
  }

  function removeBC(index: number) {
    setBcs(bcs.filter((_, i) => i !== index));
  }

  function updateBC(index: number, field: keyof BoundaryCondition, value: string | number[]) {
    const updated = [...bcs];
    if (field === "face") {
      updated[index] = { ...updated[index], face: value as string };
    } else if (field === "type") {
      updated[index] = { ...updated[index], type: value as BoundaryCondition["type"] };
    } else if (field === "values") {
      updated[index] = { ...updated[index], values: value as number[] };
    }
    setBcs(updated);
  }

  const statusIcon = (status: CheckItem["status"]) => {
    if (status === "pass") return <span className="text-green-400 font-bold">&#10003;</span>;
    if (status === "fail") return <span className="text-red-400 font-bold">&#10007;</span>;
    return <span className="text-yellow-400 font-bold">!</span>;
  };

  const statusBorder = (status: CheckItem["status"]) => {
    if (status === "pass") return "border-l-green-400";
    if (status === "fail") return "border-l-red-400";
    return "border-l-yellow-400";
  };

  return (
    <div className="p-6 overflow-y-auto h-full max-w-5xl mx-auto flex gap-6">
      {/* Left: Forms */}
      <div className="flex-1 space-y-5">

        {/* Step 1: Mesh Source */}
        <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}>1</span>
            <h2 className="text-base font-semibold" style={{ color: "var(--accent)" }}>
              Mesh Source
            </h2>
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {(["generate", "template", "draw", "abaqus", "gocad"] as const).map((src) => (
              <button
                key={src}
                onClick={() => { setMeshSource(src); setMeshLoaded(false); setMeshStatus(""); if (src === "generate") setAvailableFaces([]); }}
                className="px-4 py-2 rounded text-sm font-medium transition-colors"
                style={{
                  backgroundColor: meshSource === src ? "var(--accent)" : "var(--bg-card)",
                  color: meshSource === src ? "#fff" : "var(--text-secondary)",
                }}
              >
                {src === "generate" ? "Simple Box" : src === "template" ? "Templates" : src === "draw" ? "Draw 2D" : src === "abaqus" ? "Abaqus .inp" : "GOCAD"}
              </button>
            ))}
          </div>

          {meshSource === "generate" && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                {(["Lx", "Ly", "Lz"] as const).map((dim) => (
                  <label key={dim} className="block">
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{dim} (m)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={boxDims[dim]}
                      onChange={(e) => { setBoxDims({ ...boxDims, [dim]: parseFloat(e.target.value) || 0 }); setMeshLoaded(false); }}
                      className={`w-full mt-1 px-3 py-1.5 rounded text-sm border ${boxDims[dim] <= 0 ? "border-red-500" : "border-transparent"}`}
                      style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                    />
                    {boxDims[dim] <= 0 && <span className="text-xs text-red-400">Must be &gt; 0</span>}
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(["nx", "ny", "nz"] as const).map((n) => (
                  <label key={n} className="block">
                    <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{n} (elements)</span>
                    <input
                      type="number"
                      min="1"
                      value={boxDims[n]}
                      onChange={(e) => { setBoxDims({ ...boxDims, [n]: parseInt(e.target.value) || 0 }); setMeshLoaded(false); }}
                      className={`w-full mt-1 px-3 py-1.5 rounded text-sm border ${boxDims[n] < 1 ? "border-red-500" : "border-transparent"}`}
                      style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                    />
                    {boxDims[n] < 1 && <span className="text-xs text-red-400">Must be &gt;= 1</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {meshSource === "template" && (
            <div className="space-y-3">
              {/* Template selector */}
              <div className="flex gap-2">
                {([
                  { id: "borehole" as const, label: "Borehole (Kirsch)", desc: "Quarter model, 2D XY plane, symmetry BCs" },
                  { id: "eshelby" as const, label: "Eshelby Inclusion", desc: "Full 2D model, ellipse inclusion, two materials" },
                ]).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTemplate(t.id)}
                    className="flex-1 p-2 rounded text-xs text-left transition-colors"
                    style={{
                      backgroundColor: template === t.id ? "var(--accent)" : "var(--bg-card)",
                      color: template === t.id ? "#fff" : "var(--text-secondary)",
                    }}
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="opacity-70 mt-0.5">{t.desc}</div>
                  </button>
                ))}
              </div>

              {/* Borehole parameters */}
              {template === "borehole" && (
                <div>
                  <p className="text-xs mb-2" style={{ color: "var(--text-secondary)" }}>
                    Quarter model (x &ge; 0, y &ge; 0). Symmetry BCs on x=0 and y=0 edges.
                    Borehole at origin. Far-field stress on outer edges.
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                  {([
                    { key: "domain_x", label: "Domain radius (m)", step: 1 },
                    { key: "radius", label: "Borehole radius (m)", step: 0.01 },
                    { key: "h_fine", label: "Fine mesh size (m)", step: 0.01 },
                    { key: "h_coarse", label: "Coarse mesh size (m)", step: 0.1 },
                  ]).map(({ key, label, step }) => (
                    <label key={key} className="block">
                      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
                      <input type="number" step={step} value={templateParams[key]}
                        onChange={e => setTemplateParams({ ...templateParams, [key]: parseFloat(e.target.value) || 0 })}
                        className="w-full mt-1 px-3 py-1.5 rounded text-sm border border-transparent"
                        style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                      />
                    </label>
                  ))}
                </div>
                </div>
              )}

              {/* Eshelby parameters */}
              {template === "eshelby" && (
                <div className="grid grid-cols-3 gap-3">
                  {([
                    { key: "domain_x", label: "Domain half-width (m)", step: 1 },
                    { key: "domain_y", label: "Domain half-height (m)", step: 1 },
                    { key: "semi_a", label: "Semi-axis a (m)", step: 0.1 },
                    { key: "semi_b", label: "Semi-axis b (m)", step: 0.1 },
                    { key: "angle", label: "Rotation angle (deg)", step: 5 },
                    { key: "depth", label: "Extrusion depth (m)", step: 0.1 },
                    { key: "h_fine", label: "Fine mesh size (m)", step: 0.01 },
                    { key: "h_coarse", label: "Coarse mesh size (m)", step: 0.1 },
                  ]).map(({ key, label, step }) => (
                    <label key={key} className="block">
                      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
                      <input type="number" step={step} value={templateParams[key]}
                        onChange={e => setTemplateParams({ ...templateParams, [key]: parseFloat(e.target.value) || 0 })}
                        className="w-full mt-1 px-3 py-1.5 rounded text-sm border border-transparent"
                        style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                      />
                    </label>
                  ))}
                </div>
              )}

              {/* Tunnel parameters */}
            </div>
          )}

          {meshSource === "draw" && (
            <GeometryDrawing onGeometryReady={(geos) => handleDrawMesh(geos)} />
          )}

          {(meshSource === "abaqus" || meshSource === "gocad") && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                {meshSource === "abaqus"
                  ? "Upload an Abaqus .inp file with *NODE, *ELEMENT, *NSET, and *MATERIAL sections."
                  : "Upload a GOCAD file: .ts (surface), .sg (stratigraphic grid), or .vo (voxet)."}
              </p>
              <div className="flex items-center gap-3">
                <label
                  className="px-4 py-2 rounded text-sm font-medium cursor-pointer transition-colors hover:opacity-90"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}
                >
                  Choose File
                  <input
                    type="file"
                    accept={meshSource === "abaqus" ? ".inp" : ".ts,.sg,.vo"}
                    onChange={(e) => { setUploadFile(e.target.files?.[0] || null); setMeshLoaded(false); setMeshStatus(""); }}
                    className="hidden"
                  />
                </label>
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  {uploadFile ? uploadFile.name : "No file selected"}
                </span>
              </div>
              {uploadFile && (
                <p className="text-xs mt-1" style={{ color: "var(--accent)" }}>
                  {(uploadFile.size / 1024).toFixed(1)} KB
                </p>
              )}
            </div>
          )}

          {meshSource !== "draw" && (
            <div className="mt-3">
              <button
                onClick={meshSource === "generate" ? handleGenerate : meshSource === "template" ? handleTemplate : handleUpload}
                disabled={isLoading || (meshSource !== "generate" && meshSource !== "template" && !uploadFile)}
                className="px-5 py-2 rounded font-medium text-sm disabled:opacity-40 transition-colors"
                style={{ backgroundColor: "var(--accent)", color: "#fff" }}
              >
                {isLoading ? "Processing..." : meshSource === "generate" ? "Generate Mesh" : meshSource === "template" ? "Generate Template" : "Upload & Parse"}
              </button>
            </div>
          )}
        </section>

        {/* Step 2: Material Properties */}
        <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ backgroundColor: "var(--accent)", color: "#fff" }}>2</span>
            <h2 className="text-base font-semibold" style={{ color: "var(--accent)" }}>
              Rock Properties
            </h2>
          </div>
          <div className="flex gap-2 mb-3">
            <span className="text-xs self-center" style={{ color: "var(--text-secondary)" }}>Presets:</span>
            {Object.keys(presets).map((name) => (
              <button
                key={name}
                onClick={() => setMaterial(presets[name])}
                className="px-3 py-1 rounded text-xs transition-colors hover:opacity-80"
                style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Young&apos;s Modulus E (GPa)</span>
              <input
                type="number"
                step="0.1"
                value={material.E / 1e9}
                onChange={(e) => setMaterial({ ...material, E: (parseFloat(e.target.value) || 0) * 1e9 })}
                className={`w-full mt-1 px-3 py-1.5 rounded text-sm border ${material.E <= 0 ? "border-red-500" : material.E < 0.1e9 || material.E > 200e9 ? "border-yellow-500" : "border-transparent"}`}
                style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
              />
              {material.E <= 0 && <span className="text-xs text-red-400">Must be &gt; 0</span>}
              {material.E > 0 && (material.E < 0.1e9 || material.E > 200e9) && <span className="text-xs text-yellow-400">Outside typical rock range</span>}
            </label>
            <label className="block">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Poisson&apos;s Ratio v</span>
              <input
                type="number"
                step="0.01"
                value={material.nu}
                onChange={(e) => setMaterial({ ...material, nu: parseFloat(e.target.value) || 0 })}
                className={`w-full mt-1 px-3 py-1.5 rounded text-sm border ${material.nu <= 0 || material.nu >= 0.5 ? "border-red-500" : "border-transparent"}`}
                style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
              />
              {material.nu <= 0 && <span className="text-xs text-red-400">Must be &gt; 0</span>}
              {material.nu >= 0.5 && <span className="text-xs text-red-400">Must be &lt; 0.5 (incompressible limit)</span>}
            </label>
            <label className="block">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Density (kg/m3)</span>
              <input
                type="number"
                value={material.rho}
                onChange={(e) => setMaterial({ ...material, rho: parseFloat(e.target.value) || 0 })}
                className={`w-full mt-1 px-3 py-1.5 rounded text-sm border ${material.rho <= 0 ? "border-red-500" : (material.rho < 1000 || material.rho > 4000) ? "border-yellow-500" : "border-transparent"}`}
                style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
              />
              {material.rho <= 0 && <span className="text-xs text-red-400">Must be &gt; 0</span>}
              {material.rho > 0 && (material.rho < 1000 || material.rho > 4000) && <span className="text-xs text-yellow-400">Outside typical range</span>}
            </label>
          </div>
        </section>

        {/* Step 3: Boundary Conditions */}
        <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                    style={{ backgroundColor: "var(--accent)", color: "#fff" }}>3</span>
              <h2 className="text-base font-semibold" style={{ color: "var(--accent)" }}>
                Boundary Conditions
              </h2>
            </div>
            <button
              onClick={addBC}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{ backgroundColor: "var(--accent)", color: "#fff" }}
            >
              + Add BC
            </button>
          </div>

          {availableFaces.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Available surfaces:</span>
              {availableFaces.map(f => (
                <span key={f} className="text-xs px-2 py-0.5 rounded"
                      style={{ backgroundColor: "var(--bg-card)", color: "var(--accent)" }}>{f}</span>
              ))}
            </div>
          )}

          {bcs.length === 0 && (
            <p className="text-xs p-2 rounded" style={{ backgroundColor: "var(--bg-card)", color: "var(--danger)" }}>
              No boundary conditions defined. At least one fixed BC is required.
            </p>
          )}

          {!bcs.some(bc => bc.type === "fixed") && bcs.length > 0 && (
            <p className="text-xs p-2 rounded mb-2" style={{ backgroundColor: "rgba(231,76,60,0.15)", color: "var(--danger)" }}>
              Missing fixed BC — the model needs at least one fixed face to prevent rigid body motion.
            </p>
          )}

          <div className="space-y-2">
            {bcs.map((bc, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded"
                   style={{ backgroundColor: "var(--bg-card)" }}>
                <select
                  value={bc.face}
                  onChange={(e) => updateBC(i, "face", e.target.value)}
                  className="px-2 py-1 rounded text-sm"
                  style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                >
                  {faces.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <select
                  value={bc.type}
                  onChange={(e) => updateBC(i, "type", e.target.value)}
                  className="px-2 py-1 rounded text-sm"
                  style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                >
                  <option value="fixed">Fixed (u=0)</option>
                  <option value="traction">Traction (Pa)</option>
                  <option value="pressure">Pressure (Pa)</option>
                </select>
                {bc.type !== "fixed" && (
                  <div className="flex gap-1 items-center">
                    {["Fx", "Fy", "Fz"].map((axis, j) => (
                      <label key={axis} className="flex flex-col items-center">
                        <span className="text-[10px]" style={{ color: "var(--text-secondary)" }}>{axis}</span>
                        <input
                          type="number"
                          step="1e5"
                          value={bc.values[j]}
                          onChange={(e) => {
                            const vals = [...bc.values];
                            vals[j] = parseFloat(e.target.value) || 0;
                            updateBC(i, "values", vals);
                          }}
                          className="w-24 px-2 py-1 rounded text-xs"
                          style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                        />
                      </label>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => removeBC(i)}
                  className="ml-auto text-xs px-2 py-1 rounded hover:opacity-80"
                  style={{ color: "var(--danger)" }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Right: Checklist Panel */}
      <div className="w-72 shrink-0">
        <div className="sticky top-6 p-4 rounded-lg space-y-3" style={{ backgroundColor: "var(--bg-secondary)" }}>
          <h2 className="text-base font-semibold mb-1" style={{ color: "var(--accent)" }}>
            Pre-Run Checklist
          </h2>

          <div className="space-y-2">
            {checklist.map((item) => (
              <div
                key={item.id}
                className={`p-2.5 rounded border-l-4 ${statusBorder(item.status)}`}
                style={{ backgroundColor: "var(--bg-card)" }}
              >
                <div className="flex items-center gap-2">
                  {statusIcon(item.status)}
                  <span className="text-sm font-medium">{item.label}</span>
                </div>
                <p className="text-xs mt-1 ml-6" style={{
                  color: item.status === "fail" ? "var(--danger)" :
                         item.status === "warn" ? "var(--warning)" :
                         "var(--text-secondary)"
                }}>
                  {item.message}
                </p>
              </div>
            ))}
          </div>

          {/* Summary */}
          <div className="pt-3 border-t" style={{ borderColor: "var(--bg-card)" }}>
            {allPassed ? (
              <div className="p-3 rounded text-center" style={{ backgroundColor: "rgba(46,204,113,0.15)" }}>
                <p className="text-sm font-semibold text-green-400">Ready to Solve</p>
                <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                  Switch to 3D Viewer tab and click Solve
                </p>
              </div>
            ) : hasCritical ? (
              <div className="p-3 rounded text-center" style={{ backgroundColor: "rgba(231,76,60,0.15)" }}>
                <p className="text-sm font-semibold text-red-400">Cannot Run</p>
                <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                  Fix items marked with &#10007; before solving
                </p>
              </div>
            ) : (
              <div className="p-3 rounded text-center" style={{ backgroundColor: "rgba(243,156,18,0.15)" }}>
                <p className="text-sm font-semibold text-yellow-400">Warnings</p>
                <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
                  Review warnings — model may still run
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
