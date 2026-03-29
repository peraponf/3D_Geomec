"""
Convert parsed GOCAD models to Gmsh .msh format for Gridap consumption.

- TSurf → surface mesh (triangles) — useful for fault planes, boundary extraction
- SGrid with tetrahedra → volume mesh directly
- Voxet → generate hex mesh from regular grid
"""

"""
    tsurf_to_msh(tsurf, output_path)

Convert a GocadTSurf to a Gmsh .msh file (surface mesh).
Useful for defining boundary conditions from fault/horizon surfaces.
"""
function tsurf_to_msh(tsurf::GocadTSurf, output_path::String)
    # Remap vertex IDs to contiguous 1:N
    sorted_ids = sort(collect(keys(tsurf.vertices)))
    remap = Dict(old => new for (new, old) in enumerate(sorted_ids))
    n_nodes = length(sorted_ids)
    n_tris = length(tsurf.triangles)

    open(output_path, "w") do io
        println(io, "\$MeshFormat")
        println(io, "4.1 0 8")
        println(io, "\$EndMeshFormat")

        # Physical names
        println(io, "\$PhysicalNames")
        println(io, "1")
        println(io, "2 1 \"$(tsurf.name)\"")
        println(io, "\$EndPhysicalNames")

        # Entities
        xs = [tsurf.vertices[id].x for id in sorted_ids]
        ys = [tsurf.vertices[id].y for id in sorted_ids]
        zs = [tsurf.vertices[id].z for id in sorted_ids]
        println(io, "\$Entities")
        println(io, "0 0 1 0")
        println(io, "1 $(minimum(xs)) $(minimum(ys)) $(minimum(zs)) $(maximum(xs)) $(maximum(ys)) $(maximum(zs)) 1 1 0")
        println(io, "\$EndEntities")

        # Nodes
        println(io, "\$Nodes")
        println(io, "1 $n_nodes 1 $n_nodes")
        println(io, "2 1 0 $n_nodes")
        for i in 1:n_nodes
            println(io, i)
        end
        for old_id in sorted_ids
            v = tsurf.vertices[old_id]
            println(io, "$(v.x) $(v.y) $(v.z)")
        end
        println(io, "\$EndNodes")

        # Elements (triangles = type 2)
        println(io, "\$Elements")
        println(io, "1 $n_tris 1 $n_tris")
        println(io, "2 1 2 $n_tris")
        for (i, tri) in enumerate(tsurf.triangles)
            println(io, "$i $(remap[tri.id1]) $(remap[tri.id2]) $(remap[tri.id3])")
        end
        println(io, "\$EndElements")
    end

    println("TSurf → .msh: $n_nodes nodes, $n_tris triangles → $output_path")
    return output_path
end

"""
    sgrid_to_msh(sgrid, output_path; volume_name)

Convert a GocadSGrid (with tetrahedra) to a Gmsh .msh file (volume mesh).
"""
function sgrid_to_msh(sgrid::GocadSGrid, output_path::String;
                      volume_name::String = "volume")
    sorted_ids = sort(collect(keys(sgrid.vertices)))
    remap = Dict(old => new for (new, old) in enumerate(sorted_ids))
    n_nodes = length(sorted_ids)
    n_tets = length(sgrid.tetrahedra)

    open(output_path, "w") do io
        println(io, "\$MeshFormat")
        println(io, "4.1 0 8")
        println(io, "\$EndMeshFormat")

        println(io, "\$PhysicalNames")
        println(io, "1")
        println(io, "3 1 \"$volume_name\"")
        println(io, "\$EndPhysicalNames")

        xs = [sgrid.vertices[id].x for id in sorted_ids]
        ys = [sgrid.vertices[id].y for id in sorted_ids]
        zs = [sgrid.vertices[id].z for id in sorted_ids]
        println(io, "\$Entities")
        println(io, "0 0 0 1")
        println(io, "1 $(minimum(xs)) $(minimum(ys)) $(minimum(zs)) $(maximum(xs)) $(maximum(ys)) $(maximum(zs)) 1 1 0")
        println(io, "\$EndEntities")

        println(io, "\$Nodes")
        println(io, "1 $n_nodes 1 $n_nodes")
        println(io, "3 1 0 $n_nodes")
        for i in 1:n_nodes
            println(io, i)
        end
        for old_id in sorted_ids
            v = sgrid.vertices[old_id]
            println(io, "$(v.x) $(v.y) $(v.z)")
        end
        println(io, "\$EndNodes")

        # Tetrahedra = type 4
        println(io, "\$Elements")
        println(io, "1 $n_tets 1 $n_tets")
        println(io, "3 1 4 $n_tets")
        for (i, tet) in enumerate(sgrid.tetrahedra)
            println(io, "$i $(remap[tet.id1]) $(remap[tet.id2]) $(remap[tet.id3]) $(remap[tet.id4])")
        end
        println(io, "\$EndElements")
    end

    println("SGrid → .msh: $n_nodes nodes, $n_tets tetrahedra → $output_path")
    return output_path
