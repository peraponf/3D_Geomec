// @ts-nocheck
"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";

interface PartitionInfo {
  name: string;
  color: string;
  n_elements: number;
}

interface NsetInfo {
  name: string;
  n_nodes: number;
  boundary_nodes: number;
  node_indices: number[];
}

interface SurfaceData {
  nodes: number[][];
  faces: number[][];
  face_partitions: number[];
  partitions: PartitionInfo[];
  nsets: NsetInfo[];
  n_nodes: number;
  n_faces: number;
  n_total_elements: number;
  bounds: { min: number[]; max: number[] };
}

interface ClipPlane {
  enabled: boolean;
  axis: "x" | "y" | "z";
  position: number; // 0-1 normalized
  flip: boolean;
}

interface Viewer3DProps {
  meshData: unknown;
  resultsData: unknown;
}

// Helper: transform node to normalized coordinates
function makeTransform(bounds: SurfaceData["bounds"]) {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const maxDim = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    0.001
  );
  const s = 2.0 / maxDim;
  return {
    cx, cy, cz, s,
    transform: (n: number[]): [number, number, number] =>
      [(n[0] - cx) * s, (n[1] - cy) * s, (n[2] - cz) * s],
  };
}

// Check if a point passes the clip test
function passesClip(node: number[], clip: ClipPlane, bounds: SurfaceData["bounds"]): boolean {
  if (!clip.enabled) return true;
  const axisIdx = clip.axis === "x" ? 0 : clip.axis === "y" ? 1 : 2;
  const min = bounds.min[axisIdx];
  const max = bounds.max[axisIdx];
  const cutPos = min + clip.position * (max - min);
  return clip.flip ? node[axisIdx] >= cutPos : node[axisIdx] <= cutPos;
}

function SurfaceMesh({
  surface, visiblePartitions, showWireframe, clip,
}: {
  surface: SurfaceData;
  visiblePartitions: Set<number>;
  showWireframe: boolean;
  clip: ClipPlane;
}) {
  const { solidGeom, wireGeom, cutGeom } = useMemo(() => {
    const { nodes, faces, face_partitions, partitions, bounds } = surface;
    const { transform } = makeTransform(bounds);

    const positions: number[] = [];
    const colors: number[] = [];
    const wirePositions: number[] = [];
    const cutPositions: number[] = [];
    const cutColors: number[] = [];
    const color = new THREE.Color();

    for (let fi = 0; fi < faces.length; fi++) {
      const pid = face_partitions[fi];
      if (!visiblePartitions.has(pid)) continue;

      const face = faces[fi];
      if (face.length < 3) continue;

      // Check if all face nodes pass the clip
      const faceNodes = face.map(ni => nodes[ni]).filter(Boolean);
      if (faceNodes.length < 3) continue;

      const allPass = faceNodes.every(n => passesClip(n, clip, bounds));
      const anyPass = faceNodes.some(n => passesClip(n, clip, bounds));

      if (!anyPass) continue;

      const partColor = partitions[pid - 1]?.color || "#4ea8de";
      color.set(partColor);

      if (allPass) {
        // Full face visible
        for (const ni of face) {
          const t = transform(nodes[ni]);
          positions.push(t[0], t[1], t[2]);
          colors.push(color.r, color.g, color.b);
        }
        // Wireframe
        for (let i = 0; i < face.length; i++) {
          const a = transform(nodes[face[i]]);
          const b = transform(nodes[face[(i + 1) % face.length]]);
          wirePositions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        }
      }
      // Partial faces (crossing the clip plane) are skipped for simplicity
      // The cut surface below fills the gap
    }

    // Generate cut surface: find faces that straddle the clip plane
    if (clip.enabled) {
      const axisIdx = clip.axis === "x" ? 0 : clip.axis === "y" ? 1 : 2;
      const min = bounds.min[axisIdx];
      const max = bounds.max[axisIdx];
      const cutPos = min + clip.position * (max - min);

      // Collect all cut edges from faces that cross the plane
      for (let fi = 0; fi < faces.length; fi++) {
        const pid = face_partitions[fi];
        if (!visiblePartitions.has(pid)) continue;

        const face = faces[fi];
        if (face.length < 3) continue;

        const faceNodes = face.map(ni => nodes[ni]).filter(Boolean);
        if (faceNodes.length < 3) continue;

        const partColor = partitions[pid - 1]?.color || "#4ea8de";
        color.set(partColor);
        // Brighten cut surface slightly
        const cutColor = new THREE.Color(partColor).multiplyScalar(1.3);

        // For faces crossing the clip plane, compute intersection
        const sides = faceNodes.map(n => {
          const v = n[axisIdx] - cutPos;
          return clip.flip ? v : -v;
        });

        const hasPos = sides.some(s => s >= 0);
        const hasNeg = sides.some(s => s < 0);
        if (!hasPos || !hasNeg) continue;

        // Compute intersection points
        const intersections: [number, number, number][] = [];
        for (let i = 0; i < faceNodes.length; i++) {
          const j = (i + 1) % faceNodes.length;
          if ((sides[i] >= 0 && sides[j] < 0) || (sides[i] < 0 && sides[j] >= 0)) {
            const t = Math.abs(sides[i]) / (Math.abs(sides[i]) + Math.abs(sides[j]));
            const p: [number, number, number] = [
              faceNodes[i][0] + t * (faceNodes[j][0] - faceNodes[i][0]),
              faceNodes[i][1] + t * (faceNodes[j][1] - faceNodes[i][1]),
              faceNodes[i][2] + t * (faceNodes[j][2] - faceNodes[i][2]),
            ];
            intersections.push(transform(p));
          }
        }

        // Also include vertices on the visible side
        const visibleVerts = faceNodes
          .filter((_, i) => sides[i] >= 0)
          .map(n => transform(n));

        const allPts = [...visibleVerts, ...intersections];
        if (allPts.length >= 3) {
          // Fan triangulation from first point
          for (let i = 1; i < allPts.length - 1; i++) {
            cutPositions.push(
              allPts[0][0], allPts[0][1], allPts[0][2],
              allPts[i][0], allPts[i][1], allPts[i][2],
              allPts[i+1][0], allPts[i+1][1], allPts[i+1][2],
            );
            cutColors.push(
              cutColor.r, cutColor.g, cutColor.b,
              cutColor.r, cutColor.g, cutColor.b,
              cutColor.r, cutColor.g, cutColor.b,
            );
          }
        }
      }
    }

    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    sg.computeVertexNormals();

    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wirePositions, 3));

    const cg = new THREE.BufferGeometry();
    if (cutPositions.length > 0) {
      cg.setAttribute("position", new THREE.Float32BufferAttribute(cutPositions, 3));
      cg.setAttribute("color", new THREE.Float32BufferAttribute(cutColors, 3));
      cg.computeVertexNormals();
    }

    return { solidGeom: sg, wireGeom: wg, cutGeom: cg };
  }, [surface, visiblePartitions, clip]);

  return (
    <group>
      <mesh geometry={solidGeom}>
        <meshStandardMaterial vertexColors side={THREE.DoubleSide} transparent opacity={0.7} />
      </mesh>
      {cutGeom.attributes.position && (
        <mesh geometry={cutGeom}>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}
      {showWireframe && (
        <lineSegments geometry={wireGeom}>
          <lineBasicMaterial color="#ffffff" opacity={0.15} transparent />
        </lineSegments>
      )}
    </group>
  );
}

