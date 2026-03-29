"""
Convert parsed Abaqus model to Gmsh .msh format for Gridap consumption.

Strategy: Write a Gmsh MSH 4.1 ASCII file that Gridap's GmshDiscreteModel can read.
Node sets become physical surface groups (for BCs), element sets become physical volume groups.
"""

# Abaqus element type → Gmsh element type ID
const ABAQUS_TO_GMSH_TYPE = Dict(
    "C3D4"  => 4,   # 4-node tetrahedron
    "C3D8"  => 5,   # 8-node hexahedron
    "C3D10" => 11,  # 10-node second order tetrahedron
    "C3D20" => 17,  # 20-node second order hexahedron
    "C3D6"  => 6,   # 6-node prism
    "C3D8R" => 5,   # 8-node hex (treat reduced integration as standard)
)

"""
    abaqus_to_msh(abq_model, output_path; bc_nsets)

Convert an AbaqusModel to a Gmsh .msh file.

# Arguments
- `abq_model::AbaqusModel` — parsed Abaqus model
- `output_path::String` — path to write .msh file

# Keyword Arguments
- `bc_nsets::Vector{String}` — node set names to convert to boundary physical groups.
  The converter identifies boundary faces whose nodes all belong to the nset.

# Returns
The output path.
"""
function abaqus_to_msh(abq::AbaqusModel, output_path::String;
                       bc_nsets::Vector{String} = String[])

    open(output_path, "w") do io
        # --- Header ---
        println(io, "\$MeshFormat")
        println(io, "4.1 0 8")
        println(io, "\$EndMeshFormat")

        # --- Collect physical groups ---
        # Volume groups from element sets
        physical_groups = Dict{Tuple{Int,Int}, String}()  # (dim, tag) → name
        vol_tag = 0
        elset_to_phys = Dict{String, Int}()
        for (name, _) in abq.elsets
            vol_tag += 1
            physical_groups[(3, vol_tag)] = name
            elset_to_phys[name] = vol_tag
        end
        # If no elsets, create a default volume group
        if isempty(abq.elsets)
            vol_tag += 1
            physical_groups[(3, vol_tag)] = "volume"
        end

        # Surface groups from node sets (for BCs)
        surf_tag = 0
        nset_to_phys = Dict{String, Int}()
        for name in bc_nsets
            if haskey(abq.nsets, name)
                surf_tag += 1
                physical_groups[(2, surf_tag)] = name
                nset_to_phys[name] = surf_tag
            end
        end

        # --- PhysicalNames ---
        println(io, "\$PhysicalNames")
        println(io, length(physical_groups))
        for ((dim, tag), name) in physical_groups
            println(io, "$dim $tag \"$name\"")
        end
        println(io, "\$EndPhysicalNames")

        # --- Entities ---
        # Simplified: one volume entity per elset, one surface entity per bc nset
        n_surf_entities = length(nset_to_phys)
        n_vol_entities = max(length(elset_to_phys), 1)

        println(io, "\$Entities")
        println(io, "0 0 $n_surf_entities $n_vol_entities")

        # Surface entities
        for (name, phys_tag) in nset_to_phys
            node_ids = abq.nsets[name]
            xs = [abq.nodes[n].x for n in node_ids if haskey(abq.nodes, n)]
            ys = [abq.nodes[n].y for n in node_ids if haskey(abq.nodes, n)]
            zs = [abq.nodes[n].z for n in node_ids if haskey(abq.nodes, n)]
            xmin, xmax = extrema(xs)
            ymin, ymax = extrema(ys)
            zmin, zmax = extrema(zs)
            println(io, "$phys_tag $xmin $ymin $zmin $xmax $ymax $zmax 1 $phys_tag 0")
        end

        # Volume entities
        all_xs = [n.x for n in values(abq.nodes)]
        all_ys = [n.y for n in values(abq.nodes)]
        all_zs = [n.z for n in values(abq.nodes)]
        gxmin, gxmax = extrema(all_xs)
        gymin, gymax = extrema(all_ys)
        gzmin, gzmax = extrema(all_zs)

        if !isempty(elset_to_phys)
            for (name, phys_tag) in elset_to_phys
                surf_tags_str = join(collect(1:n_surf_entities), " ")
                println(io, "$phys_tag $gxmin $gymin $gzmin $gxmax $gymax $gzmax 1 $phys_tag $n_surf_entities $surf_tags_str")
            end
        else
            surf_tags_str = join(collect(1:n_surf_entities), " ")
            println(io, "1 $gxmin $gymin $gzmin $gxmax $gymax $gzmax 1 1 $n_surf_entities $surf_tags_str")
        end
        println(io, "\$EndEntities")

        # --- Nodes ---
        # Remap node IDs to contiguous 1:N
        sorted_node_ids = sort(collect(keys(abq.nodes)))
        node_remap = Dict(old => new for (new, old) in enumerate(sorted_node_ids))
        n_nodes = length(sorted_node_ids)

        println(io, "\$Nodes")
        # numEntityBlocks numNodes minNodeTag maxNodeTag
        println(io, "1 $n_nodes 1 $n_nodes")
        # entityDim entityTag parametric numNodes
        entity_tag = isempty(elset_to_phys) ? 1 : first(values(elset_to_phys))
        println(io, "3 $entity_tag 0 $n_nodes")
        # Node tags
        for i in 1:n_nodes
            println(io, i)
        end
        # Node coordinates
        for old_id in sorted_node_ids
            n = abq.nodes[old_id]
            println(io, "$(n.x) $(n.y) $(n.z)")
        end
        println(io, "\$EndNodes")

        # --- Elements ---
        # Separate boundary face elements and volume elements
        # First: extract boundary faces from nsets
        boundary_elems = _extract_boundary_faces(abq, bc_nsets, node_remap)
        n_boundary = sum(length(v) for v in values(boundary_elems); init=0)

        # Volume elements
        n_vol_elems = length(abq.elements)
        gmsh_elem_type = isempty(abq.elements) ? 4 : get(ABAQUS_TO_GMSH_TYPE, abq.elements[1].type, 4)

        # Total entity blocks: one per boundary nset + one for volume
        n_entity_blocks = length(boundary_elems) + 1
        n_total_elems = n_boundary + n_vol_elems

        println(io, "\$Elements")
        println(io, "$n_entity_blocks $n_total_elems 1 $n_total_elems")

        elem_counter = 0

        # Boundary face elements (triangles for tet mesh, quads for hex mesh)
        face_type = gmsh_elem_type == 4 || gmsh_elem_type == 11 ? 2 : 3  # tri=2, quad=3
        for (nset_name, faces) in boundary_elems
            phys_tag = nset_to_phys[nset_name]
            n_faces = length(faces)
            println(io, "2 $phys_tag $face_type $n_faces")
            for face in faces
                elem_counter += 1
                conn_str = join(face, " ")
                println(io, "$elem_counter $conn_str")
            end
        end

        # Volume elements
        vol_phys = isempty(elset_to_phys) ? 1 : first(values(elset_to_phys))
        println(io, "3 $vol_phys $gmsh_elem_type $n_vol_elems")
        for elem in abq.elements
            elem_counter += 1
            remapped = [node_remap[n] for n in elem.connectivity]
            conn_str = join(remapped, " ")
            println(io, "$elem_counter $conn_str")
        end

        println(io, "\$EndElements")
    end

    println("Converted Abaqus model to: $output_path")
    return output_path
