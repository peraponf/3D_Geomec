"""3D linear elasticity solver using Gridap."""

"""
    σ_fun(ε, λ, μ)

Hooke's law for isotropic linear elasticity.
σ = λ tr(ε) I + 2μ ε
"""
function σ_fun(ε, λ, μ)
    d = num_components(ε) == 3 ? 2 : 3  # 2D or 3D
    λ * tr(ε) * one(ε) + 2 * μ * ε
end

"""
    compute_principal_stresses(σ_tensor)

Compute principal stresses and directions from a symmetric stress tensor.
Returns (σ₁, σ₂, σ₃) sorted σ₁ ≥ σ₂ ≥ σ₃ (tension positive).
"""
function compute_principal_stresses(σ_voigt::AbstractVector{Float64})
    # Convert Voigt notation [σxx, σyy, σzz, σxy, σxz, σyz] to matrix
    σ_mat = [σ_voigt[1]  σ_voigt[4]  σ_voigt[5];
             σ_voigt[4]  σ_voigt[2]  σ_voigt[6];
             σ_voigt[5]  σ_voigt[6]  σ_voigt[3]]
    vals = eigvals(Symmetric(σ_mat))
    return sort(vals, rev=true)  # σ₁ ≥ σ₂ ≥ σ₃
end

"""
    von_mises(σ₁, σ₂, σ₃)

Von Mises equivalent stress.
"""
von_mises(σ₁, σ₂, σ₃) = sqrt(0.5 * ((σ₁ - σ₂)^2 + (σ₂ - σ₃)^2 + (σ₃ - σ₁)^2))

"""
    solve_elasticity(mesh_path, material;
                     dirichlet_tags, dirichlet_values,
                     neumann_tags, neumann_values,
                     body_force, output_path, order)

Solve a 3D linear elasticity problem using Gridap.

# Arguments
- `mesh_path::String` — path to .msh file
- `material::ElasticMaterial` — material properties

# Keyword Arguments
- `dirichlet_tags::Vector{String}` — boundary names for Dirichlet BCs
- `dirichlet_values::Vector` — displacement values for each Dirichlet tag
- `neumann_tags::Vector{String}` — boundary names for Neumann BCs (optional)
- `neumann_values::Vector` — traction vectors for each Neumann tag (optional)
- `body_force::VectorValue{3,Float64}` — body force vector (default: gravity)
- `output_path::String` — path for VTK output (default: "results")
- `order::Int` — polynomial order (default: 1)

# Returns
Named tuple: `(uh, σh, model, Ω)` — displacement, stress, model, triangulation
"""
function solve_elasticity(mesh_path::String, material::ElasticMaterial;
                          dirichlet_tags::Vector{String} = ["bottom"],
                          dirichlet_values::Vector = [VectorValue(0.0, 0.0, 0.0)],
                          neumann_tags::Vector{String} = String[],
                          neumann_values::Vector = [],
                          body_force::VectorValue{3,Float64} = VectorValue(0.0, 0.0, -material.ρ * 9.81),
                          output_path::String = "results",
                          order::Int = 1)

    # Lamé parameters
    λ = lame_lambda(material)
    μ = lame_mu(material)

    println("Solving 3D elasticity:")
    println("  E = $(material.E/1e9) GPa, ν = $(material.ν), ρ = $(material.ρ) kg/m³")
    println("  λ = $(λ/1e9) GPa, μ = $(μ/1e9) GPa")
    println("  Mesh: $mesh_path")

    # Load mesh
    model = GmshDiscreteModel(mesh_path)

    # Triangulation and measures
    Ω = Triangulation(model)
    dΩ = Measure(Ω, 2 * order)

    # FE spaces
    reffe = ReferenceFE(lagrangian, VectorValue{3,Float64}, order)
    V = TestFESpace(model, reffe;
                    conformity=:H1,
                    dirichlet_tags=dirichlet_tags)
    U = TrialFESpace(V, dirichlet_values)

    println("  DOFs: $(num_free_dofs(V))")

    # Constitutive law
    σ(ε) = λ * tr(ε) * one(ε) + 2 * μ * ε

    # Bilinear form (stiffness)
    a(u, v) = ∫(ε(v) ⊙ (σ ∘ ε(u))) * dΩ

    # Linear form (body force + Neumann BCs)
    l(v) = ∫(v ⋅ body_force) * dΩ

    # Add Neumann BCs if specified
    if !isempty(neumann_tags)
        for (tag, traction) in zip(neumann_tags, neumann_values)
            Γ_N = BoundaryTriangulation(model, tags=[tag])
            dΓ_N = Measure(Γ_N, 2 * order)
            l_N(v) = ∫(v ⋅ traction) * dΓ_N
            l = (v) -> ∫(v ⋅ body_force) * dΩ + l_N(v)
        end
    end

    # Assemble and solve
    println("  Assembling...")
    op = AffineFEOperator(a, l, U, V)
    println("  Solving...")
    uh = solve(op)

    # Compute stress field
    σh = σ ∘ ε(uh)

    # Export to VTK
    println("  Exporting VTK to: $(output_path).vtu")
    writevtk(Ω, output_path,
             cellfields=["displacement" => uh,
                         "stress" => σh,
                         "strain" => ε(uh)])

    println("  Done!")

    return (uh=uh, σh=σh, model=model, Ω=Ω)
end
