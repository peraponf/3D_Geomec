"""
Abaqus .inp file parser for geomechanics simulations.

Supports:
- *NODE — node coordinates
- *ELEMENT — element connectivity (C3D4, C3D8, C3D10, C3D20)
- *NSET — node sets (for BCs)
- *ELSET — element sets (for regions/materials)
- *MATERIAL / *ELASTIC / *DENSITY — material properties
- *BOUNDARY — Dirichlet BCs
- *STEP / *CLOAD / *DLOAD — loading
"""

# --- Data structures ---

struct AbaqusNode
    id::Int
    x::Float64
    y::Float64
    z::Float64
end

struct AbaqusElement
    id::Int
    type::String
    connectivity::Vector{Int}
end

struct AbaqusMaterial
    name::String
    E::Float64       # Young's modulus
    ν::Float64       # Poisson's ratio
    ρ::Float64       # Density (0 if not specified)
end

struct AbaqusBoundary
    node_or_nset::Union{Int, String}
    dof_first::Int
    dof_last::Int
    value::Float64
end

struct AbaqusModel
    nodes::Dict{Int, AbaqusNode}
    elements::Vector{AbaqusElement}
    nsets::Dict{String, Vector{Int}}
    elsets::Dict{String, Vector{Int}}
    materials::Dict{String, AbaqusMaterial}
    boundaries::Vector{AbaqusBoundary}
    elset_material::Dict{String, String}  # elset → material name
end

# --- Element type mapping ---

const ABAQUS_ELEM_NODES = Dict(
    "C3D4"  => 4,   # 4-node tet
    "C3D8"  => 8,   # 8-node hex
    "C3D10" => 10,  # 10-node quadratic tet
    "C3D20" => 20,  # 20-node quadratic hex
    "C3D6"  => 6,   # 6-node wedge
    "C3D8R" => 8,   # 8-node hex reduced integration
)

# --- Parser ---

