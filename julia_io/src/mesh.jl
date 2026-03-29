"""Mesh generation using Gmsh.jl for geomechanics simulations."""

"""
    generate_box_mesh(output_path; Lx, Ly, Lz, nx, ny, nz)

Generate a 3D box mesh using Gmsh and save as .msh file.

# Arguments
- `output_path::String` — path to save the .msh file
- `Lx, Ly, Lz` — box dimensions [m] (default: 1.0 each)
- `nx, ny, nz` — number of elements per direction (default: 10 each)

# Returns
Named tuple with mesh info: `(path, n_nodes, n_elements, bounds)`

# Boundary tags
The mesh includes physical groups for boundary conditions:
- "bottom" (z=0), "top" (z=Lz)
- "left" (x=0), "right" (x=Lx)
- "front" (y=0), "back" (y=Ly)
- "volume" (entire domain)
"""
function generate_box_mesh(output_path::String;
                           Lx::Float64=1.0, Ly::Float64=1.0, Lz::Float64=1.0,
                           nx::Int=10, ny::Int=10, nz::Int=10)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 2)

    gmsh.model.add("box")

    # Create box geometry
    box = gmsh.model.occ.addBox(0.0, 0.0, 0.0, Lx, Ly, Lz)
    gmsh.model.occ.synchronize()

    # Get surfaces for boundary tagging
    surfaces = gmsh.model.getEntities(2)
    volumes = gmsh.model.getEntities(3)

    # Tag each face by its normal direction
    # Gmsh OCC box faces: we identify by bounding box center
    face_tags = Dict{String, Int}()
    for (dim, tag) in surfaces
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.occ.getBoundingBox(dim, tag)
        cx = (xmin + xmax) / 2
        cy = (ymin + ymax) / 2
        cz = (zmin + zmax) / 2

        tol = min(Lx, Ly, Lz) * 0.01
        if abs(zmin) < tol && abs(zmax) < tol
            face_tags["bottom"] = tag
        elseif abs(zmin - Lz) < tol && abs(zmax - Lz) < tol
            face_tags["top"] = tag
        elseif abs(xmin) < tol && abs(xmax) < tol
            face_tags["left"] = tag
        elseif abs(xmin - Lx) < tol && abs(xmax - Lx) < tol
            face_tags["right"] = tag
        elseif abs(ymin) < tol && abs(ymax) < tol
            face_tags["front"] = tag
        elseif abs(ymin - Ly) < tol && abs(ymax - Ly) < tol
            face_tags["back"] = tag
        end
    end

    # Create physical groups for BCs
    for (name, tag) in face_tags
        pg = gmsh.model.addPhysicalGroup(2, [tag])
        gmsh.model.setPhysicalName(2, pg, name)
    end

    # Volume physical group
    vol_pg = gmsh.model.addPhysicalGroup(3, [volumes[1][2]])
    gmsh.model.setPhysicalName(3, vol_pg, "volume")

    # Set mesh size via transfinite
    # Use element size based on requested divisions
    hx = Lx / nx
    hy = Ly / ny
    hz = Lz / nz
    h = min(hx, hy, hz)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", h)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", h)

    # Generate 3D mesh
    gmsh.model.mesh.generate(3)

    # Get mesh stats
    node_tags, _, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)
    elem_types, _, _ = gmsh.model.mesh.getElements(3)
    n_elements = sum(length(gmsh.model.mesh.getElements(3)[2][i]) for i in eachindex(elem_types))

    # Save
    gmsh.write(output_path)

    gmsh.finalize()

    println("Box mesh generated: $(n_nodes) nodes, $(n_elements) elements")
    println("  Dimensions: $(Lx) × $(Ly) × $(Lz) m")
    println("  Saved to: $(output_path)")

    return (path=output_path, n_nodes=n_nodes, n_elements=n_elements,
            bounds=(Lx=Lx, Ly=Ly, Lz=Lz))
end