// Node set point cloud
function NsetPoints({
  surface, activeNsets,
}: {
  surface: SurfaceData;
  activeNsets: Set<string>;
}) {
  const pointsGeom = useMemo(() => {
    if (activeNsets.size === 0) return null;

    const { nodes, nsets, bounds } = surface;
    const { transform } = makeTransform(bounds);
    const positions: number[] = [];
    const colors: number[] = [];

    const nsetColors = [
      "#ff0000", "#00ff00", "#ffff00", "#ff00ff", "#00ffff",
      "#ff8800", "#88ff00", "#0088ff", "#ff0088", "#8800ff",
    ];

    let colorIdx = 0;
    for (const nset of nsets) {
      if (!activeNsets.has(nset.name)) continue;
      if (!nset.node_indices) continue;

      const c = new THREE.Color(nsetColors[colorIdx % nsetColors.length]);
      colorIdx++;

      for (const ni of nset.node_indices) {
        const node = nodes[ni];
        if (!node) continue;
        const t = transform(node);
        positions.push(t[0], t[1], t[2]);
        colors.push(c.r, c.g, c.b);
      }
    }

    if (positions.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return geom;
  }, [surface, activeNsets]);

  if (!pointsGeom) return null;

  return (
    <points geometry={pointsGeom}>
      <pointsMaterial vertexColors size={8} sizeAttenuation={false} depthTest={false} />
    </points>
  );
}

// Clip plane visual indicator
function ClipPlaneIndicator({ clip, bounds }: { clip: ClipPlane; bounds: SurfaceData["bounds"] }) {
  const { transform } = makeTransform(bounds);

  if (!clip.enabled) return null;

  const axisIdx = clip.axis === "x" ? 0 : clip.axis === "y" ? 1 : 2;
  const min = bounds.min[axisIdx];
  const max = bounds.max[axisIdx];
  const cutPos = min + clip.position * (max - min);

  // Create a semi-transparent plane at the cut position
  const size = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ) * 1.2;

  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  center[axisIdx] = cutPos;

  const t = transform(center);
  const { s } = makeTransform(bounds);
  const planeSize = size * s;

  const rotation: [number, number, number] = [0, 0, 0];
  if (clip.axis === "x") rotation[1] = Math.PI / 2;
  else if (clip.axis === "y") rotation[0] = Math.PI / 2;

  return (
    <mesh position={t} rotation={rotation}>
      <planeGeometry args={[planeSize, planeSize]} />
      <meshBasicMaterial color="#ff4444" transparent opacity={0.08} side={THREE.DoubleSide} />
    </mesh>
  );
}