end

"""
    voxet_to_msh(voxet, output_path; volume_name)

Convert a GocadVoxet (regular 3D grid) to a Gmsh .msh file with hex elements.
"""
function voxet_to_msh(voxet::GocadVoxet, output_path::String;
                      volume_name::String = "volume")
    length(voxet.axes) == 3 || error("Voxet must have 3 axes")

    ax_u, ax_v, ax_w = voxet.axes
    nu, nv, nw = ax_u.n, ax_v.n, ax_w.n

    # Generate nodes on regular grid
    n_nodes = (nu + 1) * (nv + 1) * (nw + 1)
    n_hex = nu * nv * nw

    # Node index from (i,j,k) — 0-based
    node_idx(i, j, k) = i + j * (nu + 1) + k * (nu + 1) * (nv + 1) + 1

    open(output_path, "w") do io
        println(io, "\$MeshFormat")
        println(io, "4.1 0 8")
        println(io, "\$EndMeshFormat")

        println(io, "\$PhysicalNames")
        println(io, "1")
        println(io, "3 1 \"$volume_name\"")
        println(io, "\$EndPhysicalNames")

        x0, y0, z0 = voxet.origin
        xmax = x0 + nu * ax_u.step
        ymax = y0 + nv * ax_v.step
        zmax = z0 + nw * ax_w.step

        println(io, "\$Entities")
        println(io, "0 0 0 1")
        println(io, "1 $x0 $y0 $z0 $xmax $ymax $zmax 1 1 0")
        println(io, "\$EndEntities")

        # Nodes
        println(io, "\$Nodes")
        println(io, "1 $n_nodes 1 $n_nodes")
        println(io, "3 1 0 $n_nodes")
        for idx in 1:n_nodes
            println(io, idx)
        end
        for k in 0:nw, j in 0:nv, i in 0:nu
            x = x0 + i * ax_u.step
            y = y0 + j * ax_v.step
            z = z0 + k * ax_w.step
            println(io, "$x $y $z")
        end
        println(io, "\$EndNodes")

        # Hex elements (type 5)
        println(io, "\$Elements")
        println(io, "1 $n_hex 1 $n_hex")
        println(io, "3 1 5 $n_hex")
        elem_id = 0
        for k in 0:nw-1, j in 0:nv-1, i in 0:nu-1
            elem_id += 1
            # Hex8 node ordering (Gmsh convention)
            n1 = node_idx(i,   j,   k)
            n2 = node_idx(i+1, j,   k)
            n3 = node_idx(i+1, j+1, k)
            n4 = node_idx(i,   j+1, k)
            n5 = node_idx(i,   j,   k+1)
            n6 = node_idx(i+1, j,   k+1)
            n7 = node_idx(i+1, j+1, k+1)
            n8 = node_idx(i,   j+1, k+1)
            println(io, "$elem_id $n1 $n2 $n3 $n4 $n5 $n6 $n7 $n8")
        end
        println(io, "\$EndElements")
    end

    println("Voxet → .msh: $n_nodes nodes, $n_hex hexahedra → $output_path")
    return output_path
end
