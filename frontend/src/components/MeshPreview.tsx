"use client";

import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";

export interface MeshGeometry {
  nodes: number[][];
  elements: number[][];
  n_nodes: number;
  n_elements: number;
  bounds: { min: number[]; max: number[] };
}

interface MeshPreviewProps {
  geometry: MeshGeometry;
}

/**
 * Gridap hex8 node ordering (structured grid style):
 *   Local:  0=(0,0,0) 1=(1,0,0) 2=(0,1,0) 3=(1,1,0)
 *           4=(0,0,1) 5=(1,0,1) 6=(0,1,1) 7=(1,1,1)
 *
 * Faces (quads, split into 2 triangles each):
 *   bottom (z=0): 0,1,3,2
 *   top    (z=1): 4,5,7,6  (but reversed for outward normal: 4,6,7,5)
 *   front  (y=0): 0,1,5,4
 *   back   (y=1): 2,3,7,6
 *   left   (x=0): 0,2,6,4
 *   right  (x=1): 1,3,7,5
 */
const HEX_FACES = [
  [0, 1, 3, 2], // bottom
  [4, 6, 7, 5], // top
  [0, 1, 5, 4], // front
  [2, 3, 7, 6], // back
  [0, 2, 6, 4], // left
  [1, 3, 7, 5], // right
];

const TET_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [0, 3, 2],
];

function MeshWireframe({ geometry }: { geometry: MeshGeometry }) {
  const { surfaceGeom, wireGeom } = useMemo(() => {
    const { nodes, elements, bounds } = geometry;

    // Center and scale
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const maxDim = Math.max(dx, dy, dz, 0.001);
    const s = 2.0 / maxDim;

    function transform(n: number[]): [number, number, number] {
      return [(n[0] - cx) * s, (n[1] - cy) * s, (n[2] - cz) * s];
    }

    // Count face occurrences to find boundary faces
    const faceMap = new Map<string, { nodeIndices: number[]; count: number }>();

    function addFace(globalNodeIds: number[]) {
      const key = [...globalNodeIds].sort((a, b) => a - b).join(",");
      const existing = faceMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        faceMap.set(key, { nodeIndices: globalNodeIds, count: 1 });
      }
    }

    for (const elem of elements) {
      if (elem.length === 4) {
        for (const face of TET_FACES) {
          addFace(face.map(i => elem[i]));
        }
      } else if (elem.length === 8) {
        for (const face of HEX_FACES) {
          addFace(face.map(i => elem[i]));
        }
      } else if (elem.length === 3) {
        addFace([elem[0], elem[1], elem[2]]);
      }
    }

    const surfaceVerts: number[] = [];
    const wireVerts: number[] = [];

    for (const { nodeIndices, count } of faceMap.values()) {
      // For volume meshes, only show boundary faces (shared by exactly 1 element)
      // For surface meshes (triangles only), show all faces
      const isVolumeMesh = elements[0]?.length > 3;
      if (isVolumeMesh && count !== 1) continue;

      // Triangulate the face
      const faceCoords = nodeIndices.map(idx => {
        const n = nodes[idx];
        return n ? transform(n) : null;
      });

      if (faceCoords.some(c => c === null)) continue;
      const coords = faceCoords as [number, number, number][];

      if (coords.length === 3) {
        // Single triangle
        for (const c of coords) {
          surfaceVerts.push(c[0], c[1], c[2]);
        }
      } else if (coords.length === 4) {
        // Quad → 2 triangles
        const triOrder = [
          [0, 1, 2],
          [0, 2, 3],
        ];
        for (const tri of triOrder) {
          for (const i of tri) {
            surfaceVerts.push(coords[i][0], coords[i][1], coords[i][2]);
          }
        }
      }

      // Wireframe edges
      for (let i = 0; i < coords.length; i++) {
        const a = coords[i];
        const b = coords[(i + 1) % coords.length];
        wireVerts.push(a[0], a[1], a[2]);
        wireVerts.push(b[0], b[1], b[2]);
      }
    }

    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(surfaceVerts, 3));
    sg.computeVertexNormals();

    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wireVerts, 3));

    return { surfaceGeom: sg, wireGeom: wg };
  }, [geometry]);

  return (
    <group>
      <mesh geometry={surfaceGeom}>
        <meshStandardMaterial
          color="#3a7bd5"
          transparent
          opacity={0.35}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={wireGeom}>
        <lineBasicMaterial color="#7ec8e3" opacity={0.7} transparent />
      </lineSegments>
    </group>
  );
}

export default function MeshPreview({ geometry }: MeshPreviewProps) {
  const [showInfo, setShowInfo] = useState(true);
  const { bounds, n_nodes, n_elements } = geometry;
  const dx = (bounds.max[0] - bounds.min[0]).toFixed(3);
  const dy = (bounds.max[1] - bounds.min[1]).toFixed(3);
  const dz = (bounds.max[2] - bounds.min[2]).toFixed(3);

  const elemType = geometry.elements[0]?.length === 4 ? "Tet4" :
                   geometry.elements[0]?.length === 8 ? "Hex8" :
                   geometry.elements[0]?.length === 3 ? "Tri3" : "Unknown";

  return (
    <div className="relative w-full h-full rounded-lg overflow-hidden border"
         style={{ borderColor: "var(--bg-card)", minHeight: 350 }}>
      <Canvas camera={{ position: [2.5, 2, 2.5], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 5, 5]} intensity={0.7} />
        <directionalLight position={[-3, -2, -4]} intensity={0.3} />
        <MeshWireframe geometry={geometry} />
        <OrbitControls enableDamping dampingFactor={0.1} />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport labelColor="white" axisHeadScale={0.8} />
        </GizmoHelper>
      </Canvas>

      {showInfo && (
        <div className="absolute top-2 left-2 p-2.5 rounded text-xs space-y-0.5"
             style={{ backgroundColor: "rgba(15, 52, 96, 0.9)" }}>
          <div className="flex justify-between items-center gap-4">
            <span className="font-semibold" style={{ color: "var(--accent)" }}>Mesh Preview</span>
            <button onClick={() => setShowInfo(false)} className="text-xs opacity-50 hover:opacity-100">hide</button>
          </div>
          <div style={{ color: "var(--text-secondary)" }}>
            Nodes: <span style={{ color: "var(--text-primary)" }}>{n_nodes.toLocaleString()}</span>
          </div>
          <div style={{ color: "var(--text-secondary)" }}>
            Elements: <span style={{ color: "var(--text-primary)" }}>{n_elements.toLocaleString()}</span>
            <span className="ml-1 opacity-60">({elemType})</span>
          </div>
          <div style={{ color: "var(--text-secondary)" }}>
            Size: <span style={{ color: "var(--text-primary)" }}>{dx} x {dy} x {dz}</span>
          </div>
        </div>
      )}
      {!showInfo && (
        <button
          onClick={() => setShowInfo(true)}
          className="absolute top-2 left-2 px-2 py-1 rounded text-xs"
          style={{ backgroundColor: "rgba(15, 52, 96, 0.85)", color: "var(--text-secondary)" }}
        >
          info
        </button>
      )}
    </div>
  );
}
