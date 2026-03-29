module GeomecSolver

using Gridap
using GridapGmsh
using Gmsh
using WriteVTK
using LinearAlgebra

include("mesh.jl")
include("materials.jl")
include("elasticity.jl")
include("abaqus_reader.jl")
include("abaqus_to_gridap.jl")
include("gocad_reader.jl")
include("gocad_to_gridap.jl")
include("mesh_export.jl")
include("geometry_templates.jl")

export generate_box_mesh
export ElasticMaterial, SANDSTONE, SHALE, LIMESTONE, GRANITE
export lame_lambda, lame_mu, bulk_modulus
export solve_elasticity, compute_principal_stresses, von_mises
export read_abaqus, abaqus_to_msh, abaqus_to_gridap
export AbaqusModel, AbaqusNode, AbaqusElement, AbaqusMaterial
export read_tsurf, read_voxet, read_sgrid
export tsurf_to_msh, sgrid_to_msh, voxet_to_msh
export GocadTSurf, GocadVoxet, GocadSGrid, VoxetAxis
export extract_sgrid_elsets
export extract_boundary_surface
export generate_borehole_kirsch, generate_eshelby_inclusion

end # module
