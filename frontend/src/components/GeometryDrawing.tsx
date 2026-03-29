// @ts-nocheck
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Canvas as FabricCanvas, Rect, Circle, Ellipse, Polygon, Line, FabricText } from "fabric";

interface GeometryDrawingProps {
  onGeometryReady: (geometries: GeometryItem[], scale: { x: number; y: number; originX: number; originY: number }) => void;
}

interface GeometryItem {
  id: string;
  type: "rectangle" | "circle" | "ellipse" | "polygon";
  role: "domain" | "hole" | "inclusion";
  material?: string;
  // Geometry params (in real-world coordinates)
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  rx?: number;
  ry?: number;
  angle?: number;
  points?: { x: number; y: number }[];
}

const COLORS = {
  domain: "rgba(100, 150, 200, 0.3)",
  hole: "rgba(50, 50, 50, 0.5)",
  inclusion: "rgba(200, 100, 100, 0.3)",
  stroke: "#4ea8de",
  grid: "#2a2a4a",
};

export default function GeometryDrawing({ onGeometryReady }: GeometryDrawingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<FabricCanvas | null>(null);
  const [tool, setTool] = useState<"select" | "rectangle" | "circle" | "ellipse">("select");
  const [role, setRole] = useState<"domain" | "hole" | "inclusion">("domain");
  const [geometries, setGeometries] = useState<GeometryItem[]>([]);
  const [canvasSize] = useState({ w: 700, h: 500 });
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [bgOpacity, setBgOpacity] = useState(0.4);
  const [scale, setScale] = useState({ unitsPerPixel: 0.05, originX: 0, originY: 0 });
  const [gridSpacing, setGridSpacing] = useState(1.0); // meters
  const drawingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const tempObjRef = useRef<any>(null);
  const idCounter = useRef(0);

  // Initialize Fabric canvas
  useEffect(() => {
    if (!canvasRef.current || fabricRef.current) return;

    const fc = new FabricCanvas(canvasRef.current, {
      width: canvasSize.w,
      height: canvasSize.h,
      backgroundColor: "#1a1a2e",
      selection: true,
    });

    fabricRef.current = fc;
    drawGrid(fc);

    return () => {
      fc.dispose();
      fabricRef.current = null;
    };
  }, []);

  function drawGrid(fc: FabricCanvas) {
    // Remove old grid lines
    fc.getObjects().filter((o: any) => o._isGrid).forEach((o: any) => fc.remove(o));

    const pxPerUnit = 1 / scale.unitsPerPixel;
    const step = gridSpacing * pxPerUnit;

    if (step < 10) return; // too dense

    for (let x = 0; x < canvasSize.w; x += step) {
      const line = new Line([x, 0, x, canvasSize.h], {
        stroke: COLORS.grid, strokeWidth: 0.5, selectable: false, evented: false,
      });
      (line as any)._isGrid = true;
      fc.add(line);
      fc.sendObjectToBack(line);
    }
    for (let y = 0; y < canvasSize.h; y += step) {
      const line = new Line([0, y, canvasSize.w, y], {
        stroke: COLORS.grid, strokeWidth: 0.5, selectable: false, evented: false,
      });
      (line as any)._isGrid = true;
      fc.add(line);
      fc.sendObjectToBack(line);
    }

    // Axis labels
    const labelStep = gridSpacing * 2;
    for (let rx = scale.originX; rx < scale.originX + canvasSize.w * scale.unitsPerPixel; rx += labelStep) {
      const px = (rx - scale.originX) / scale.unitsPerPixel;
      if (px > 10 && px < canvasSize.w - 10) {
        const t = new FabricText(rx.toFixed(1), {
          left: px, top: canvasSize.h - 14, fontSize: 9,
          fill: "#555", selectable: false, evented: false,
        });
        (t as any)._isGrid = true;
        fc.add(t);
      }
    }
    for (let ry = scale.originY; ry < scale.originY + canvasSize.h * scale.unitsPerPixel; ry += labelStep) {
      const py = canvasSize.h - (ry - scale.originY) / scale.unitsPerPixel;
      if (py > 10 && py < canvasSize.h - 10) {
        const t = new FabricText(ry.toFixed(1), {
          left: 2, top: py - 5, fontSize: 9,
          fill: "#555", selectable: false, evented: false,
        });
        (t as any)._isGrid = true;
        fc.add(t);
      }
    }
  }

  // Convert pixel to real-world coords
  function px2real(px: number, py: number): [number, number] {
    return [
      scale.originX + px * scale.unitsPerPixel,
      scale.originY + (canvasSize.h - py) * scale.unitsPerPixel, // Y flipped
    ];
  }

  function real2px(rx: number, ry: number): [number, number] {
    return [
      (rx - scale.originX) / scale.unitsPerPixel,
      canvasSize.h - (ry - scale.originY) / scale.unitsPerPixel,
    ];
  }

  // Mouse handlers for drawing
  useEffect(() => {
    const fc = fabricRef.current;
    if (!fc) return;

    function onMouseDown(opt: any) {
      if (tool === "select") return;
      drawingRef.current = true;
      const pointer = fc.getScenePoint(opt.e);
      startRef.current = { x: pointer.x, y: pointer.y };

      let obj: any;
      const fillColor = COLORS[role];

      if (tool === "rectangle") {
        obj = new Rect({
          left: pointer.x, top: pointer.y, width: 0, height: 0,
          fill: fillColor, stroke: COLORS.stroke, strokeWidth: 1.5,
        });
      } else if (tool === "circle") {
        obj = new Circle({
          left: pointer.x, top: pointer.y, radius: 0,
          fill: fillColor, stroke: COLORS.stroke, strokeWidth: 1.5,
        });
      } else if (tool === "ellipse") {
        obj = new Ellipse({
          left: pointer.x, top: pointer.y, rx: 0, ry: 0,
          fill: fillColor, stroke: COLORS.stroke, strokeWidth: 1.5,
        });
      }

      if (obj) {
        (obj as any)._role = role;
        (obj as any)._geoId = `geo_${++idCounter.current}`;
        fc.add(obj);
        tempObjRef.current = obj;
      }
    }

    function onMouseMove(opt: any) {
      if (!drawingRef.current || !tempObjRef.current) return;
      const pointer = fc.getScenePoint(opt.e);
      const sx = startRef.current.x;
      const sy = startRef.current.y;
      const dx = pointer.x - sx;
      const dy = pointer.y - sy;

      const obj = tempObjRef.current;
      if (tool === "rectangle") {
        obj.set({
          left: dx > 0 ? sx : pointer.x,
          top: dy > 0 ? sy : pointer.y,
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
      } else if (tool === "circle") {
        const r = Math.sqrt(dx * dx + dy * dy);
        obj.set({ radius: r });
      } else if (tool === "ellipse") {
        obj.set({ rx: Math.abs(dx), ry: Math.abs(dy) });
      }

      fc.renderAll();
    }

    function onMouseUp() {
      if (!drawingRef.current || !tempObjRef.current) return;
      drawingRef.current = false;

      const obj = tempObjRef.current;
      tempObjRef.current = null;

      // Convert to real-world geometry
      const [rx, ry] = px2real(obj.left, obj.top + (obj.height || obj.ry * 2 || obj.radius * 2 || 0));
      const geo: GeometryItem = {
        id: (obj as any)._geoId,
        type: tool as GeometryItem["type"],
        role: (obj as any)._role,
        x: rx,
        y: ry,
        angle: 0,
      };

      if (tool === "rectangle") {
        geo.width = obj.width * scale.unitsPerPixel;
        geo.height = obj.height * scale.unitsPerPixel;
      } else if (tool === "circle") {
        geo.radius = obj.radius * scale.unitsPerPixel;
        geo.x = rx + obj.radius * scale.unitsPerPixel; // center
        geo.y = ry + obj.radius * scale.unitsPerPixel;
      } else if (tool === "ellipse") {
        geo.rx = obj.rx * scale.unitsPerPixel;
        geo.ry = obj.ry * scale.unitsPerPixel;
        geo.x = rx + obj.rx * scale.unitsPerPixel;
        geo.y = ry + obj.ry * scale.unitsPerPixel;
      }

      setGeometries(prev => [...prev, geo]);
      setTool("select");
    }

    fc.on("mouse:down", onMouseDown);
    fc.on("mouse:move", onMouseMove);
    fc.on("mouse:up", onMouseUp);

    return () => {
      fc.off("mouse:down", onMouseDown);
      fc.off("mouse:move", onMouseMove);
      fc.off("mouse:up", onMouseUp);
    };
  }, [tool, role, scale]);

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !fabricRef.current) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      setBgImage(dataUrl);

      const fc = fabricRef.current!;
      // Remove old background image
      fc.getObjects().filter((o: any) => o._isBgImage).forEach((o: any) => fc.remove(o));

      const imgEl = new Image();
      imgEl.onload = () => {
        const { FabricImage } = require("fabric");
        const scaleX = canvasSize.w / imgEl.width;
        const scaleY = canvasSize.h / imgEl.height;
        const s = Math.min(scaleX, scaleY);

        const fabricImg = new FabricImage(imgEl, {
          left: 0, top: 0,
          scaleX: s, scaleY: s,
          opacity: bgOpacity,
          selectable: false,
          evented: false,
        });
        (fabricImg as any)._isBgImage = true;
        fc.add(fabricImg);
        fc.sendObjectToBack(fabricImg);
        // Send grid behind image
        fc.getObjects().filter((o: any) => o._isGrid).forEach((o: any) => fc.sendObjectToBack(o));
        fc.renderAll();
      };
      imgEl.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function updateBgOpacity(opacity: number) {
    setBgOpacity(opacity);
    const fc = fabricRef.current;
    if (!fc) return;
    fc.getObjects().filter((o: any) => o._isBgImage).forEach((o: any) => {
      o.set("opacity", opacity);
    });
    fc.renderAll();
  }

  function clearAll() {
    const fc = fabricRef.current;
    if (!fc) return;
    fc.getObjects().filter((o: any) => !o._isGrid).forEach((o: any) => fc.remove(o));
    fc.renderAll();
    setGeometries([]);
  }

  function deleteSelected() {
    const fc = fabricRef.current;
    if (!fc) return;
    const active = fc.getActiveObjects();
    active.forEach((obj: any) => {
      const geoId = obj._geoId;
      if (geoId) {
        setGeometries(prev => prev.filter(g => g.id !== geoId));
      }
      fc.remove(obj);
    });
    fc.discardActiveObject();
    fc.renderAll();
  }

  function handleExport() {
    onGeometryReady(geometries, {
      x: scale.unitsPerPixel,
      y: scale.unitsPerPixel,
      originX: scale.originX,
      originY: scale.originY,
    });
  }

  const hasDomain = geometries.some(g => g.role === "domain");
  const hasHoleOrInclusion = geometries.some(g => g.role === "hole" || g.role === "inclusion");

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Tool:</span>
        {(["select", "rectangle", "circle", "ellipse"] as const).map(t => (
          <button key={t} onClick={() => setTool(t)}
            className="px-3 py-1 rounded text-xs font-medium capitalize"
            style={{
              backgroundColor: tool === t ? "var(--accent)" : "var(--bg-card)",
              color: tool === t ? "#fff" : "var(--text-secondary)",
            }}>{t}</button>
        ))}

        <span className="ml-3 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Role:</span>
        {(["domain", "hole", "inclusion"] as const).map(r => (
          <button key={r} onClick={() => setRole(r)}
            className="px-3 py-1 rounded text-xs font-medium capitalize"
            style={{
              backgroundColor: role === r ? (r === "domain" ? "#3a7bd5" : r === "hole" ? "#555" : "#d35050") : "var(--bg-card)",
              color: role === r ? "#fff" : "var(--text-secondary)",
            }}>{r}</button>
        ))}

        <span className="ml-3 text-xs" style={{ color: "var(--text-secondary)" }}>
          Grid: <input type="number" step="0.5" min="0.1" value={gridSpacing}
            onChange={e => { setGridSpacing(parseFloat(e.target.value) || 1); if (fabricRef.current) drawGrid(fabricRef.current); }}
            className="w-14 px-1 py-0.5 rounded text-xs"
            style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
          /> m
        </span>

        <div className="ml-auto flex gap-1">
          <button onClick={deleteSelected} className="px-2 py-1 rounded text-xs"
            style={{ backgroundColor: "var(--bg-card)", color: "var(--danger)" }}>Delete</button>
          <button onClick={clearAll} className="px-2 py-1 rounded text-xs"
            style={{ backgroundColor: "var(--bg-card)", color: "var(--text-secondary)" }}>Clear</button>
        </div>
      </div>

      {/* Background image */}
      <div className="flex items-center gap-3 text-xs" style={{ color: "var(--text-secondary)" }}>
        <label className="px-3 py-1 rounded cursor-pointer text-xs font-medium"
               style={{ backgroundColor: "var(--bg-card)", color: "var(--accent)" }}>
          Upload Background Image
          <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
        </label>
        {bgImage && (
          <>
            <span>Opacity:</span>
            <input type="range" min={0} max={1} step={0.05} value={bgOpacity}
              onChange={e => updateBgOpacity(parseFloat(e.target.value))}
              className="w-24" />
            <span>{(bgOpacity * 100).toFixed(0)}%</span>
          </>
        )}
      </div>

      {/* Scale controls */}
      <div className="flex items-center gap-3 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span>Scale:</span>
        <label>m/px: <input type="number" step="0.01" min="0.001" value={scale.unitsPerPixel}
          onChange={e => setScale({ ...scale, unitsPerPixel: parseFloat(e.target.value) || 0.05 })}
          className="w-16 px-1 py-0.5 rounded"
          style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
        /></label>
        <label>Origin X: <input type="number" step="1" value={scale.originX}
          onChange={e => setScale({ ...scale, originX: parseFloat(e.target.value) || 0 })}
          className="w-16 px-1 py-0.5 rounded"
          style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
        /></label>
        <label>Origin Y: <input type="number" step="1" value={scale.originY}
          onChange={e => setScale({ ...scale, originY: parseFloat(e.target.value) || 0 })}
          className="w-16 px-1 py-0.5 rounded"
          style={{ backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
        /></label>
        <span className="ml-2">
          Canvas: {(canvasSize.w * scale.unitsPerPixel).toFixed(1)} x {(canvasSize.h * scale.unitsPerPixel).toFixed(1)} m
        </span>
      </div>

      {/* Canvas */}
      <div className="rounded border" style={{ borderColor: "var(--bg-card)" }}>
        <canvas ref={canvasRef} />
      </div>

      {/* Geometry list */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
          Drawn Geometries ({geometries.length})
        </h4>
        {geometries.map(g => (
          <div key={g.id} className="flex items-center gap-2 text-xs p-1 rounded"
            style={{ backgroundColor: "var(--bg-card)" }}>
            <span className="w-2 h-2 rounded-full"
              style={{ backgroundColor: g.role === "domain" ? "#3a7bd5" : g.role === "hole" ? "#555" : "#d35050" }} />
            <span style={{ color: "var(--text-primary)" }}>{g.type}</span>
            <span style={{ color: "var(--text-secondary)" }}>({g.role})</span>
            <span style={{ color: "var(--text-secondary)" }}>
              {g.type === "rectangle" ? `${g.width?.toFixed(2)} x ${g.height?.toFixed(2)} m` :
               g.type === "circle" ? `r=${g.radius?.toFixed(2)} m` :
               g.type === "ellipse" ? `${g.rx?.toFixed(2)} x ${g.ry?.toFixed(2)} m` : ""}
            </span>
          </div>
        ))}
      </div>

      {/* Export */}
      <button
        onClick={handleExport}
        disabled={!hasDomain}
        className="px-5 py-2 rounded font-medium text-sm disabled:opacity-40"
        style={{ backgroundColor: "var(--accent)", color: "#fff" }}
      >
        Generate Mesh from Drawing
      </button>
      {!hasDomain && (
        <p className="text-xs" style={{ color: "var(--warning)" }}>
          Draw at least one "domain" rectangle first.
        </p>
      )}
    </div>
  );
}
