"use client";

import { useState, useEffect, useRef } from "react";

interface RunManagerProps {
  onStatusChange: (status: string) => void;
  onResultsLoaded: (data: unknown) => void;
}

interface SolverLog {
  time: string;
  message: string;
  type: "info" | "warning" | "error" | "success";
}

export default function RunManager({ onStatusChange, onResultsLoaded }: RunManagerProps) {
  const [logs, setLogs] = useState<SolverLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  function addLog(message: string, type: SolverLog["type"] = "info") {
    setLogs((prev) => [...prev, {
      time: new Date().toLocaleTimeString(),
      message,
      type,
    }]);
  }

  async function handleSolve() {
    setIsRunning(true);
    onStatusChange("running");
    setLogs([]);
    addLog("Starting solver...");

    // Connect WebSocket for live updates
    try {
      const ws = new WebSocket("ws://localhost:4000/ws");
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "log") {
          addLog(data.message, data.level || "info");
        } else if (data.type === "progress") {
          addLog(`Progress: ${data.percent}%`, "info");
        } else if (data.type === "done") {
          addLog("Solver completed!", "success");
          setIsRunning(false);
          onStatusChange("done");
          if (data.results) {
            onResultsLoaded(data.results);
          }
          ws.close();
        } else if (data.type === "error") {
          addLog(`Error: ${data.message}`, "error");
          setIsRunning(false);
          onStatusChange("error");
          ws.close();
        }
      };

      ws.onerror = () => {
        addLog("WebSocket connection failed, falling back to HTTP", "warning");
        ws.close();
        handleSolveHTTP();
      };

      ws.onopen = () => {
        addLog("Connected to solver", "info");
        ws.send(JSON.stringify({ action: "solve" }));
      };
    } catch {
      handleSolveHTTP();
    }
  }

  async function handleSolveHTTP() {
    try {
      addLog("Running solver via HTTP...", "info");
      const res = await fetch("/api/solve", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        addLog(`Error: ${data.error}`, "error");
        onStatusChange("error");
      } else {
        addLog("Solver completed!", "success");
        onStatusChange("done");
        onResultsLoaded(data);
      }
    } catch (err) {
      addLog(`Request failed: ${err}`, "error");
      onStatusChange("error");
    }
    setIsRunning(false);
  }

  function handleStop() {
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ action: "stop" }));
      wsRef.current.close();
    }
    setIsRunning(false);
    onStatusChange("idle");
    addLog("Solver stopped by user", "warning");
  }

  const logColors: Record<SolverLog["type"], string> = {
    info: "var(--text-secondary)",
    warning: "var(--warning)",
    error: "var(--danger)",
    success: "var(--success)",
  };

  return (
    <div className="p-4 flex flex-col h-full">
      <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--accent)" }}>
        Run Manager
      </h2>

      {/* Controls */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={handleSolve}
          disabled={isRunning}
          className="px-4 py-1.5 rounded text-xs font-medium disabled:opacity-50"
          style={{ backgroundColor: "var(--success)", color: "#fff" }}
        >
          {isRunning ? "Running..." : "Solve"}
        </button>
        {isRunning && (
          <button
            onClick={handleStop}
            className="px-4 py-1.5 rounded text-xs font-medium"
            style={{ backgroundColor: "var(--danger)", color: "#fff" }}
          >
            Stop
          </button>
        )}
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-y-auto rounded p-2 font-mono text-xs space-y-0.5"
           style={{ backgroundColor: "var(--bg-primary)" }}>
        {logs.length === 0 && (
          <p style={{ color: "var(--text-secondary)" }}>No solver output yet</p>
        )}
        {logs.map((log, i) => (
          <div key={i} style={{ color: logColors[log.type] }}>
            <span className="opacity-50">[{log.time}]</span> {log.message}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
