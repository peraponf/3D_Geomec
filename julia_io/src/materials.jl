"""Material property definitions for geomechanics simulations."""

"""
    ElasticMaterial(E, ν, ρ)

Isotropic linear elastic material.

# Fields
- `E::Float64` — Young's modulus [Pa]
- `ν::Float64` — Poisson's ratio [-]
- `ρ::Float64` — Density [kg/m³]
"""
struct ElasticMaterial
    E::Float64   # Young's modulus [Pa]
    ν::Float64   # Poisson's ratio [-]
    ρ::Float64   # Density [kg/m³]

    function ElasticMaterial(E, ν, ρ)
        E > 0 || error("Young's modulus must be positive, got E=$E")
        0 < ν < 0.5 || error("Poisson's ratio must be in (0, 0.5), got ν=$ν")
        ρ > 0 || error("Density must be positive, got ρ=$ρ")
        new(Float64(E), Float64(ν), Float64(ρ))
    end
end

"""Lamé's first parameter λ = Eν / ((1+ν)(1-2ν))"""
lame_lambda(m::ElasticMaterial) = m.E * m.ν / ((1 + m.ν) * (1 - 2 * m.ν))

"""Shear modulus μ = E / (2(1+ν))"""
lame_mu(m::ElasticMaterial) = m.E / (2 * (1 + m.ν))

"""Bulk modulus K = E / (3(1-2ν))"""
bulk_modulus(m::ElasticMaterial) = m.E / (3 * (1 - 2 * m.ν))

# Common rock materials (typical values)
const SANDSTONE = ElasticMaterial(20e9, 0.25, 2400.0)   # 20 GPa, ν=0.25
const SHALE     = ElasticMaterial(5e9,  0.30, 2500.0)   # 5 GPa,  ν=0.30
const LIMESTONE = ElasticMaterial(40e9, 0.28, 2700.0)   # 40 GPa, ν=0.28
const GRANITE   = ElasticMaterial(60e9, 0.20, 2650.0)   # 60 GPa, ν=0.20
