"""
Generate a ~2M element partitioned mesh: 3-layer geological model.
- Overburden (shale)
- Reservoir (sandstone)
- Underburden (limestone)

Each layer is a separate physical volume (partition).
Uses Gmsh structured hex meshing for efficiency.
"""

using Pkg
Pkg.activate(joinpath(@__DIR__, ".."))

include(joinpath(@__DIR__, "..", "src", "GeomecSolver.jl"))
using .GeomecSolver
using Gmsh
using JSON

function generate_large_partitioned_mesh(output_path::String;
                                          nx::Int=100, ny::Int=100, nz_per_layer::Int=22)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 2)
    gmsh.model.add("layered_model")

    # Model dimensions: 1000m x 1000m x 300m (3 layers of 100m each)
    Lx, Ly = 1000.0, 1000.0
    layer_thickness = 100.0

    # Create 3 stacked boxes
    # Layer 1: Underburden (limestone) z=0 to 100
    box1 = gmsh.model.occ.addBox(0, 0, 0, Lx, Ly, layer_thickness)
    # Layer 2: Reservoir (sandstone) z=100 to 200
    box2 = gmsh.model.occ.addBox(0, 0, layer_thickness, Lx, Ly, layer_thickness)
    # Layer 3: Overburden (shale) z=200 to 300
    box3 = gmsh.model.occ.addBox(0, 0, 2*layer_thickness, Lx, Ly, layer_thickness)

    # Fragment to create shared interfaces
    out, outmap = gmsh.model.occ.fragment([(3, box1), (3, box2), (3, box3)], [])
    gmsh.model.occ.synchronize()

    # Get resulting volumes
    volumes = gmsh.model.getEntities(3)
    println("Volumes after fragment: ", length(volumes))

    # Assign physical groups based on z-centroid
    for (dim, tag) in volumes
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.occ.getBoundingBox(dim, tag)
        z_center = (zmin + zmax) / 2

        if z_center < layer_thickness
            pg = gmsh.model.addPhysicalGroup(3, [tag])
            gmsh.model.setPhysicalName(3, pg, "Underburden_Limestone")
        elseif z_center < 2 * layer_thickness
            pg = gmsh.model.addPhysicalGroup(3, [tag])
            gmsh.model.setPhysicalName(3, pg, "Reservoir_Sandstone")
        else
            pg = gmsh.model.addPhysicalGroup(3, [tag])
            gmsh.model.setPhysicalName(3, pg, "Overburden_Shale")
        end
    end

    # Tag boundary surfaces
    surfaces = gmsh.model.getEntities(2)
    for (dim, tag) in surfaces
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.occ.getBoundingBox(dim, tag)
        tol = 1.0

        if abs(zmin) < tol && abs(zmax) < tol
            pg = gmsh.model.addPhysicalGroup(2, [tag])
            gmsh.model.setPhysicalName(2, pg, "bottom")
        elseif abs(zmin - 3*layer_thickness) < tol && abs(zmax - 3*layer_thickness) < tol
            pg = gmsh.model.addPhysicalGroup(2, [tag])
            gmsh.model.setPhysicalName(2, pg, "top")
        end
    end

    # Mesh size
    h = Lx / nx
    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", h)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", h)

    # Generate 3D mesh
    println("Generating mesh (target: ~$(nx*ny*nz_per_layer*3*6) tets or ~$(nx*ny*nz_per_layer*3) hexes)...")
    gmsh.model.mesh.generate(3)

    # Get stats
    node_tags, _, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)

    elem_types, elem_tags_vec, _ = gmsh.model.mesh.getElements(3)
    n_elements = sum(length(et) for et in elem_tags_vec)

    println("Mesh generated:")
    println("  Nodes: $n_nodes")
    println("  Elements: $n_elements")

    gmsh.write(output_path)
    gmsh.finalize()

    return (n_nodes=n_nodes, n_elements=n_elements, path=output_path)
end

# Generate mesh
output = joinpath(@__DIR__, "large_partitioned.msh")
println("=== Generating large partitioned mesh ===")
mesh = generate_large_partitioned_mesh(output; nx=120, ny=120, nz_per_layer=25)

println("\n=== Extracting boundary surface ===")
result = extract_boundary_surface(output)

println("\nPartitions:")
for p in result["partitions"]
    println("  $(p["name"]): $(p["n_elements"]) elements ($(p["color"]))")
end
println("\nSurface: $(result["n_faces"]) faces from $(result["n_total_elements"]) elements")
println("\nSaved to: $output")
