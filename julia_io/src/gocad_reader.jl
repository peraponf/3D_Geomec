"""
SKUA-GOCAD file parser for geomechanics simulations.

Supports:
- TSURF (.ts)  — Triangulated surfaces (fault planes, horizons)
- VOXET (.vo)  — Regular 3D grids with property fields
- SGRID (.sg)  — Stratigraphic grids (structured/unstructured)
- PLINE (.pl)  — Polylines (wells, trajectories)

GOCAD format reference:
- Header: GOCAD <type> <version>
- HEADER { name: value }
- Properties defined inline or in separate @@<property_file>
- Coordinates: VRTX id x y z or PVRTX id x y z p1 p2 ...
- Triangles: TRGL id1 id2 id3
- Tetrahedra: TETRA id1 id2 id3 id4
"""

# --- Data structures ---

struct GocadVertex
    id::Int
    x::Float64
    y::Float64
    z::Float64
    properties::Dict{String, Float64}
end

struct GocadTriangle
    id1::Int
    id2::Int
    id3::Int
end

struct GocadTetra
    id1::Int
    id2::Int
    id3::Int
    id4::Int
end

struct GocadTSurf
    name::String
    vertices::Dict{Int, GocadVertex}
    triangles::Vector{GocadTriangle}
    properties::Vector{String}  # property names
end

struct VoxetAxis
    origin::Float64
    step::Float64
    n::Int
end

struct GocadVoxet
    name::String
    origin::Vector{Float64}       # [x0, y0, z0]
    axes::Vector{VoxetAxis}       # U, V, W axes
    properties::Dict{String, Array{Float64,3}}  # property name → 3D array
end

struct GocadSGrid
    name::String
    vertices::Dict{Int, GocadVertex}
    tetrahedra::Vector{GocadTetra}
    hex_cells::Vector{Vector{Int}}  # hex connectivity if present
    properties::Vector{String}
    property_values::Dict{String, Vector{Float64}}  # property per vertex/cell
end

# --- TSURF Parser ---

"""
    read_tsurf(filepath) → GocadTSurf

Parse a GOCAD TSURF file (triangulated surface).
"""
function read_tsurf(filepath::String)
    isfile(filepath) || error("File not found: $filepath")
    lines = readlines(filepath)

    name = ""
    vertices = Dict{Int, GocadVertex}()
    triangles = GocadTriangle[]
    prop_names = String[]

    for line in lines
        stripped = strip(line)
        parts = split(stripped)
        isempty(parts) && continue

        keyword = uppercase(parts[1])

        if keyword == "GOCAD" && length(parts) >= 2
            # Header line: GOCAD TSurf 1
            continue

        elseif keyword == "NAME:" || (keyword == "NAME" && length(parts) >= 2)
            name = join(parts[2:end], " ")

        elseif keyword == "PROPERTIES"
            prop_names = String.(parts[2:end])

        elseif keyword == "VRTX" && length(parts) >= 5
            id = parse(Int, parts[2])
            x = parse(Float64, parts[3])
            y = parse(Float64, parts[4])
            z = parse(Float64, parts[5])
            vertices[id] = GocadVertex(id, x, y, z, Dict{String,Float64}())

        elseif keyword == "PVRTX" && length(parts) >= 5
            id = parse(Int, parts[2])
            x = parse(Float64, parts[3])
            y = parse(Float64, parts[4])
            z = parse(Float64, parts[5])
            props = Dict{String, Float64}()
            for (i, pname) in enumerate(prop_names)
                if 5 + i <= length(parts)
                    props[pname] = parse(Float64, parts[5 + i])
                end
            end
            vertices[id] = GocadVertex(id, x, y, z, props)

        elseif keyword == "TRGL" && length(parts) >= 4
            id1 = parse(Int, parts[2])
            id2 = parse(Int, parts[3])
            id3 = parse(Int, parts[4])
            push!(triangles, GocadTriangle(id1, id2, id3))

        elseif keyword == "END"
            break
        end
    end

    println("GOCAD TSurf parsed: \"$name\"")
    println("  Vertices: $(length(vertices))")
    println("  Triangles: $(length(triangles))")
    println("  Properties: $(join(prop_names, ", "))")

    return GocadTSurf(name, vertices, triangles, prop_names)
end

# --- VOXET Parser ---

