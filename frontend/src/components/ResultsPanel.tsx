"use client";

import { useState } from "react";

interface ResultsPanelProps {
  resultsData: unknown;
}

type StressComponent = "sigma_xx" | "sigma_yy" | "sigma_zz" | "tau_xy" | "tau_xz" | "tau_yz" | "sigma_1" | "sigma_2" | "sigma_3" | "von_mises";

export default function ResultsPanel({ resultsData }: ResultsPanelProps) {
  const [selectedField, setSelectedField] = useState<StressComponent>("sigma_zz");

  const stressFields: { id: StressComponent; label: string }[] = [
    { id: "sigma_xx", label: "σ_xx" },
    { id: "sigma_yy", label: "σ_yy" },
    { id: "sigma_zz", label: "σ_zz" },
    { id: "tau_xy", label: "τ_xy" },
    { id: "tau_xz", label: "τ_xz" },
    { id: "tau_yz", label: "τ_yz" },
    { id: "sigma_1", label: "σ₁" },
    { id: "sigma_2", label: "σ₂" },
    { id: "sigma_3", label: "σ₃" },
    { id: "von_mises", label: "Von Mises" },
  ];

  const data = resultsData as Record<string, unknown> | null;

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <p style={{ color: "var(--text-secondary)" }}>
          No results available. Run a simulation first.
        </p>
      </div>
    );
  }

  async function handleExportVTK() {
    try {
      const res = await fetch("/api/results/export?format=vtk");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "results.vtu";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }

  async function handleExportCSV() {
    try {
      const res = await fetch("/api/results/export?format=csv");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "results.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }

  return (
    <div className="p-6 overflow-y-auto h-full max-w-6xl mx-auto space-y-6">
      {/* Field Selector */}
      <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--accent)" }}>
          Stress/Strain Field
        </h2>
        <div className="flex flex-wrap gap-2">
          {stressFields.map((field) => (
            <button
              key={field.id}
              onClick={() => setSelectedField(field.id)}
              className="px-3 py-1.5 rounded text-sm font-medium transition-colors"
              style={{
                backgroundColor: selectedField === field.id ? "var(--accent)" : "var(--bg-card)",
                color: selectedField === field.id ? "#fff" : "var(--text-secondary)",
              }}
            >
              {field.label}
            </button>
          ))}
        </div>
      </section>

      {/* Summary Statistics */}
      <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--accent)" }}>
          Summary
        </h2>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: "Min", value: data.min_stress, unit: "MPa" },
            { label: "Max", value: data.max_stress, unit: "MPa" },
            { label: "Mean", value: data.mean_stress, unit: "MPa" },
            { label: "Max displacement", value: data.max_displacement, unit: "mm" },
          ].map((stat) => (
            <div key={stat.label} className="p-3 rounded" style={{ backgroundColor: "var(--bg-card)" }}>
              <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{stat.label}</div>
              <div className="text-lg font-semibold">
                {stat.value != null ? Number(stat.value).toFixed(3) : "—"} {stat.unit}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Export */}
      <section className="p-4 rounded-lg" style={{ backgroundColor: "var(--bg-secondary)" }}>
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--accent)" }}>
          Export
        </h2>
        <div className="flex gap-3">
          <button
            onClick={handleExportVTK}
            className="px-4 py-2 rounded text-sm font-medium"
            style={{ backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }}
          >
            Download VTK (.vtu)
          </button>
          <button
            onClick={handleExportCSV}
            className="px-4 py-2 rounded text-sm font-medium"
            style={{ backgroundColor: "var(--bg-card)", color: "var(--text-primary)" }}
          >
            Download CSV
          </button>
        </div>
      </section>
    </div>
  );
}
