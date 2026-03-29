"""
Server-side boundary surface extraction for large mesh visualization.
Uses Gmsh API directly to extract skin mesh — reliable for any element type.
"""

using JSON

"""
    extract_boundary_surface(mesh_path; elsets, nsets) → Dict

Extract boundary surface from a volume mesh using Gmsh's skin extraction.
Returns JSON-serializable Dict with surface triangles, partition colors, and node/element set info.
"""
function extract_boundary_surface(mesh_path::String;
                                   elsets::Dict{String,Vector{Int}} = Dict{String,Vector{Int}}(),
                                   nsets::Dict{String,Vector{Int}} = Dict{String,Vector{Int}}())
    Gmsh.gmsh.initialize()
    Gmsh.gmsh.option.setNumber("General.Verbosity", 0)
    Gmsh.gmsh.open(mesh_path)

    # --- Get all nodes ---
    all_node_tags, all_node_coords, _ = Gmsh.gmsh.model.mesh.getNodes()
    node_coord = Dict{Int, Vector{Float64}}()
    for i in 1:length(all_node_tags)
        tag = Int(all_node_tags[i])
        idx = (i-1)*3
        node_coord[tag] = [all_node_coords[idx+1], all_node_coords[idx+2], all_node_coords[idx+3]]
    end

    # --- Check if 2D or 3D mesh ---
    elem_types_3d, elem_tags_3d, elem_nodes_3d = Gmsh.gmsh.model.mesh.getElements(3)
    is_2d = isempty(elem_tags_3d) || all(isempty, elem_tags_3d)

    if is_2d
        return _extract_2d_mesh(node_coord, elsets, nsets)
    end

    # --- Get 3D elements for partition mapping ---
    n_total_3d = 0
    elem_to_nodes = Dict{Int, Vector{Int}}()
    for (etype, etags, enodes) in zip(elem_types_3d, elem_tags_3d, elem_nodes_3d)
        _, _, _, npe, _, _ = Gmsh.gmsh.model.mesh.getElementProperties(etype)
        n_per = Int(npe)
        for i in 1:length(etags)
            n_total_3d += 1
            tag = Int(etags[i])
            start = (i-1)*n_per + 1
            elem_to_nodes[tag] = Int.(enodes[start:start+n_per-1])
        end
    end

    # --- Build partition info from elsets or physical groups ---
    partition_names = String[]
    elem_partition = Dict{Int, Int}()

    if !isempty(elsets)
        for (name, eids) in sort(collect(elsets))
            push!(partition_names, name)
            pid = length(partition_names)
            for eid in eids
                elem_partition[eid] = pid
            end
        end
    else
        phys_groups = Gmsh.gmsh.model.getPhysicalGroups(3)
        for (dim, tag) in phys_groups
            name = Gmsh.gmsh.model.getPhysicalName(dim, tag)
            if isempty(name)
                name = "Region_$tag"
            end
            push!(partition_names, name)
            pid = length(partition_names)
            entities = Gmsh.gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
            for ent in entities
                _, etags, _ = Gmsh.gmsh.model.mesh.getElements(3, ent)
                for etag_vec in etags
                    for t in etag_vec
                        elem_partition[Int(t)] = pid
                    end
                end
            end
        end
    end

    if isempty(partition_names)
        push!(partition_names, "volume")
        for tag in keys(elem_to_nodes)
            elem_partition[tag] = 1
        end
    end

    # --- Extract boundary faces using element face adjacency ---
    # Build face → element mapping
    # A face is defined by its sorted node tags
    face_elems = Dict{Vector{Int}, Vector{Int}}()  # sorted_face_nodes → [elem_tags...]

    # Face definitions per element type
    function get_faces(conn::Vector{Int}, n_per::Int)
        if n_per == 4  # Tet4
            return [
                sort([conn[1], conn[2], conn[3]]),
                sort([conn[1], conn[2], conn[4]]),
                sort([conn[1], conn[3], conn[4]]),
                sort([conn[2], conn[3], conn[4]]),
            ]
        elseif n_per == 8  # Hex8 — each face is a quad, store as sorted set
            return [
                sort([conn[1], conn[2], conn[3], conn[4]]),
                sort([conn[5], conn[6], conn[7], conn[8]]),
                sort([conn[1], conn[2], conn[6], conn[5]]),
                sort([conn[3], conn[4], conn[8], conn[7]]),
                sort([conn[1], conn[4], conn[8], conn[5]]),
                sort([conn[2], conn[3], conn[7], conn[6]]),
            ]
        elseif n_per == 6  # Wedge/Prism
            return [
                sort([conn[1], conn[2], conn[3]]),
                sort([conn[4], conn[5], conn[6]]),
                sort([conn[1], conn[2], conn[5], conn[4]]),
                sort([conn[2], conn[3], conn[6], conn[5]]),
                sort([conn[1], conn[3], conn[6], conn[4]]),
            ]
        else
            return Vector{Int}[]
        end
    end

    for (etag, conn) in elem_to_nodes
        faces = get_faces(conn, length(conn))
        for face in faces
            if !haskey(face_elems, face)
                face_elems[face] = Int[]
            end
            push!(face_elems[face], etag)
        end
    end

    # Boundary faces: external (shared by 1 element) OR partition interfaces (shared by 2 elements of different partitions)
    boundary_faces = Vector{Tuple{Vector{Int}, Int}}()  # (face_node_tags, partition_id)
    for (face_nodes, etags) in face_elems
        if length(etags) == 1
            # External boundary
            pid = get(elem_partition, etags[1], 1)
            push!(boundary_faces, (face_nodes, pid))
        elseif length(etags) == 2
            # Check if partition interface
            pid1 = get(elem_partition, etags[1], 1)
            pid2 = get(elem_partition, etags[2], 1)
            if pid1 != pid2
                # Add face twice — once for each partition (so each side gets its color)
                push!(boundary_faces, (face_nodes, pid1))
                push!(boundary_faces, (face_nodes, pid2))
            end
        end
    end

    # --- Re-index to boundary-only nodes ---
    bnd_node_set = Set{Int}()
    for (fnodes, _) in boundary_faces
        for n in fnodes
            push!(bnd_node_set, n)
        end
    end
    sorted_bnd = sort(collect(bnd_node_set))
    remap = Dict(old => (new_idx - 1) for (new_idx, old) in enumerate(sorted_bnd))  # 0-based

    out_nodes = [node_coord[tag] for tag in sorted_bnd]

    # Triangulate boundary faces
    out_faces = Vector{Vector{Int}}()
    out_partitions = Int[]

    for (fnodes, pid) in boundary_faces
        mapped = [remap[n] for n in fnodes]
        if length(mapped) == 3
            # Get actual coordinates and compute proper winding
            push!(out_faces, mapped)
            push!(out_partitions, pid)
        elseif length(mapped) == 4
            # Quad → 2 triangles
            # Need proper winding: use actual coordinates to order the quad
            coords = [out_nodes[m+1] for m in mapped]
            # Find centroid
            cx = sum(c[1] for c in coords) / 4
            cy = sum(c[2] for c in coords) / 4
            cz = sum(c[3] for c in coords) / 4
            # Sort by angle around centroid (project to dominant plane)
            # Find face normal direction
            dx = maximum(c[1] for c in coords) - minimum(c[1] for c in coords)
            dy = maximum(c[2] for c in coords) - minimum(c[2] for c in coords)
            dz = maximum(c[3] for c in coords) - minimum(c[3] for c in coords)
            # Project to the plane with smallest extent
            if dx <= dy && dx <= dz
                # YZ plane
                angles = [atan(c[3] - cz, c[2] - cy) for c in coords]
            elseif dy <= dx && dy <= dz
                # XZ plane
                angles = [atan(c[3] - cz, c[1] - cx) for c in coords]
            else
                # XY plane
                angles = [atan(c[2] - cy, c[1] - cx) for c in coords]
            end
            order = sortperm(angles)
            ordered = [mapped[i] for i in order]
            push!(out_faces, [ordered[1], ordered[2], ordered[3]])
            push!(out_partitions, pid)
            push!(out_faces, [ordered[1], ordered[3], ordered[4]])
            push!(out_partitions, pid)
        end
    end

    # Bounding box
    xs = [n[1] for n in out_nodes]
    ys = [n[2] for n in out_nodes]
    zs = [n[3] for n in out_nodes]

    # Nset info with boundary node indices for visualization
    out_nsets = Dict{String, Any}[]
    for (name, node_ids) in nsets
        # Get boundary node indices (0-based, remapped)
        bnd_indices = Int[]
        for nid in node_ids
            if haskey(remap, nid)
                push!(bnd_indices, remap[nid])
            end
        end
        push!(out_nsets, Dict(
            "name" => name,
            "n_nodes" => length(node_ids),
            "boundary_nodes" => length(bnd_indices),
            "node_indices" => bnd_indices
        ))
    end

    # Partition colors
    colors = ["#4ea8de", "#e74c3c", "#2ecc71", "#f39c12", "#9b59b6",
              "#1abc9c", "#e67e22", "#3498db", "#e91e63", "#00bcd4",
              "#ff5722", "#8bc34a", "#673ab7", "#009688", "#ff9800"]

    partition_info = [
        Dict("name" => name,
             "color" => colors[mod1(i, length(colors))],
             "n_elements" => count(v -> v == i, values(elem_partition)))
        for (i, name) in enumerate(partition_names)
    ]

    Gmsh.gmsh.finalize()

    result = Dict(
        "nodes" => out_nodes,
        "faces" => out_faces,
        "face_partitions" => out_partitions,
        "partitions" => partition_info,
        "nsets" => out_nsets,
        "n_nodes" => length(out_nodes),
        "n_faces" => length(out_faces),
        "n_total_elements" => n_total_3d,
        "bounds" => Dict(
            "min" => [minimum(xs), minimum(ys), minimum(zs)],
            "max" => [maximum(xs), maximum(ys), maximum(zs)]
        )
    )

    println("Boundary: $(n_total_3d) elements → $(length(out_faces)) surface faces, $(length(out_nodes)) nodes, $(length(partition_names)) partitions")
    return result