"""
    read_abaqus(filepath) → AbaqusModel

Parse an Abaqus .inp file and return an AbaqusModel.
"""
function read_abaqus(filepath::String)
    isfile(filepath) || error("File not found: $filepath")

    lines = readlines(filepath)

    nodes = Dict{Int, AbaqusNode}()
    elements = AbaqusElement[]
    nsets = Dict{String, Vector{Int}}()
    elsets = Dict{String, Vector{Int}}()
    materials = Dict{String, AbaqusMaterial}()
    boundaries = AbaqusBoundary[]
    elset_material = Dict{String, String}()

    current_section = :none
    current_elem_type = ""
    current_nset_name = ""
    current_elset_name = ""
    current_mat_name = ""
    current_mat_E = 0.0
    current_mat_ν = 0.0
    current_mat_ρ = 0.0
    current_elset_for_section = ""
    expecting = :none  # :elastic, :density

    for line in lines
        stripped = strip(line)

        # Skip empty lines and comments
        (isempty(stripped) || startswith(stripped, "**")) && continue

        # Check for keyword lines
        if startswith(uppercase(stripped), "*")
            # Save pending material
            if current_section == :material && current_mat_name != "" && current_mat_E > 0
                materials[current_mat_name] = AbaqusMaterial(
                    current_mat_name, current_mat_E, current_mat_ν, current_mat_ρ)
            end

            keyword_line = uppercase(stripped)

            if startswith(keyword_line, "*NODE")
                current_section = :node
                expecting = :none

            elseif startswith(keyword_line, "*ELEMENT")
                current_section = :element
                expecting = :none
                # Parse TYPE= and ELSET=
                current_elem_type = _parse_param(stripped, "TYPE")
                current_elset_for_section = _parse_param(stripped, "ELSET")

            elseif startswith(keyword_line, "*NSET")
                current_section = :nset
                expecting = :none
                current_nset_name = _parse_param(stripped, "NSET")
                if !haskey(nsets, current_nset_name)
                    nsets[current_nset_name] = Int[]
                end
                # Check for GENERATE
                if occursin("GENERATE", keyword_line)
                    current_section = :nset_generate
                end

            elseif startswith(keyword_line, "*ELSET")
                current_section = :elset
                expecting = :none
                current_elset_name = _parse_param(stripped, "ELSET")
                if !haskey(elsets, current_elset_name)
                    elsets[current_elset_name] = Int[]
                end
                if occursin("GENERATE", keyword_line)
                    current_section = :elset_generate
                end

            elseif startswith(keyword_line, "*MATERIAL")
                current_section = :material
                expecting = :none
                current_mat_name = _parse_param(stripped, "NAME")
                current_mat_E = 0.0
                current_mat_ν = 0.0
                current_mat_ρ = 0.0

            elseif startswith(keyword_line, "*ELASTIC")
                expecting = :elastic

            elseif startswith(keyword_line, "*DENSITY")
                expecting = :density

            elseif startswith(keyword_line, "*SOLID SECTION")
                current_section = :solid_section
                es = _parse_param(stripped, "ELSET")
                mt = _parse_param(stripped, "MATERIAL")
                if es != "" && mt != ""
                    elset_material[es] = mt
                end

            elseif startswith(keyword_line, "*BOUNDARY")
                current_section = :boundary
                expecting = :none

            else
                # Unknown keyword — skip data lines until next keyword
                if !startswith(keyword_line, "*ELASTIC") &&
                   !startswith(keyword_line, "*DENSITY")
                    current_section = :skip
                    expecting = :none
                end
            end
            continue
        end

        # Data lines
        parts = strip.(split(stripped, ","))
        filter!(!isempty, parts)

        if expecting == :elastic && length(parts) >= 2
            current_mat_E = parse(Float64, parts[1])
            current_mat_ν = parse(Float64, parts[2])
            expecting = :none

        elseif expecting == :density && length(parts) >= 1
            current_mat_ρ = parse(Float64, parts[1])
            expecting = :none

        elseif current_section == :node && length(parts) >= 4
            id = parse(Int, parts[1])
            x = parse(Float64, parts[2])
            y = parse(Float64, parts[3])
            z = parse(Float64, parts[4])
            nodes[id] = AbaqusNode(id, x, y, z)

        elseif current_section == :element && length(parts) >= 2
            id = parse(Int, parts[1])
            conn = [parse(Int, p) for p in parts[2:end]]
            push!(elements, AbaqusElement(id, current_elem_type, conn))
            if current_elset_for_section != ""
                if !haskey(elsets, current_elset_for_section)
                    elsets[current_elset_for_section] = Int[]
                end
                push!(elsets[current_elset_for_section], id)
            end

        elseif current_section == :nset
            for p in parts
                push!(nsets[current_nset_name], parse(Int, p))
            end

        elseif current_section == :nset_generate && length(parts) >= 3
            start = parse(Int, parts[1])
            stop = parse(Int, parts[2])
            step = parse(Int, parts[3])
            append!(nsets[current_nset_name], start:step:stop)
            current_section = :none

        elseif current_section == :elset
            for p in parts
                push!(elsets[current_elset_name], parse(Int, p))
            end

        elseif current_section == :elset_generate && length(parts) >= 3
            start = parse(Int, parts[1])
            stop = parse(Int, parts[2])
            step = parse(Int, parts[3])
            append!(elsets[current_elset_name], start:step:stop)
            current_section = :none

        elseif current_section == :boundary && length(parts) >= 2
            node_or_nset = tryparse(Int, parts[1])
            if node_or_nset === nothing
                node_or_nset_val = String(parts[1])
            else
                node_or_nset_val = node_or_nset
            end
            dof_first = parse(Int, parts[2])
            dof_last = length(parts) >= 3 ? parse(Int, parts[3]) : dof_first
            value = length(parts) >= 4 ? parse(Float64, parts[4]) : 0.0
            push!(boundaries, AbaqusBoundary(node_or_nset_val, dof_first, dof_last, value))
        end
    end

    # Save last pending material
    if current_mat_name != "" && current_mat_E > 0
        materials[current_mat_name] = AbaqusMaterial(
            current_mat_name, current_mat_E, current_mat_ν, current_mat_ρ)
    end

    model = AbaqusModel(nodes, elements, nsets, elsets, materials, boundaries, elset_material)

    println("Abaqus model parsed:")
    println("  Nodes: $(length(nodes))")
    println("  Elements: $(length(elements))")
    println("  Node sets: $(join(keys(nsets), ", "))")
    println("  Element sets: $(join(keys(elsets), ", "))")
    println("  Materials: $(join(keys(materials), ", "))")
    println("  Boundaries: $(length(boundaries))")

    return model
end

# --- Helpers ---

"""Extract parameter value from an Abaqus keyword line, e.g. TYPE=C3D8 → "C3D8" """
function _parse_param(line::AbstractString, param::AbstractString)
    # Case-insensitive search for PARAM=VALUE
    m = match(Regex("$(param)\\s*=\\s*([^,\\s]+)", "i"), line)
    m === nothing ? "" : strip(String(m.captures[1]))
end