"""
    read_voxet(filepath) → GocadVoxet

Parse a GOCAD VOXET file (regular 3D grid with properties).
Property data is read from associated binary files (@@filename).
"""
function read_voxet(filepath::String)
    isfile(filepath) || error("File not found: $filepath")
    lines = readlines(filepath)
    basedir = dirname(filepath)

    name = ""
    origin = [0.0, 0.0, 0.0]
    axes = VoxetAxis[]
    properties = Dict{String, Array{Float64,3}}()
    current_prop = ""
    prop_files = Dict{String, String}()
    prop_types = Dict{String, String}()

    nu, nv, nw = 1, 1, 1

    for line in lines
        stripped = strip(line)
        parts = split(stripped)
        isempty(parts) && continue

        keyword = uppercase(parts[1])

        if keyword == "NAME:" || keyword == "NAME"
            name = join(parts[2:end], " ")

        elseif keyword == "AXIS_O" && length(parts) >= 4
            origin = [parse(Float64, parts[2]), parse(Float64, parts[3]), parse(Float64, parts[4])]

        elseif keyword == "AXIS_U" && length(parts) >= 4
            # U axis direction vector (length = total extent in U)
            continue  # We use AXIS_N and AXIS_D instead

        elseif keyword == "AXIS_V" && length(parts) >= 4
            continue

        elseif keyword == "AXIS_W" && length(parts) >= 4
            continue

        elseif keyword == "AXIS_N" && length(parts) >= 4
            nu = parse(Int, parts[2])
            nv = parse(Int, parts[3])
            nw = parse(Int, parts[4])

        elseif keyword == "AXIS_D" && length(parts) >= 4
            du = parse(Float64, parts[2])
            dv = parse(Float64, parts[3])
            dw = parse(Float64, parts[4])
            axes = [VoxetAxis(origin[1], du, nu),
                    VoxetAxis(origin[2], dv, nv),
                    VoxetAxis(origin[3], dw, nw)]

        elseif keyword == "PROP_FILE" && length(parts) >= 3
            pname = String(parts[2])
            pfile = String(parts[3])
            prop_files[pname] = pfile

        elseif keyword == "PROP_ETYPE" && length(parts) >= 3
            pname = String(parts[2])
            prop_types[pname] = String(parts[3])

        elseif keyword == "END"
            break
        end
    end

    # Read property binary files
    for (pname, pfile) in prop_files
        full_path = joinpath(basedir, pfile)
        if isfile(full_path)
            etype = get(prop_types, pname, "IEEE")
            data = _read_property_file(full_path, nu, nv, nw, etype)
            properties[pname] = data
            println("  Loaded property '$pname' from $pfile")
        else
            println("  Warning: property file not found: $full_path")
        end
    end

    println("GOCAD Voxet parsed: \"$name\"")
    println("  Origin: $origin")
    println("  Grid: $nu × $nv × $nw")
    println("  Properties: $(join(keys(properties), ", "))")

    return GocadVoxet(name, origin, axes, properties)
end

"""Read a GOCAD binary property file (IEEE big-endian float32 by default)."""
function _read_property_file(filepath::String, nu::Int, nv::Int, nw::Int, etype::String)
    raw = read(filepath)
    n_expected = nu * nv * nw

    # GOCAD typically uses big-endian IEEE float32
    if uppercase(etype) == "IEEE" || uppercase(etype) == "FLOAT"
        n_bytes = n_expected * 4
        if length(raw) < n_bytes
            @warn "Property file too short: expected $n_bytes bytes, got $(length(raw))"
            data = zeros(Float64, nu, nv, nw)
        else
            values = [ntoh(reinterpret(Float32, raw[(i-1)*4+1:i*4])[1]) for i in 1:n_expected]
            data = reshape(Float64.(values), nu, nv, nw)
        end
    else
        @warn "Unknown property type: $etype, skipping"
        data = zeros(Float64, nu, nv, nw)
    end

    return data
end

# --- SGRID Parser ---

