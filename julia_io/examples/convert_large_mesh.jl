"""
Convert the large partitioned mesh to Abaqus .inp and GOCAD .sg formats.
"""

using Pkg
Pkg.activate(joinpath(@__DIR__, ".."))

include(joinpath(@__DIR__, "..", "src", "GeomecSolver.jl"))
using .GeomecSolver
using Gmsh

function msh_to_abaqus(msh_path::String, inp_path::String)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 0)
    gmsh.open(msh_path)

    # Get nodes
    node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)

    # Get 3D elements
    elem_types, elem_tags_vec, elem_nodes_vec = gmsh.model.mesh.getElements(3)

    # Get physical groups for partitions
    phys_groups = gmsh.model.getPhysicalGroups(3)
    partition_elems = Dict{String, Vector{Int}}()
    partition_materials = Dict{String, Tuple{Float64,Float64,Float64}}()

    mat_props = Dict(
        "Underburden_Limestone" => (40e9, 0.28, 2700.0),
        "Reservoir_Sandstone" => (20e9, 0.25, 2400.0),
        "Overburden_Shale" => (5e9, 0.30, 2500.0),
    )

    for (dim, tag) in phys_groups
        name = gmsh.model.getPhysicalName(dim, tag)
        if isempty(name)
            name = "Region_$tag"
        end
        partition_elems[name] = Int[]
        partition_materials[name] = get(mat_props, name, (20e9, 0.25, 2400.0))

        entities = gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
        for ent in entities
            _, etags, _ = gmsh.model.mesh.getElements(3, ent)
            for et in etags
                append!(partition_elems[name], Int.(et))
            end
        end
    end

    # Get boundary node sets from 2D physical groups
    nsets = Dict{String, Vector{Int}}()
    phys_2d = gmsh.model.getPhysicalGroups(2)
    for (dim, tag) in phys_2d
        name = gmsh.model.getPhysicalName(dim, tag)
        if isempty(name)
            name = "Surface_$tag"
        end
        entities = gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
        node_set = Set{Int}()
        for ent in entities
            ntags, _, _ = gmsh.model.mesh.getNodes(dim, ent, true)
            for n in ntags
                push!(node_set, Int(n))
            end
        end
        nsets[name] = sort(collect(node_set))
    end

    # Determine element type string
    elem_type_id = Int(elem_types[1])
    _, elem_name, _, npe, _, _ = gmsh.model.mesh.getElementProperties(elem_type_id)
    n_per = Int(npe)
    abq_type = if n_per == 4
        "C3D4"
    elseif n_per == 8
        "C3D8"
    elseif n_per == 10
        "C3D10"
    else
        "C3D$(n_per)"
    end

    # Build element connectivity map
    all_elems = Dict{Int, Vector{Int}}()
    for (etype, etags, enodes) in zip(elem_types, elem_tags_vec, elem_nodes_vec)
        _, _, _, npe2, _, _ = gmsh.model.mesh.getElementProperties(etype)
        np = Int(npe2)
        for i in 1:length(etags)
            tag = Int(etags[i])
            start = (i-1)*np + 1
            all_elems[tag] = Int.(enodes[start:start+np-1])
        end
    end

    gmsh.finalize()

    # Write .inp file
    println("Writing Abaqus .inp: $inp_path")
    open(inp_path, "w") do io
        println(io, "** Abaqus input - Large partitioned geomechanics model")
        println(io, "** Generated from: $msh_path")
        println(io, "** Nodes: $n_nodes, Elements: $(length(all_elems))")
        println(io, "*HEADING")
        println(io, "Large 3-layer geomechanics model")
        println(io, "**")

        # Nodes
        println(io, "*NODE")
        for i in 1:n_nodes
            tag = Int(node_tags[i])
            idx = (i-1)*3
            x, y, z = node_coords[idx+1], node_coords[idx+2], node_coords[idx+3]
            println(io, "$tag, $x, $y, $z")
        end

        # Elements per partition
        for (name, eids) in sort(collect(partition_elems))
            println(io, "**")
            println(io, "*ELEMENT, TYPE=$abq_type, ELSET=$name")
            for eid in sort(eids)
                conn = all_elems[eid]
                println(io, "$eid, $(join(conn, ", "))")
            end
        end

        # Node sets
        for (name, nodes) in sort(collect(nsets))
            println(io, "**")
            println(io, "*NSET, NSET=$name")
            # Write 10 per line
            for chunk_start in 1:10:length(nodes)
                chunk_end = min(chunk_start + 9, length(nodes))
                println(io, join(nodes[chunk_start:chunk_end], ", "))
            end
        end

        # Materials
        for (name, (E, nu, rho)) in sort(collect(partition_materials))
            mat_name = uppercase(replace(split(name, "_")[end], r"[^A-Za-z]" => ""))
            println(io, "**")
            println(io, "*MATERIAL, NAME=$mat_name")
            println(io, "*ELASTIC")
            println(io, "$E, $nu")
            println(io, "*DENSITY")
            println(io, "$rho")
            println(io, "**")
            println(io, "*SOLID SECTION, ELSET=$name, MATERIAL=$mat_name")
        end

        # Boundary conditions
        if haskey(nsets, "bottom")
            println(io, "**")
            println(io, "*BOUNDARY")
            println(io, "bottom, 1, 3, 0.0")
        end

        println(io, "**")
        println(io, "*STEP")
        println(io, "*STATIC")
        println(io, "*DLOAD")
        println(io, ", P, 10.0E6")
        println(io, "*END STEP")
    end

    println("  Nodes: $n_nodes")
    println("  Elements: $(length(all_elems))")
    println("  Partitions: $(join(keys(partition_elems), ", "))")
    println("  Node sets: $(join(keys(nsets), ", "))")
