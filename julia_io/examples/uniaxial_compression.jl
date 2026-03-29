"""
Validation: Uniaxial compression of a 1m × 1m × 1m box.

Setup:
- Bottom face fixed (u = 0)
- Top face: uniform downward pressure of 10 MPa
- No body forces (gravity off)
- Material: sandstone (E=20 GPa, ν=0.25)

Analytical solution:
- σ_zz = -10 MPa (uniform)
- ε_zz = σ_zz / E = -10e6 / 20e9 = -5e-4
- ε_xx = ε_yy = -ν * ε_zz = 0.25 * 5e-4 = 1.25e-4
- u_z(top) = ε_zz * Lz = -5e-4 * 1.0 = -5e-4 m
"""

using Pkg
Pkg.activate(joinpath(@__DIR__, ".."))

# Include module directly for development
include(joinpath(@__DIR__, "..", "src", "GeomecSolver.jl"))
using .GeomecSolver
using Gridap

# --- 1. Generate mesh ---
mesh_path = joinpath(@__DIR__, "box.msh")
mesh = generate_box_mesh(mesh_path; Lx=1.0, Ly=1.0, Lz=1.0, nx=5, ny=5, nz=5)

# --- 2. Define material ---
sandstone = ElasticMaterial(20e9, 0.25, 2400.0)

# --- 3. Solve ---
output_path = joinpath(@__DIR__, "uniaxial_results")

result = solve_elasticity(
    mesh_path, sandstone;
    dirichlet_tags = ["bottom"],
    dirichlet_values = [VectorValue(0.0, 0.0, 0.0)],
    neumann_tags = ["top"],
    neumann_values = [VectorValue(0.0, 0.0, -10e6)],  # 10 MPa compression
    body_force = VectorValue(0.0, 0.0, 0.0),           # no gravity
    output_path = output_path
)

# --- 4. Validate against analytical solution ---
println("\n=== Validation ===")
E = 20e9
ν = 0.25
σ_applied = -10e6  # compression

ε_zz_exact = σ_applied / E
u_z_exact = ε_zz_exact * 1.0  # Lz = 1.0

println("Analytical:")
println("  σ_zz = $(σ_applied/1e6) MPa")
println("  ε_zz = $(ε_zz_exact)")
println("  u_z(top) = $(u_z_exact*1e3) mm")
println("\nVTK output: $(output_path).vtu")
println("Open in ParaView to inspect stress/strain fields.")