"""
    read_sgrid(filepath) → GocadSGrid

Parse a GOCAD SGrid file (stratigraphic grid).
"""
function read_sgrid(filepath::String)
    isfile(filepath) || error("File not found: $filepath")
    lines = readlines(filepath)
    basedir = dirname(filepath)

    name = ""
    vertices = Dict{Int, GocadVertex}()
    tetrahedra = GocadTetra[]
    hex_cells = Vector{Int}[]
    prop_names = String[]
    property_values = Dict{String, Vector{Float64}}()
    region_names = String[]  # optional *region_names line

    current_section = :none
    prop_files = Dict{String, String}()

    for line in lines
        stripped = strip(line)

        # Parse *region_names from comments
        if startswith(stripped, "*region_names:")
            raw = strip(replace(stripped, "*region_names:" => ""))
            region_names = [strip(n, [' ', ',']) for n in split(raw) if !isempty(strip(n, [' ', ',']))]
            continue
        end

        parts = split(stripped)
        isempty(parts) && continue

        # Skip comments
        startswith(stripped, "**") && continue

        keyword = uppercase(parts[1])

        if keyword == "NAME:" || keyword == "NAME"
            name = join(parts[2:end], " ")

        elseif keyword == "PROPERTIES"
            prop_names = String.(parts[2:end])

        elseif keyword == "VRTX" && length(parts) >= 5
            id = parse(Int, parts[2])
            x = parse(Float64, parts[3])
            y = parse(Float64, parts[4])
            z = parse(Float64, parts[5])
            vertices[id] = GocadVertex(id, x, y, z, Dict{String,Float64}())

        elseif keyword == "PVRTX" && length(parts) >= 5
            id = parse(Int, parts[2])
            x = parse(Float64, parts[3])
            y = parse(Float64, parts[4])
            z = parse(Float64, parts[5])
            props = Dict{String, Float64}()
            for (i, pname) in enumerate(prop_names)
                if 5 + i <= length(parts)
                    props[pname] = parse(Float64, parts[5 + i])
                end
            end
            vertices[id] = GocadVertex(id, x, y, z, props)

        elseif keyword == "TETRA" && length(parts) >= 5
            push!(tetrahedra, GocadTetra(
                parse(Int, parts[2]), parse(Int, parts[3]),
                parse(Int, parts[4]), parse(Int, parts[5])))

        elseif keyword == "PROP_FILE" && length(parts) >= 3
            prop_files[String(parts[2])] = String(parts[3])

        elseif keyword == "END"
            break
        end
    end

    # Read external property files (ASCII, one value per line)
    for (pname, pfile) in prop_files
        full_path = joinpath(basedir, pfile)
        if isfile(full_path)
            vals = Float64[]
            for pl in readlines(full_path)
                s = strip(pl)
                !isempty(s) && push!(vals, parse(Float64, s))
            end
            property_values[pname] = vals
            println("  Loaded property '$pname': $(length(vals)) values")
        end
    end

    # Also collect inline properties
    if !isempty(prop_names) && isempty(property_values)
        for pname in prop_names
            vals = Float64[]
            for (_, v) in sort(collect(vertices), by=x->x[1])
                push!(vals, get(v.properties, pname, NaN))
            end
            property_values[pname] = vals
        end
    end

    println("GOCAD SGrid parsed: \"$name\"")
    println("  Vertices: $(length(vertices))")
    println("  Tetrahedra: $(length(tetrahedra))")
    println("  Hex cells: $(length(hex_cells))")
    println("  Properties: $(join(prop_names, ", "))")
    if !isempty(region_names)
        println("  Region names: $(join(region_names, ", "))")
    end

    return GocadSGrid(name, vertices, tetrahedra, hex_cells, prop_names, property_values)
end

"""
    extract_sgrid_elsets(sgrid) → Dict{String, Vector{Int}}

Extract element sets (partitions) from an SGrid's Region property.
Each unique Region value becomes an elset. If *region_names was specified,
those names are used; otherwise regions are named "Region_1", "Region_2", etc.

Region property is determined from the vertices of each tetrahedron:
the majority vertex region (or first vertex region) determines the element's region.
"""
function extract_sgrid_elsets(sgrid::GocadSGrid; region_names::Vector{String}=String[])
    # Check if "Region" property exists
    has_region = false
    for (_, v) in sgrid.vertices
        if haskey(v.properties, "Region")
            has_region = true
            break
        end
    end

    if !has_region
        return Dict{String, Vector{Int}}()
    end

    # Build element → region mapping
    elsets = Dict{String, Vector{Int}}()

    for (i, tet) in enumerate(sgrid.tetrahedra)
        # Get region IDs from the 4 vertices
        vids = [tet.id1, tet.id2, tet.id3, tet.id4]
        regions = Int[]
        for vid in vids
            if haskey(sgrid.vertices, vid)
                r = get(sgrid.vertices[vid].properties, "Region", NaN)
                if !isnan(r)
                    push!(regions, Int(r))
                end
            end
        end

        # Use majority vote (or first) to assign element region
        if isempty(regions)
            region_id = 1
        else
            # Count occurrences
            counts = Dict{Int, Int}()
            for r in regions
                counts[r] = get(counts, r, 0) + 1
            end
            region_id = argmax(counts)
        end

        # Get region name
        if !isempty(region_names) && region_id <= length(region_names)
            rname = region_names[region_id]
        else
            rname = "Region_$region_id"
        end

        if !haskey(elsets, rname)
            elsets[rname] = Int[]
        end
        push!(elsets[rname], i)
    end

    return elsets
end
