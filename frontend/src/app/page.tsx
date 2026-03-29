"use client";

import { useState } from "react";
import ModelSetup from "@/components/ModelSetup";
import Viewer3D from "@/components/Viewer3D";
import RunManager from "@/components/RunManager";
import ResultsPanel from "@/components/ResultsPanel";

type Tab = "setup" | "viewer" | "results";

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("setup");
  const [meshData, setMeshData] = useState<unknown>(null);
  const [resultsData, setResultsData] = useState<unknown>(null);
  const [solverStatus, setSolverStatus] = useState<string>("idle");

  const tabs: { id: Tab; label: string }[] = [
    { id: "setup", label: "Model Setup" },
    { id: "viewer", label: "3D Viewer" },
    { id: "results", label: "Results" },
  ];

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--bg-card)]"
              style={{ backgroundColor: "var(--bg-secondary)" }}>
        <h1 className="text-xl font-bold" style={{ color: "var(--accent)" }}>
          3D Geomec
        </h1>
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          <span className={`w-2 h-2 rounded-full ${
            solverStatus === "running" ? "bg-yellow-400 animate-pulse" :
            solverStatus === "done" ? "bg-green-400" : "bg-gray-500"
          }`} />
          Solver: {solverStatus}
        </div>
      </header>

      {/* Tab bar */}
      <nav className="flex gap-1 px-6 pt-2" style={{ backgroundColor: "var(--bg-secondary)" }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-t text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "text-white"
                : "hover:text-white"
            }`}
            style={{
              backgroundColor: activeTab === tab.id ? "var(--bg-primary)" : "transparent",
              color: activeTab === tab.id ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 overflow-hidden relative">
        <div className={activeTab === "setup" ? "h-full" : "hidden"}>
          <ModelSetup onMeshLoaded={(data) => {
            setMeshData(data);
            setActiveTab("viewer");
          }} />
        </div>
        <div className={activeTab === "viewer" ? "h-full" : "hidden"}>
          <Viewer3D meshData={meshData} resultsData={resultsData} />
        </div>
        <div className={activeTab === "results" ? "h-full" : "hidden"}>
          <ResultsPanel resultsData={resultsData} />
        </div>
      </main>
    </div>
  );
}
