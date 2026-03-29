"""
Simple geometry templates for common geomechanics problems.
Uses Gmsh OCC boolean operations to create meshable geometries.

All templates:
- 2D quad (4-node) mesh on XY plane
- Extruded 1 element in z for plane-strain compatibility with Gridap
- Use Gmsh recombine to get hex8 elements (quads extruded)
"""

"""
Helper: set up mesh refinement fields and generate 2D quad mesh.
Call AFTER geometry booleans and synchronize.
"""
function _setup_refinement_and_mesh_2d!(h_fine::Float64, h_coarse::Float64;
                                        field_curves::Vector{Int}=Int[],
                                        dist_min::Float64=0.5, dist_max::Float64=5.0)
    # Mesh refinement via distance field
    if !isempty(field_curves)
        f_dist = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(f_dist, "CurvesList", field_curves)
        gmsh.model.mesh.field.setNumber(f_dist, "Sampling", 200)

        f_thresh = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(f_thresh, "InField", f_dist)
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMin", h_fine)
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMax", h_coarse)
        gmsh.model.mesh.field.setNumber(f_thresh, "DistMin", dist_min)
        gmsh.model.mesh.field.setNumber(f_thresh, "DistMax", dist_max)

        gmsh.model.mesh.field.setAsBackgroundMesh(f_thresh)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    else
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", h_fine)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", h_coarse)
    end

    # Triangle mesh
    gmsh.option.setNumber("Mesh.Algorithm", 6)  # Frontal-Delaunay

    # Generate 2D mesh
    gmsh.model.mesh.generate(2)
end


"""Helper: find curves near a point within a radius."""
function _find_curves_near(cx::Float64, cy::Float64, search_radius::Float64)
    curves = gmsh.model.getEntities(1)
    result = Int[]
    for (dim, tag) in curves
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
        mcx = (xmin + xmax) / 2
        mcy = (ymin + ymax) / 2
        dist = sqrt((mcx - cx)^2 + (mcy - cy)^2)
        if dist < search_radius
            push!(result, tag)
        end
    end
    return result
end

"""Helper: get mesh stats and write."""
function _finalize_mesh!(output_path::String)
    node_tags, _, _ = gmsh.model.mesh.getNodes()
    n_nodes = length(node_tags)
    elem_types, elem_tags_vec, _ = gmsh.model.mesh.getElements(3)
    n_elements = isempty(elem_tags_vec) ? 0 : sum(length(et) for et in elem_tags_vec)

    # If no 3D elements, count 2D
    if n_elements == 0
        elem_types, elem_tags_vec, _ = gmsh.model.mesh.getElements(2)
        n_elements = isempty(elem_tags_vec) ? 0 : sum(length(et) for et in elem_tags_vec)
    end

    gmsh.write(output_path)
    gmsh.finalize()
    return (n_nodes=n_nodes, n_elements=n_elements, path=output_path)
end


# ============================================================================
# BOREHOLE (KIRSCH) — Quarter model
# ============================================================================

"""
    generate_borehole_kirsch(output_path; domain_x, radius, depth, h_fine, h_coarse)

2D quarter-model borehole on XY plane (Kirsch problem).

First quadrant (x>=0, y>=0). Quarter-circle borehole at origin.
Quad (4-node) elements, extruded 1 layer in z for plane-strain.

Boundaries: symmetry_x (x=0), symmetry_y (y=0),
            far_field_x (x=R), far_field_y (y=R), borehole_wall
"""
function generate_borehole_kirsch(output_path::String;
                                  domain_x::Float64=10.0, domain_y::Float64=10.0,
                                  radius::Float64=0.5, depth::Float64=0.1,
                                  h_fine::Float64=0.05, h_coarse::Float64=1.0)
    domain_r = max(domain_x, domain_y)

    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 2)
    gmsh.model.add("borehole_quarter")

    # Quarter rectangle minus quarter hole
    rect = gmsh.model.occ.addRectangle(0.0, 0.0, 0.0, domain_r, domain_r)
    hole = gmsh.model.occ.addDisk(0.0, 0.0, 0.0, radius, radius)
    gmsh.model.occ.cut([(2, rect)], [(2, hole)])
    gmsh.model.occ.synchronize()

    # Find borehole curves for refinement
    borehole_curves = _find_curves_near(0.0, 0.0, radius * 2.0)

    # Generate 2D quad mesh
    _setup_refinement_and_mesh_2d!(h_fine, h_coarse;
        field_curves=borehole_curves,
        dist_min=radius * 0.3,
        dist_max=domain_r * 0.4)

    # Tag physical groups — surfaces (2D elements)
    surfaces = gmsh.model.getEntities(2)
    for (_, tag) in surfaces
        pg = gmsh.model.addPhysicalGroup(2, [tag])
        gmsh.model.setPhysicalName(2, pg, "Rock")
    end

    # Tag boundary curves (1D)
    tol = radius * 0.01
    for (dim, tag) in gmsh.model.getEntities(1)
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)

        if abs(xmin) < tol && abs(xmax) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "symmetry_x")
        elseif abs(ymin) < tol && abs(ymax) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "symmetry_y")
        elseif abs(xmin - domain_r) < tol && abs(xmax - domain_r) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "far_field_x")
        elseif abs(ymin - domain_r) < tol && abs(ymax - domain_r) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "far_field_y")
        else
            cx, cy = (xmin+xmax)/2, (ymin+ymax)/2
            if sqrt(cx^2 + cy^2) < radius * 2.0
                pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "borehole_wall")
            end
        end
    end

    result = _finalize_mesh!(output_path)
    println("Borehole quarter 2D (quads): $(result.n_nodes) nodes, $(result.n_elements) elements")
    return result
