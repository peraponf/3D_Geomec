"""
Test: Parse GOCAD files and convert to Gmsh .msh format.
"""

using Pkg
Pkg.activate(joinpath(@__DIR__, ".."))

include(joinpath(@__DIR__, "..", "src", "GeomecSolver.jl"))
using .GeomecSolver

# --- 1. Test TSurf parsing ---
println("=" ^ 50)
println("Test 1: TSurf (horizon surface)")
println("=" ^ 50)
ts_path = joinpath(@__DIR__, "sample_horizon.ts")
tsurf = read_tsurf(ts_path)

msh_path = joinpath(@__DIR__, "horizon.msh")
tsurf_to_msh(tsurf, msh_path)

# --- 2. Test SGrid parsing ---
println("\n" * "=" ^ 50)
println("Test 2: SGrid (tetrahedral volume)")
println("=" ^ 50)
sg_path = joinpath(@__DIR__, "sample_grid.sg")
sgrid = read_sgrid(sg_path)

msh_path2 = joinpath(@__DIR__, "sgrid.msh")
sgrid_to_msh(sgrid, msh_path2)

# --- 3. Test Voxet (programmatic — no binary file) ---
println("\n" * "=" ^ 50)
println("Test 3: Voxet (regular grid)")
println("=" ^ 50)

# Create a voxet manually to test the converter
voxet = GocadVoxet(
    "Test_Voxet",
    [0.0, 0.0, 0.0],
    [VoxetAxis(0.0, 0.5, 4), VoxetAxis(0.0, 0.5, 4), VoxetAxis(0.0, 0.5, 4)],
    Dict{String, Array{Float64,3}}()
)
msh_path3 = joinpath(@__DIR__, "voxet.msh")
voxet_to_msh(voxet, msh_path3)

println("\n=== All GOCAD tests passed ===")
