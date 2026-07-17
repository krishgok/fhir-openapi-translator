# fhir-openapi-translator

**Turn any FHIR resource into an OpenAPI spec — and codegen typed models in any language.**

HAPI FHIR and Firely give Java/.NET teams great FHIR models. Everyone else — Go, Rust, Kotlin, PHP, C++, TypeScript — is stuck. But every language has an OpenAPI code generator. This tool bridges the gap: give it a resource name and a FHIR version, get back a clean, self-contained OpenAPI document ready for `openapi-generator`.

```sh
npx fhir-oas generate Patient --fhir-version r4 -o patient.yaml
```

That's a complete spec — the `Patient` schema, its full dependency closure, the standard REST interactions, and every official search parameter — that any OpenAPI generator turns into typed models and clients.

## Install

```sh
npm install fhir-openapi-translator     # library + `fhir-oas` CLI
```

Requires Node.js ≥ 20. FHIR definitions are bundled — no network needed at generation time.

## Usage

```sh
# Generate a spec (YAML to stdout, or -o file / --format json)
fhir-oas generate Patient Observation --fhir-version r4

# Target OpenAPI 3.1 (default is 3.0.3, for widest codegen support)
fhir-oas generate Patient -f r5 --openapi-version 3.1 -o patient.json --format json

# Merge into an existing spec, preserving its comments and key order
fhir-oas generate Questionnaire -f r4 --merge-into api.yaml

# Add the standard operations ($everything, $validate, ...)
fhir-oas generate Patient -f r4 --operations

# Apply an Implementation Guide profile (e.g. US Core)
fhir-oas generate Patient -f r4 --ig hl7.fhir.us.core@5.0.1 --profile us-core-patient

# Match one server's declared surface (reads its /metadata)
fhir-oas generate -f r4 --capability https://server.example.org/fhir

# CI drift guard: fail if a committed spec no longer matches generation
fhir-oas check Patient Observation -f r4 --file api.yaml

# List resources for a version, or profiles in an IG package
fhir-oas list --fhir-version r4b
```

As a library:

```ts
import { generateOpenApi } from "fhir-openapi-translator";

const doc = generateOpenApi({ resources: ["Patient"], fhirVersion: "r4" });
```

## What it does

- **FHIR R4, R4B, R5** → **OpenAPI 3.0.3 or 3.1.0**, YAML or JSON.
- **Minimal, codegen-friendly output** — only the resources you ask for and what they reference.
- **Typed code enums** from required ValueSet bindings (`Observation.status` becomes an enum, not a bare string).
- **Custom operations** (`$everything`, `$validate`, …) from the official OperationDefinitions.
- **Profiles / Implementation Guides** — apply US Core-style constraints from an IG package.
- **CapabilityStatement-driven** — generate exactly what a specific server supports.
- **Merge mode & drift guard** — keep generated specs alongside hand-written ones, and catch drift in CI.

**→ Full CLI options, library API, codegen recipes, and limitations: [docs/REFERENCE.md](docs/REFERENCE.md).**

## Legal & attribution

- **FHIR®** is the registered trademark of [Health Level Seven International (HL7®)](https://www.hl7.org). This project is **not affiliated with, endorsed by, or sponsored by HL7.** "FHIR" is used only to describe what the tool consumes.
- The bundled definitions in `definitions/` are derived from the official HL7 FHIR packages (the FHIR specification is published by HL7 under [CC0 1.0 / public domain](https://build.fhir.org/license.html)) and from [`@medplum/definitions`](https://www.npmjs.com/package/@medplum/definitions) (Apache-2.0). Implementation Guide packages you supply via `--ig` are downloaded from and licensed by their own publishers.
- Generated OpenAPI specifications describe the FHIR data model but do **not** guarantee FHIR conformance — validate real payloads with a proper FHIR validator. See [the limitations](docs/REFERENCE.md#assumptions-and-known-limitations).

## License

[MIT](LICENSE) © fhir-openapi-translator contributors
