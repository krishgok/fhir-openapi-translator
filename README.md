# fhir-openapi-translator

Generate OpenAPI specifications for HL7 FHIR resources — by resource name and FHIR version — for model codegen in any language.

Ask for `Patient` and you get a self-contained OpenAPI document with the Patient schema, its full dependency closure (datatypes, backbone elements, `Bundle`, `OperationOutcome`), and the standard FHIR REST interactions (read, vread, update, delete, search, create, history) including the resource's official search parameters. Feed the result to any OpenAPI code generator to get typed models and clients.

## Features

- **FHIR R4 (4.0.1), R4B (4.3.0), and R5 (5.0.0)** — definitions are vendored with the package; no network access at generation time.
- **OpenAPI 3.0.3 or 3.1.0** output, as YAML or JSON. 3.0.3 is the default for widest codegen support.
- **Minimal specs** — only the requested resources and what they actually reference. `ResourceList` is narrowed to the requested types instead of dragging in all 140+ resource schemas.
- **Merge mode** — merge generated schemas and paths into an existing hand-maintained YAML spec, preserving its comments, anchors, and key order, and refusing to overwrite differing entries unless `--force`.
- **Two definition backends** — the official `fhir.schema.json` (default) or FHIR StructureDefinitions.
- **Trim options** — stub out the `Narrative` type or cap the dependency-closure depth for codegen targets that struggle with large schema graphs.

## Install

```sh
npm install fhir-openapi-translator
```

Requires Node.js ≥ 20.

## CLI

```sh
# Generate a spec for Patient and Observation on FHIR R4, as YAML to stdout
fhir-oas generate Patient Observation --fhir-version r4

# Write JSON, target OpenAPI 3.1
fhir-oas generate Patient -f r5 --format json --openapi-version 3.1 -o patient.json

# Merge into an existing spec, keeping its comments and key order
fhir-oas generate Questionnaire -f r4 --merge-into api.yaml

# Embed a server URL and trim the output
fhir-oas generate Patient -f r4 --base-url https://fhir.example.org/r4 \
  --exclude-narrative --max-depth 3

# List the resource types available for a version
fhir-oas list --fhir-version r4b
```

`fhir-oas generate --help` shows all options, including `--source` (definition backend), `--title`, and `--force` (overwrite conflicting entries when merging).

## Library

```ts
import { generateOpenApi, listResources, mergeIntoYaml } from "fhir-openapi-translator";

const doc = generateOpenApi({
  resources: ["Patient", "Observation"],
  fhirVersion: "r4",
  openApiVersion: "3.0.3",       // default
  baseUrl: "https://fhir.example.org/r4",
  trim: { excludeNarrative: true, maxDepth: 3 },
});

listResources("r5");             // ["Account", "ActivityDefinition", ...]

// Merge into existing YAML text, preserving comments and formatting
const mergedYaml = mergeIntoYaml(doc, existingYamlText, { force: false });
```

See `GenerateOptions` in the type declarations for the full API surface.

## Codegen recipes

Generated specs are exercised against [openapi-generator](https://github.com/OpenAPITools/openapi-generator) in CI (`typescript-fetch` and `python` targets). Notes that matter in practice:

- **typescript-fetch**: pass `--additional-properties=modelPropertyNaming=original`. FHIR represents extensions on primitive fields as sibling `_field` properties; the generator's default naming strips the underscore and produces colliding class members.
- Large resources produce large model trees (a Patient R4 spec has ~80 schemas, a full Bundle-of-anything far more). If your generator or build struggles, use `--exclude-narrative` and `--max-depth` to shrink the graph.
- `Bundle.entry.resource` (`ResourceList`) is narrowed to the resource types you requested. If your server returns other types in bundles (e.g. `_include`d resources you didn't generate), either add those resources to the generation, or treat unknown entries as opaque JSON.

## What this is for — and what it is not

**Intended use**

- Codegen typed FHIR models and API clients in languages without a mature FHIR SDK (Go, Rust, Kotlin, PHP, C++, ...).
- Feed API gateways, contract-testing tools, mock servers, and documentation portals that speak OpenAPI.
- Commit the generated spec next to your service and regenerate on FHIR version bumps; merge mode keeps hand-written spec content intact.

**Not intended for — do not use this as**

- **A FHIR validator.** Passing schema validation does *not* make a resource FHIR-conformant: FHIRPath invariants, terminology bindings, and profile constraints (slicing, must-support, cardinality refinements) are not represented in OpenAPI. Validate with a real FHIR validator (HAPI, the official validator, server-side `$validate`).
- **A profile / Implementation Guide tool.** Output describes base resources only; US Core or other IG profiles are not applied.
- **A replacement for HAPI FHIR or Firely** if you are on Java/.NET — those give you richer, spec-aware models than any OpenAPI codegen can.
- **XML payload handling.** Only the FHIR JSON representation is modeled.

**Assumptions and known limitations**

- Output is inherently lossy relative to the FHIR specification (see above); it trades fidelity for reach across language ecosystems.
- Primitive-extension properties (`_field`) are kept for JSON fidelity; they roughly double the property count of each model.
- Search parameters are typed as strings (except `_count`), because FHIR search values carry prefixes and modifiers (`ge2021-01-01`, `code:below=...`) that stricter types would reject. The FHIR type is preserved in `x-fhir-search-type`.
- Custom operations (`$everything`, `$validate`, ...), `POST /_search`, batch/transaction semantics, and conditional headers beyond `If-Match` are not modeled.
- The two definition backends can differ cosmetically (e.g. naming of deeply nested backbone elements, primitive regex patterns); `schema-json` is the default and the reference.

## Development

```sh
npm install
npm run typecheck
npm test          # vitest; validates generated specs against the OpenAPI meta-schemas
npm run build     # tsup → dist/
```

Vendored FHIR definitions live in `definitions/` as gzipped JSON. To refresh them from their upstream npm packages, run:

```sh
node scripts/update-definitions.mjs
```

## License

MIT