end

function msh_to_gocad_sgrid(msh_path::String, sg_path::String)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 0)
    gmsh.open(msh_path)

    node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)

    # Get elements
    elem_types, elem_tags_vec, elem_nodes_vec = gmsh.model.mesh.getElements(3)

    # Get partitions
    phys_groups = gmsh.model.getPhysicalGroups(3)
    elem_region = Dict{Int, String}()
    for (dim, tag) in phys_groups
        name = gmsh.model.getPhysicalName(dim, tag)
        entities = gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
        for ent in entities
            _, etags, _ = gmsh.model.mesh.getElements(3, ent)
            for et in etags
                for t in et
                    elem_region[Int(t)] = name
                end
            end
        end
    end

    # Save element data before finalizing
    _, _, _, npe, _, _ = gmsh.model.mesh.getElementProperties(Int(elem_types[1]))
    is_tet = Int(npe) == 4
    n_per_elem = Int(npe)

    # Pre-extract all element connectivity
    all_elem_data = Vector{Tuple{Int, Vector{Int}}}()
    node_region = Dict{Int, String}()
    for (etype, etags, enodes) in zip(elem_types, elem_tags_vec, elem_nodes_vec)
        _, _, _, np2, _, _ = gmsh.model.mesh.getElementProperties(etype)
        np = Int(np2)
        for i in 1:length(etags)
            tag = Int(etags[i])
            start = (i-1)*np + 1
            conn = Int.(enodes[start:start+np-1])
            push!(all_elem_data, (tag, conn))
            region = get(elem_region, tag, "Unknown")
            for n in conn
                node_region[n] = region
            end
        end
    end

    gmsh.finalize()

    println("Writing GOCAD SGrid: $sg_path")
    open(sg_path, "w") do io
        println(io, "GOCAD SGrid 1")
        println(io, "HEADER {")
        println(io, "name: Large_Partitioned_Model")
        println(io, "}")
        println(io, "PROPERTIES Region")
        println(io, "")

        # Vertices
        for i in 1:n_nodes
            tag = Int(node_tags[i])
            idx = (i-1)*3
            x, y, z = node_coords[idx+1], node_coords[idx+2], node_coords[idx+3]
            println(io, "VRTX $tag $x $y $z")
        end
        println(io, "")

        # Elements
        if is_tet
            for (tag, conn) in all_elem_data
                println(io, "TETRA $(conn[1]) $(conn[2]) $(conn[3]) $(conn[4])")
            end
        else
            println(io, "** Note: Non-tet elements — connectivity omitted")
        end

        println(io, "END")
    end

    n_elems = length(all_elem_data)
    println("  Nodes: $n_nodes")
    println("  Elements: $n_elems")
    println("  Regions: $(length(unique(values(elem_region))))")
end

# --- Run conversions ---
msh_file = joinpath(@__DIR__, "large_partitioned.msh")
inp_file = joinpath(@__DIR__, "large_partitioned.inp")
sg_file = joinpath(@__DIR__, "large_partitioned.sg")

println("=== Converting to Abaqus .inp ===")
msh_to_abaqus(msh_file, inp_file)

println("\n=== Converting to GOCAD .sg ===")
msh_to_gocad_sgrid(msh_file, sg_file)

println("\n=== Done ===")
println("Abaqus: $inp_file")
println("GOCAD:  $sg_file")

# File sizes
inp_size = filesize(inp_file) / 1024 / 1024
sg_size = filesize(sg_file) / 1024 / 1024
println("\nFile sizes:")
println("  .inp: $(round(inp_size, digits=1)) MB")
println("  .sg:  $(round(sg_size, digits=1)) MB")