end


# ============================================================================
# ESHELBY INCLUSION — Quarter model
# ============================================================================

"""
    generate_eshelby_inclusion(output_path; domain_x, domain_y, semi_a, semi_b, angle, h_fine, h_coarse)

2D full-model Eshelby inclusion on XY plane.

Full rectangular domain centered at origin with elliptical inclusion.
Two partitions: Matrix + Inclusion. Quad elements.
Enhanced refinement at inclusion boundary.

Boundaries: left (x=-domain_x), right (x=domain_x),
            bottom (y=-domain_y), top (y=domain_y)
"""
function generate_eshelby_inclusion(output_path::String;
                                    domain_x::Float64=10.0, domain_y::Float64=10.0,
                                    semi_a::Float64=2.0, semi_b::Float64=1.0,
                                    angle::Float64=0.0, depth::Float64=0.1,
                                    h_fine::Float64=0.05, h_coarse::Float64=1.0)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 2)
    gmsh.model.add("eshelby_full")

    # Full rectangle centered at origin
    rect = gmsh.model.occ.addRectangle(-domain_x, -domain_y, 0.0, 2*domain_x, 2*domain_y)

    # Full ellipse at center
    ellipse = gmsh.model.occ.addDisk(0.0, 0.0, 0.0, semi_a, semi_b)

    # Rotate if needed
    if abs(angle) > 0.01
        gmsh.model.occ.rotate([(2, ellipse)], 0, 0, 0, 0, 0, 1, angle * π / 180)
    end

    # Fragment to keep both regions
    gmsh.model.occ.fragment([(2, rect)], [(2, ellipse)])
    gmsh.model.occ.synchronize()

    # Find inclusion boundary curves for refinement
    max_semi = max(semi_a, semi_b)
    all_curves = gmsh.model.getEntities(1)
    inclusion_curves = Int[]
    for (dim, tag) in all_curves
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
        cx, cy = (xmin+xmax)/2, (ymin+ymax)/2
        # Inclusion boundary: near origin but not on domain edges
        on_edge = abs(xmin + domain_x) < 0.1 && abs(xmax + domain_x) < 0.1 ||
                  abs(xmin - domain_x) < 0.1 && abs(xmax - domain_x) < 0.1 ||
                  abs(ymin + domain_y) < 0.1 && abs(ymax + domain_y) < 0.1 ||
                  abs(ymin - domain_y) < 0.1 && abs(ymax - domain_y) < 0.1
        dist = sqrt(cx^2 + cy^2)
        if !on_edge && dist < max_semi * 2.0
            push!(inclusion_curves, tag)
        end
    end

    # Generate 2D quad mesh
    _setup_refinement_and_mesh_2d!(h_fine, h_coarse;
        field_curves=inclusion_curves,
        dist_min=max_semi * 0.05,
        dist_max=min(domain_x, domain_y) * 0.4)

    # Tag surfaces as Matrix or Inclusion
    # The inclusion surface has area ≈ π*a*b, much smaller than the full domain
    surfaces = gmsh.model.getEntities(2)
    inclusion_area = π * semi_a * semi_b
    domain_area = 4 * domain_x * domain_y

    for (_, tag) in surfaces
        mass = gmsh.model.occ.getMass(2, tag)
        # Inclusion area is close to π*a*b (or its quarter if fragmented)
        if mass < inclusion_area * 1.5
            pg = gmsh.model.addPhysicalGroup(2, [tag]); gmsh.model.setPhysicalName(2, pg, "Inclusion")
        else
            pg = gmsh.model.addPhysicalGroup(2, [tag]); gmsh.model.setPhysicalName(2, pg, "Matrix")
        end
    end

    # Tag boundary curves
    tol = min(domain_x, domain_y) * 0.01
    for (dim, tag) in gmsh.model.getEntities(1)
        xmin, ymin, _, xmax, ymax, _ = gmsh.model.occ.getBoundingBox(dim, tag)
        if abs(xmin + domain_x) < tol && abs(xmax + domain_x) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "left")
        elseif abs(xmin - domain_x) < tol && abs(xmax - domain_x) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "right")
        elseif abs(ymin + domain_y) < tol && abs(ymax + domain_y) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "bottom")
        elseif abs(ymin - domain_y) < tol && abs(ymax - domain_y) < tol
            pg = gmsh.model.addPhysicalGroup(1, [tag]); gmsh.model.setPhysicalName(1, pg, "top")
        end
    end

    result = _finalize_mesh!(output_path)
    println("Eshelby full 2D (quads): $(result.n_nodes) nodes, $(result.n_elements) elements")
    return result
end

