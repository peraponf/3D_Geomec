"""
Test: Parse Abaqus .inp file and run elasticity solver.
"""

using Pkg
Pkg.activate(joinpath(@__DIR__, ".."))

include(joinpath(@__DIR__, "..", "src", "GeomecSolver.jl"))
using .GeomecSolver
using Gridap

# --- 1. Parse Abaqus file ---
inp_path = joinpath(@__DIR__, "sample_box.inp")
println("=== Parsing Abaqus .inp ===")
abq = read_abaqus(inp_path)

# --- 2. Convert to Gmsh format ---
println("\n=== Converting to .msh ===")
msh_path = joinpath(@__DIR__, "sample_box.msh")
abaqus_to_msh(abq, msh_path; bc_nsets=["BOTTOM", "TOP"])

# --- 3. Load into Gridap and solve ---
println("\n=== Solving ===")
sandstone = ElasticMaterial(20e9, 0.25, 2400.0)

result = solve_elasticity(
    msh_path, sandstone;
    dirichlet_tags = ["BOTTOM"],
    dirichlet_values = [VectorValue(0.0, 0.0, 0.0)],
    neumann_tags = ["TOP"],
    neumann_values = [VectorValue(0.0, 0.0, -10e6)],
    body_force = VectorValue(0.0, 0.0, 0.0),
    output_path = joinpath(@__DIR__, "abaqus_results")
)

println("\n=== Done ===")
println("VTK output: $(joinpath(@__DIR__, "abaqus_results")).vtu")