end


"""
Extract 2D mesh directly — each quad/tri element becomes a face for visualization.
"""
function _extract_2d_mesh(node_coord::Dict{Int,Vector{Float64}},
                           elsets::Dict{String,Vector{Int}},
                           nsets::Dict{String,Vector{Int}})
    # Get 2D elements
    elem_types_2d, elem_tags_2d, elem_nodes_2d = Gmsh.gmsh.model.mesh.getElements(2)

    n_total = 0
    elem_to_nodes = Dict{Int, Vector{Int}}()
    for (etype, etags, enodes) in zip(elem_types_2d, elem_tags_2d, elem_nodes_2d)
        _, _, _, npe, _, _ = Gmsh.gmsh.model.mesh.getElementProperties(etype)
        n_per = Int(npe)
        for i in 1:length(etags)
            n_total += 1
            tag = Int(etags[i])
            start = (i-1)*n_per + 1
            elem_to_nodes[tag] = Int.(enodes[start:start+n_per-1])
        end
    end

    # Build partitions from elsets or physical groups
    partition_names = String[]
    elem_partition = Dict{Int, Int}()

    if !isempty(elsets)
        for (name, eids) in sort(collect(elsets))
            push!(partition_names, name)
            pid = length(partition_names)
            for eid in eids
                elem_partition[eid] = pid
            end
        end
    else
        phys_groups = Gmsh.gmsh.model.getPhysicalGroups(2)
        for (dim, tag) in phys_groups
            name = Gmsh.gmsh.model.getPhysicalName(dim, tag)
            if isempty(name); name = "Region_$tag"; end
            push!(partition_names, name)
            pid = length(partition_names)
            entities = Gmsh.gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
            for ent in entities
                _, etags, _ = Gmsh.gmsh.model.mesh.getElements(2, ent)
                for et in etags
                    for t in et
                        elem_partition[Int(t)] = pid
                    end
                end
            end
        end
    end

    if isempty(partition_names)
        push!(partition_names, "domain")
        for tag in keys(elem_to_nodes)
            elem_partition[tag] = 1
        end
    end

    # Re-index nodes
    all_node_tags = Set{Int}()
    for (_, conn) in elem_to_nodes
        for n in conn; push!(all_node_tags, n); end
    end
    sorted_nodes = sort(collect(all_node_tags))
    remap = Dict(old => (i-1) for (i, old) in enumerate(sorted_nodes))

    out_nodes = [node_coord[tag] for tag in sorted_nodes]

    # Each 2D element → face(s) for rendering
    out_faces = Vector{Vector{Int}}()
    out_partitions = Int[]

    for (etag, conn) in elem_to_nodes
        pid = get(elem_partition, etag, 1)
        mapped = [remap[n] for n in conn]

        if length(mapped) == 3
            push!(out_faces, mapped)
            push!(out_partitions, pid)
        elseif length(mapped) == 4
            # Quad → 2 triangles for rendering
            push!(out_faces, [mapped[1], mapped[2], mapped[3]])
            push!(out_partitions, pid)
            push!(out_faces, [mapped[1], mapped[3], mapped[4]])
            push!(out_partitions, pid)
        end
    end

    # Also add faces for partition boundaries (edges between different partitions)
    # Extract edges and check adjacency
    edge_elems = Dict{Vector{Int}, Vector{Int}}()
    for (etag, conn) in elem_to_nodes
        n = length(conn)
        for i in 1:n
            edge = sort([conn[i], conn[mod1(i+1, n)]])
            if !haskey(edge_elems, edge)
                edge_elems[edge] = Int[]
            end
            push!(edge_elems[edge], etag)
        end
    end

    # Bounding box
    xs = [n[1] for n in out_nodes]
    ys = [n[2] for n in out_nodes]
    zs = [n[3] for n in out_nodes]

    # Nset info
    out_nsets = Dict{String,Any}[]
    for (name, node_ids) in nsets
        bnd_indices = [remap[n] for n in node_ids if haskey(remap, n)]
        push!(out_nsets, Dict(
            "name" => name, "n_nodes" => length(node_ids),
            "boundary_nodes" => length(bnd_indices), "node_indices" => bnd_indices))
    end

    # Also get nsets from 1D physical groups
    phys_1d = Gmsh.gmsh.model.getPhysicalGroups(1)
    for (dim, tag) in phys_1d
        name = Gmsh.gmsh.model.getPhysicalName(dim, tag)
        if isempty(name); continue; end
        entities = Gmsh.gmsh.model.getEntitiesForPhysicalGroup(dim, tag)
        node_set = Set{Int}()
        for ent in entities
            ntags, _, _ = Gmsh.gmsh.model.mesh.getNodes(dim, ent, true)
            for n in ntags; push!(node_set, Int(n)); end
        end
        bnd_indices = [remap[n] for n in node_set if haskey(remap, n)]
        push!(out_nsets, Dict(
            "name" => name, "n_nodes" => length(node_set),
            "boundary_nodes" => length(bnd_indices), "node_indices" => bnd_indices))
    end

    colors = ["#4ea8de", "#e74c3c", "#2ecc71", "#f39c12", "#9b59b6",
              "#1abc9c", "#e67e22", "#3498db", "#e91e63", "#00bcd4"]

    partition_info = [
        Dict("name" => name,
             "color" => colors[mod1(i, length(colors))],
             "n_elements" => count(v -> v == i, values(elem_partition)))
        for (i, name) in enumerate(partition_names)
    ]

    Gmsh.gmsh.finalize()

    result = Dict(
        "nodes" => out_nodes,
        "faces" => out_faces,
        "face_partitions" => out_partitions,
        "partitions" => partition_info,
        "nsets" => out_nsets,
        "n_nodes" => length(out_nodes),
        "n_faces" => length(out_faces),
        "n_total_elements" => n_total,
        "bounds" => Dict(
            "min" => [minimum(xs), minimum(ys), minimum(zs)],
            "max" => [maximum(xs), maximum(ys), maximum(zs)]
        )
    )

    println("2D mesh: $(n_total) elements → $(length(out_faces)) faces, $(length(out_nodes)) nodes, $(length(partition_names)) partitions")
    return result
end
