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

## Development

```sh
npm install
npm run typecheck
npm test          # vitest; includes full swagger-parser validation of generated specs
npm run build     # tsup → dist/
```

Vendored FHIR definitions live in `definitions/` as gzipped JSON. To refresh them from their upstream npm packages, run:

```sh
node scripts/update-definitions.mjs
```

## License

MIT