end

"""Extract boundary faces from volume elements whose face nodes are all in a given nset."""
function _extract_boundary_faces(abq::AbaqusModel, bc_nsets::Vector{String},
                                  node_remap::Dict{Int,Int})
    result = Dict{String, Vector{Vector{Int}}}()

    # Face definitions per element type (node indices within connectivity)
    tet_faces = [[1,2,3], [1,2,4], [2,3,4], [1,3,4]]
    hex_faces = [[1,2,3,4], [5,6,7,8], [1,2,6,5], [2,3,7,6], [3,4,8,7], [4,1,5,8]]

    for nset_name in bc_nsets
        haskey(abq.nsets, nset_name) || continue
        nset_nodes = Set(abq.nsets[nset_name])
        faces = Vector{Int}[]

        for elem in abq.elements
            face_defs = if elem.type in ("C3D4", "C3D10")
                tet_faces
            elseif elem.type in ("C3D8", "C3D8R", "C3D20")
                hex_faces
            else
                continue
            end

            for face_idx in face_defs
                face_nodes = [elem.connectivity[i] for i in face_idx]
                if all(n -> n in nset_nodes, face_nodes)
                    push!(faces, [node_remap[n] for n in face_nodes])
                end
            end
        end

        if !isempty(faces)
            result[nset_name] = faces
        end
    end

    return result
end

"""
    abaqus_to_gridap(filepath; bc_nsets) → (model, material_map)

Convenience: parse .inp file and convert to Gridap DiscreteModel in one step.

Returns the Gridap model and a Dict mapping region names to ElasticMaterial.
"""
function abaqus_to_gridap(filepath::String; bc_nsets::Vector{String} = String[])
    abq = read_abaqus(filepath)

    # Auto-detect bc_nsets if not provided
    if isempty(bc_nsets)
        bc_nsets = collect(keys(abq.nsets))
        println("  Auto-using all node sets as BC groups: $(join(bc_nsets, ", "))")
    end

    msh_path = replace(filepath, ".inp" => ".msh")
    abaqus_to_msh(abq, msh_path; bc_nsets=bc_nsets)

    model = GmshDiscreteModel(msh_path)

    # Convert Abaqus materials to ElasticMaterial
    material_map = Dict{String, ElasticMaterial}()
    for (name, mat) in abq.materials
        ρ = mat.ρ > 0 ? mat.ρ : 2500.0  # default density
        material_map[name] = ElasticMaterial(mat.E, mat.ν, ρ)
    end

    return (model=model, materials=material_map, abaqus=abq)
end
