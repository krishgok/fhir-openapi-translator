# fhir-openapi-translator — Reference

Full CLI, library API, codegen recipes, and limitations. For a quick start see the [README](../README.md).

## Contents

- [CLI](#cli)
- [Library API](#library-api)
- [Codegen recipes](#codegen-recipes)
- [What this is for — and what it is not](#what-this-is-for--and-what-it-is-not)
- [Profiles: what `--profile` applies](#profiles-what---profile-applies)
- [Assumptions and known limitations](#assumptions-and-known-limitations)
- [Development](#development)

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

# CI drift guard: fail when api.yaml no longer matches generation
fhir-oas check Patient Observation -f r4 --file api.yaml

# Lenient models: replace binding enums with plain strings
fhir-oas generate Patient -f r4 --no-enums

# Include the standard operations (GET /Patient/{id}/$everything, POST /Patient/$validate, ...)
fhir-oas generate Patient -f r4 --operations

# Apply a profile from an Implementation Guide package
fhir-oas generate Patient -f r4 --ig ./hl7.fhir.us.core-5.0.1.tgz --profile us-core-patient
fhir-oas generate Patient -f r4 --ig hl7.fhir.us.core@5.0.1 --profile us-core-patient  # fetched + cached

# List the profiles in an IG package
fhir-oas list --ig ./hl7.fhir.us.core-5.0.1.tgz

# Match a specific server's declared surface (resources, interactions, search params, operations)
fhir-oas generate -f r4 --capability https://server.example.org/fhir   # appends /metadata
fhir-oas generate -f r4 --capability ./metadata.json                    # or a saved statement
```

`fhir-oas generate --help` shows all options, including `--source` (definition backend: `schema-json` default, or `structure-def`), `--title`, and `--force` (overwrite conflicting entries when merging).

## Library API

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

Profiles from an IG package (`loadIg` is async for registry coordinates; a local path can be passed to `ig` directly):

```ts
import { generateOpenApi, loadIg } from "fhir-openapi-translator";

const ig = await loadIg("hl7.fhir.us.core@5.0.1");   // or "./us-core.tgz", or a directory
const doc = generateOpenApi({
  resources: ["Patient"],
  fhirVersion: "r4",
  ig,                                // or ig: "./us-core.tgz" (loaded synchronously)
  profiles: ["us-core-patient"],
});
```

Match a server's CapabilityStatement (`loadCapabilityStatement` is async; `parseCapabilityStatement` takes an already-loaded object):

```ts
import { generateOpenApi, loadCapabilityStatement } from "fhir-openapi-translator";

const capability = await loadCapabilityStatement("https://server.example.org/fhir");
const doc = generateOpenApi({ fhirVersion: "r4", capability });  // resources come from the statement
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

- **A FHIR validator.** Passing schema validation does *not* make a resource FHIR-conformant: FHIRPath invariants, terminology bindings, and profile constraints (slicing, must-support, cardinality refinements) are not fully represented in OpenAPI. Validate with a real FHIR validator (HAPI, the official validator, server-side `$validate`).
- **A full profile / conformance engine.** `--profile` applies the *representable* profile constraints (see the table below), but slicing, extension slices, `pattern[x]`, FHIRPath invariants, and must-support are **not enforced** — they are surfaced as description notes and `x-fhir-constraints-omitted`, not as schema rules.
- **A replacement for HAPI FHIR or Firely** if you are on Java/.NET — those give you richer, spec-aware models than any OpenAPI codegen can.
- **XML payload handling.** Only the FHIR JSON representation is modeled.

## Profiles: what `--profile` applies

Given `--ig <package> --profile <id>`, the profile snapshot is turned into a schema named after the profile (`USCorePatient`), referenced from the base `/Patient` paths:

| Profile constraint | Schema effect |
|---|---|
| `min ≥ 1` | property becomes `required` |
| `max: "0"` | property omitted |
| `max: "1"` on a base array | scalar instead of array |
| required binding, resolvable ValueSet (IG-local, then vendored core; ≤150 codes) | inline `enum` |
| `fixed[x]` | `const` (3.1) / single-value `enum` (3.0.3) |
| choice-type narrowing | only the permitted `value[x]` expansions emitted |
| `pattern[x]`, slicing, invariants, must-support | *not enforced* — noted in `description` + `x-fhir-constraints-omitted` |

The IG package is a local `.tgz` / unpacked directory, or a `name@version` coordinate fetched from `packages.fhir.org` and cached under `~/.fhir-oas/packages`. Profiles must ship a snapshot (differential-only packages error); the package FHIR version must match `--fhir-version`; only the public registry is supported (no auth).

## Assumptions and known limitations

- Output is inherently lossy relative to the FHIR specification (see above); it trades fidelity for reach across language ecosystems.
- Enums cover *required* bindings whose ValueSet expands to a bounded code list (≤150 codes, no filters); extensible/preferred bindings and open code systems (BCP-47 languages, MIME types) stay plain strings by design.
- Primitive-extension properties (`_field`) are kept for JSON fidelity; they roughly double the property count of each model.
- Search parameters are typed as strings (except `_count`), because FHIR search values carry prefixes and modifiers (`ge2021-01-01`, `code:below=...`) that stricter types would reject. The FHIR type is preserved in `x-fhir-search-type`.
- Operations are resource-scoped only: system-level operations (`GET /$export`-style, `$convert`, ...), `POST /_search`, batch/transaction semantics, and conditional headers beyond `If-Match` are not modeled. Multi-part operation parameters collapse to a generic `Parameters` body.
- `--capability` reflects a server's *declared* surface: resource types the FHIR version doesn't define are skipped, and declared operations are emitted only when they map to a known OperationDefinition (system-level interactions like transaction/batch are not modeled). It restricts what's generated; it does not verify the server actually behaves as declared.
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