export default function Viewer3D({ meshData, resultsData }: Viewer3DProps) {
  const [surface, setSurface] = useState<SurfaceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWireframe, setShowWireframe] = useState(true);
  const [visiblePartitions, setVisiblePartitions] = useState<Set<number>>(new Set());
  const [activeNsets, setActiveNsets] = useState<Set<string>>(new Set());
  const [clip, setClip] = useState<ClipPlane>({
    enabled: false, axis: "x", position: 0.5, flip: false,
  });

  const fetchGeometry = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSurface(null);
    try {
      const res = await fetch("http://localhost:4000/api/mesh/geometry");
      if (!res.ok) {
        const text = await res.text();
        setError(`Server error ${res.status}: ${text}`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setSurface(data);
        setVisiblePartitions(
          new Set(Array.from({ length: data.partitions.length }, (_, i) => i + 1))
        );
      }
    } catch (err) {
      setError(`Failed to fetch geometry: ${err}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (meshData) fetchGeometry();
  }, [meshData, fetchGeometry]);

  function togglePartition(pid: number) {
    setVisiblePartitions(prev => {
      const next = new Set(prev);
      next.has(pid) ? next.delete(pid) : next.add(pid);
      return next;
    });
  }

  function toggleNset(name: string) {
    setActiveNsets(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const bounds = surface?.bounds;
  const dx = bounds ? (bounds.max[0] - bounds.min[0]).toFixed(3) : "—";
  const dy = bounds ? (bounds.max[1] - bounds.min[1]).toFixed(3) : "—";
  const dz = bounds ? (bounds.max[2] - bounds.min[2]).toFixed(3) : "—";

  const nsetColors = [
    "#ff0000", "#00ff00", "#ffff00", "#ff00ff", "#00ffff",
    "#ff8800", "#88ff00", "#0088ff", "#ff0088", "#8800ff",
  ];

  return (
    <div className="flex h-full">
      {/* 3D Canvas */}
      <div className="flex-1 relative">
        <Canvas camera={{ position: [3, -3, 2], up: [0, 0, 1], fov: 45 }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, -5, 5]} intensity={0.7} />
          <directionalLight position={[-3, 2, -4]} intensity={0.3} />
          {surface && (
            <>
              <SurfaceMesh
                surface={surface}
                visiblePartitions={visiblePartitions}
                showWireframe={showWireframe}
                clip={clip}
              />
              <NsetPoints surface={surface} activeNsets={activeNsets} />
              <ClipPlaneIndicator clip={clip} bounds={surface.bounds} />
            </>
          )}
          <OrbitControls
            enableDamping
            dampingFactor={0.1}
            makeDefault
            minPolarAngle={0}
            maxPolarAngle={Math.PI}
          />
          <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
            <GizmoViewport labelColor="white" axisHeadScale={0.8} />
          </GizmoHelper>
        </Canvas>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center"
               style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-t-transparent rounded-full mx-auto mb-2"
                   style={{ borderColor: "var(--accent)", borderTopColor: "transparent" }} />
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Loading mesh geometry...</p>
            </div>
          </div>
        )}

        {!meshData && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p style={{ color: "var(--text-secondary)" }}>
              No mesh loaded. Go to Model Setup to generate or upload a mesh.
            </p>
          </div>
        )}

        {error && (
          <div className="absolute top-3 left-3 p-2 rounded text-xs max-w-md"
               style={{ backgroundColor: "rgba(231,76,60,0.9)", color: "#fff" }}>
            {error}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-72 border-l overflow-y-auto p-4 space-y-4"
           style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--bg-card)" }}>

        {/* Mesh Info */}
        <section>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--accent)" }}>Mesh Info</h3>
          {surface ? (
            <div className="space-y-1 text-xs" style={{ color: "var(--text-secondary)" }}>
              <div>Total elements: <span style={{ color: "var(--text-primary)" }}>{surface.n_total_elements.toLocaleString()}</span></div>
              <div>Surface faces: <span style={{ color: "var(--text-primary)" }}>{surface.n_faces.toLocaleString()}</span></div>
              <div>Surface nodes: <span style={{ color: "var(--text-primary)" }}>{surface.n_nodes.toLocaleString()}</span></div>
              <div>Size: <span style={{ color: "var(--text-primary)" }}>{dx} x {dy} x {dz}</span></div>
            </div>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>No mesh loaded</p>
          )}
        </section>

        {/* Display */}
        <section>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--accent)" }}>Display</h3>
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={showWireframe} onChange={e => setShowWireframe(e.target.checked)} />
            Show wireframe
          </label>
        </section>

        {/* Cross Section */}
        <section>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--accent)" }}>Cross Section</h3>
          <label className="flex items-center gap-2 text-xs cursor-pointer mb-2" style={{ color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={clip.enabled} onChange={e => setClip({ ...clip, enabled: e.target.checked })} />
            Enable cutting plane
          </label>
          {clip.enabled && (
            <div className="space-y-2">
              <div className="flex gap-1">
                {(["x", "y", "z"] as const).map(a => (
                  <button
                    key={a}
                    onClick={() => setClip({ ...clip, axis: a })}
                    className="flex-1 px-2 py-1 rounded text-xs font-medium"
                    style={{
                      backgroundColor: clip.axis === a ? "var(--accent)" : "var(--bg-card)",
                      color: clip.axis === a ? "#fff" : "var(--text-secondary)",
                    }}
                  >
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
              <div>
                <div className="flex justify-between text-[10px]" style={{ color: "var(--text-secondary)" }}>
                  <span>Position</span>
                  <span>{(clip.position * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.005}
                  value={clip.position}
                  onChange={e => setClip({ ...clip, position: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                <input type="checkbox" checked={clip.flip} onChange={e => setClip({ ...clip, flip: e.target.checked })} />
                Flip direction
              </label>
            </div>
          )}
        </section>

        {/* Partitions */}
        {surface && surface.partitions.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                Partitions ({surface.partitions.length})
              </h3>
              <div className="flex gap-1">
                <button onClick={() => surface && setVisiblePartitions(
                  new Set(Array.from({ length: surface.partitions.length }, (_, i) => i + 1))
                )} className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}>All</button>
                <button onClick={() => setVisiblePartitions(new Set())}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}>None</button>
              </div>
            </div>
            <div className="space-y-1">
              {surface.partitions.map((part, i) => {
                const pid = i + 1;
                const visible = visiblePartitions.has(pid);
                return (
                  <div
                    key={part.name}
                    className="flex items-center gap-2 p-1.5 rounded cursor-pointer text-xs transition-opacity"
                    style={{ backgroundColor: "var(--bg-card)", opacity: visible ? 1 : 0.4 }}
                    onClick={() => togglePartition(pid)}
                  >
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: part.color }} />
                    <span className="flex-1 truncate" style={{ color: "var(--text-primary)" }}>{part.name}</span>
                    <span style={{ color: "var(--text-secondary)" }}>{part.n_elements.toLocaleString()} el</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Node Sets */}
        {surface && surface.nsets.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                Node Sets ({surface.nsets.length})
              </h3>
              <div className="flex gap-1">
                <button onClick={() => surface && setActiveNsets(new Set(surface.nsets.map(n => n.name)))}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}>All</button>
                <button onClick={() => setActiveNsets(new Set())}
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}>None</button>
              </div>
            </div>
            <div className="space-y-1">
              {surface.nsets.map((nset, i) => {
                const active = activeNsets.has(nset.name);
                const dotColor = nsetColors[i % nsetColors.length];
                return (
                  <div
                    key={nset.name}
                    className="flex items-center gap-2 p-1.5 rounded cursor-pointer text-xs transition-opacity"
                    style={{ backgroundColor: "var(--bg-card)", opacity: active ? 1 : 0.5 }}
                    onClick={() => toggleNset(nset.name)}
                  >
                    <span className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: active ? dotColor : "var(--bg-primary)" }} />
                    <span className="flex-1 truncate" style={{ color: "var(--text-primary)" }}>{nset.name}</span>
                    <span style={{ color: "var(--text-secondary)" }}>{nset.n_nodes} nodes</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Refresh */}
        {meshData && (
          <button
            onClick={fetchGeometry}
            disabled={loading}
            className="w-full px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
            style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}
          >
            {loading ? "Loading..." : "Refresh Geometry"}
          </button>
        )}
      </div>
    </div>
  );
}
