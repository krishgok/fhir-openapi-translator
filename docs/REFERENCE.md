# fhir-openapi-translator — Reference

Full CLI, library API, codegen recipes, and limitations. For a quick start see the [README](../README.md).

## Contents

- [CLI](#cli)
- [Library API](#library-api)
- [Codegen recipes](#codegen-recipes)
- [Search parameters](#search-parameters)
- [Viewing generated specs](#viewing-generated-specs)
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

# Limit the search parameters. Observation defines 38 on R4:
fhir-oas generate Observation -f r4 --search-params none      # -> 0
fhir-oas generate Observation -f r4 --search-params minimal   # -> 8, a common core
fhir-oas generate Observation -f r4 --search-params code,date # -> exactly the 2 you name
fhir-oas generate Patient Observation -f r4 \
  --search-params Patient:name,birthdate Observation:code,date   # per resource

# Match a specific server's declared surface (resources, interactions, search params, operations)
fhir-oas generate -f r4 --capability https://server.example.org/fhir   # appends /metadata
fhir-oas generate -f r4 --capability ./metadata.json                    # or a saved statement
```

`fhir-oas generate --help` shows all options, including `--source` (definition backend: `schema-json` default, or `structure-def`), `--title`, and `--force` (overwrite conflicting entries when merging).

## Library API

```ts
import {
  generateOpenApi,
  listResources,
  mergeIntoYaml,
} from "fhir-openapi-translator";

const doc = generateOpenApi({
  resources: ["Patient", "Observation"],
  fhirVersion: "r4",
  openApiVersion: "3.0.3", // default
  baseUrl: "https://fhir.example.org/r4",
  trim: { excludeNarrative: true, maxDepth: 3 },
});

listResources("r5"); // ["Account", "ActivityDefinition", ...]

// Merge into existing YAML text, preserving comments and formatting
const mergedYaml = mergeIntoYaml(doc, existingYamlText, { force: false });
```

Profiles from an IG package (`loadIg` is async for registry coordinates; a local path can be passed to `ig` directly):

```ts
import { generateOpenApi, loadIg } from "fhir-openapi-translator";

const ig = await loadIg("hl7.fhir.us.core@5.0.1"); // or "./us-core.tgz", or a directory
const doc = generateOpenApi({
  resources: ["Patient"],
  fhirVersion: "r4",
  ig, // or ig: "./us-core.tgz" (loaded synchronously)
  profiles: ["us-core-patient"],
});
```

Match a server's CapabilityStatement (`loadCapabilityStatement` is async; `parseCapabilityStatement` takes an already-loaded object):

```ts
import {
  generateOpenApi,
  loadCapabilityStatement,
} from "fhir-openapi-translator";

const capability = await loadCapabilityStatement(
  "https://server.example.org/fhir",
);
const doc = generateOpenApi({ fhirVersion: "r4", capability }); // resources come from the statement
```

See `GenerateOptions` in the type declarations for the full API surface.

## Codegen recipes

Generated specs are exercised against [openapi-generator](https://github.com/OpenAPITools/openapi-generator) in CI (`typescript-fetch` and `python` targets). Notes that matter in practice:

- **typescript-fetch**: pass `--additional-properties=modelPropertyNaming=original`. FHIR represents extensions on primitive fields as sibling `_field` properties; the generator's default naming strips the underscore and produces colliding class members.
- Large resources produce large model trees (a Patient R4 spec has ~80 schemas, a full Bundle-of-anything far more). If your generator or build struggles, use `--exclude-narrative` and `--max-depth` to shrink the graph.
- `Bundle.entry.resource` (`ResourceList`) is narrowed to the resource types you requested. If your server returns other types in bundles (e.g. `_include`d resources you didn't generate), either add those resources to the generation, or treat unknown entries as opaque JSON.

## Viewing generated specs

Swagger UI is fine for a spec covering a handful of resources, but it renders
every schema in the document eagerly. FHIR's schemas are large and mutually
recursive, so it degrades sharply as the spec grows. Measured on specs from
this tool:

| Spec                        | Swagger UI behaviour                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| 2 resources (~73 schemas)   | renders fine; models expand promptly                                       |
| 6 resources (~84 schemas)   | renders, but expanding one operation blocks the page for ~90s              |
| 39 resources (~188 schemas) | the **Schemas** section never finished rendering (gave up after 5 minutes) |

[Redoc](https://github.com/Redocly/redoc) renders lazily and copes with these
specs far better. Prefer it for anything beyond a few resources:

```sh
npx @redocly/cli preview-docs fhir-r4.openapi.yaml
```

This is a _viewer_ limitation, not a defect in the generated specs — they
validate against the OpenAPI meta-schemas and feed code generators cleanly at
any size. If you do need Swagger UI on a large spec, `--exclude-narrative` and
`--max-depth` shrink the schema graph considerably.

## Search parameters

Every search parameter is typed as a string (except `_count`). FHIR search
values carry prefixes, modifiers and `system|code` forms that a stricter schema
would reject, so the accepted values are advertised as metadata instead of
constraints:

| Field                    | On                                       | Meaning                                                  |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `x-fhir-search-type`     | every parameter                          | the FHIR search type (`token`, `date`, `reference`, ...) |
| `x-fhir-search-values`   | token parameters over a required binding | the codes that FHIR version defines for that element     |
| `x-fhir-search-prefixes` | `number`, `date`, `quantity`             | the comparison prefixes the value may carry              |

The same information is appended to the parameter `description`, because HL7's
own `SearchParameter.description` text is not uniform — `Encounter-status`
spells its codes out, `Observation-status` does not, though both are token
parameters over a required binding. Deriving them from the definitions makes
every parameter of a given kind read the same way, and makes them correct per
version: `Encounter.status` is `arrived | triaged | onleave | finished ...` on
R4 and `on-hold | completed | discharged ...` on R5.

Parameters shared across resources (`Patient.gender | Person.gender | ...`)
are resolved to the branch for the resource being generated, so
`MedicationRequest.status` and `MedicationDispense.status` each get their own
code list rather than one standing in for the other.

**Why not `enum`?** Because it would reject valid searches: comma-OR
(`?status=final,amended`), the token `system|code` form
(`?status=http://hl7.org/fhir/observation-status|final`), and every
`:modifier` spelling (`?status:not=entered-in-error`). Consumers that want hard
validation can read `x-fhir-search-values` and generate it themselves.

### Emitting fewer of them

Servers commonly index only a subset of the standard search parameters — each
one indexed costs storage and write throughput — and a spec that advertises
parameters the server does not support is wrong in the direction that causes
support tickets. `--search-params` narrows what is emitted:

```sh
fhir-oas generate Observation -f r4 --search-params none      # none at all
fhir-oas generate Observation -f r4 --search-params minimal   # the common core below
fhir-oas generate Observation -f r4 --search-params code,date # exactly the codes you name
fhir-oas generate Patient Observation -f r4 \
  --search-params Patient:name,birthdate Observation:code,date
```

A code list is taken literally — it is _your_ list, and nothing is added to it.

### Tuning a preset

No fixed rule can know which parameters matter for a given resource.
`Observation.based-on`, `CarePlan.goal` and `MedicationStatement.adherence` are
each central to their resource, and none is common enough to curate globally. A
preset is therefore a starting point that `+code` and `-code` adjust:

```sh
--search-params minimal,+based-on          # the preset plus one more
--search-params minimal,+goal,+condition   # plus several
--search-params minimal,-category          # the preset minus one
--search-params all,-note,-derived-from    # everything except these
--search-params Observation:minimal,+based-on CarePlan:minimal,+goal
```

The preset comes first; everything after it is an adjustment. Every code named
anywhere — in a list, an `+add`, or a `-remove` — must exist on that resource,
so a typo fails loudly instead of quietly shrinking the contract. Mixing a
preset with bare codes is rejected rather than guessed at: write `minimal,+code`
to extend the preset, or drop the preset to give an exact list.

`minimal` is the one curated selection, and it is tiered so that it means
something for every resource rather than only those that happen to use common
parameter names:

1. The parameters most servers index regardless of resource type —
   `identifier`, `status`, `patient`, `subject`, `encounter`, `code`,
   `category`, `date`, `type`, `url`, `name` — where the resource defines any.
2. Otherwise, parameters addressing a **top-level element** directly
   (`Linkage.author`) rather than something nested or filtered
   (`Linkage.item.resource`). These address the resource itself and are the
   cheapest to index.
3. Otherwise, everything the resource defines.

On R4 that takes `Observation` from 38 parameters to 8 (`category`, `code`,
`date`, `encounter`, `identifier`, `patient`, `status`, `subject`) and
`Patient` from 23 to 2 (`identifier`, `name`), both via tier 1. `Linkage`,
whose parameters are `author`, `item` and `source` and which names no common
code, goes from 3 to 1 via tier 2 rather than to nothing.

Across R4/R4B/R5 no resource that defines a search parameter is left with none,
while a median resource keeps 4 and roughly two thirds of resource-specific
parameters are dropped. A resource that defines **no** search parameters at all
(`Binary`, `OperationOutcome`) yields none, because there is nothing to select
— that is not `minimal` doing anything.

It remains a convenience and a judgement call: FHIR has no "commonly indexed"
marker, so tier 1 is a fixed hand-picked list. When the selection matters, name
the codes explicitly or derive them from your server with `--capability` —
either is exact, where `minimal` is only a reasonable default.

Note that this trims the _contract_, not the server — it does not itself make
anything faster. Its value is that the published spec matches the deployment.
If your server already declares its tuned surface, `--capability` derives the
same restriction from `/metadata` with nothing to maintain by hand, and the two
combine: passing both emits only parameters that satisfy each.

## What this is for — and what it is not

**Intended use**

- Generate typed FHIR models and API clients in any language — especially where no mature FHIR SDK exists (Go, Rust, Kotlin, PHP, C++, ...).
- Publish an OpenAPI contract to the consumers of your FHIR API, so they integrate against a spec rather than prose.
- Build typed clients for orchestrator-style FHIR endpoints your services call.
- Feed API gateways, contract-testing tools, mock servers, and documentation portals that speak OpenAPI.
- Commit the generated spec next to your service and regenerate on FHIR version bumps; merge mode keeps hand-written spec content intact.

**Not intended for — do not use this as**

- **A FHIR validator.** Passing schema validation does _not_ make a resource FHIR-conformant: FHIRPath invariants, terminology bindings, and profile constraints (slicing, must-support, cardinality refinements) are not fully represented in OpenAPI. Validate with a real FHIR validator (HAPI, the official validator, server-side `$validate`).
- **A full profile / conformance engine.** `--profile` applies the _representable_ profile constraints (see the table below), but slicing, extension slices, `pattern[x]`, FHIRPath invariants, and must-support are **not enforced** — they are surfaced as description notes and `x-fhir-constraints-omitted`, not as schema rules.
- **A replacement for a full FHIR SDK.** HAPI FHIR and Firely offer richer, spec-aware models and conformance tooling than any OpenAPI codegen can; where you need that depth, use them alongside this rather than instead of it.
- **XML payload handling.** Only the FHIR JSON representation is modeled.

## Profiles: what `--profile` applies

Given `--ig <package> --profile <id>`, the profile snapshot is turned into a schema named after the profile (`USCorePatient`), referenced from the base `/Patient` paths:

| Profile constraint                                                                  | Schema effect                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `min ≥ 1`                                                                           | property becomes `required`                                            |
| `max: "0"`                                                                          | property omitted                                                       |
| `max: "1"` on a base array                                                          | scalar instead of array                                                |
| required binding, resolvable ValueSet (IG-local, then vendored core; ≤150 codes)    | inline `enum`                                                          |
| `fixed[x]` on an element emitted as its own property                                | `const` (3.1) / single-value `enum` (3.0.3)                            |
| `fixed[x]` **inside** a datatype or slice (e.g. `Observation.category.coding.code`) | _not applied_ — see below                                              |
| choice-type narrowing                                                               | only the permitted `value[x]` expansions emitted                       |
| `pattern[x]`, slicing, invariants, must-support                                     | _not enforced_ — noted in `description` + `x-fhir-constraints-omitted` |

Note on `fixed[x]`: real IGs usually pin values at paths _inside_ a datatype
(`Observation.category.coding.code`) or inside a slice, rather than on a
resource element directly. Those datatypes are emitted once as shared schemas
and referenced with `$ref`, so a constraint that applies to one profile's use
of `CodeableConcept` cannot be written into the shared `CodeableConcept`
schema. Such fixed values are therefore **not** represented — US Core Blood
Pressure, for example, declares six and none appear as `const`. Only fixed
values on elements the profile emits as their own property are applied.

The IG package is a local `.tgz` / unpacked directory, or a `name@version` coordinate fetched from `packages.fhir.org` and cached under `~/.fhir-oas/packages`. Profiles must ship a snapshot (differential-only packages error); the package FHIR version must match `--fhir-version`; only the public registry is supported (no auth).

## Assumptions and known limitations

- Output is inherently lossy relative to the FHIR specification (see above); it trades fidelity for reach across language ecosystems.
- Enums cover _required_ bindings whose ValueSet expands to a bounded code list (≤150 codes, no filters); extensible/preferred bindings and open code systems (BCP-47 languages, MIME types) stay plain strings by design.
- Primitive-extension properties (`_field`) are kept for JSON fidelity; they roughly double the property count of each model.
- Search parameters are typed as strings (except `_count`), because FHIR search values carry prefixes and modifiers (`ge2021-01-01`, `code:below=...`) that stricter types would reject. The FHIR type, accepted codes and accepted prefixes are surfaced as metadata instead — see [Search parameters](#search-parameters).
- Search _modifiers_ (`:exact`, `:contains`, `:not`, `:missing`, `:below`, ...) are not emitted as separate parameters; only the base parameter name is. Chained (`subject.name`) and composite-on-the-fly parameters are likewise not enumerated beyond those the specification defines.
- Operations are resource-scoped only: system-level operations (`GET /$export`-style, `$convert`, ...), `POST /_search`, batch/transaction semantics, and conditional headers beyond `If-Match` are not modeled. Multi-part operation parameters collapse to a generic `Parameters` body.
- `--capability` reflects a server's _declared_ surface: resource types the FHIR version doesn't define are skipped, and declared operations are emitted only when they map to a known OperationDefinition (system-level interactions like transaction/batch are not modeled). It restricts what's generated; it does not verify the server actually behaves as declared.
- The two definition backends can differ cosmetically (e.g. naming of deeply nested backbone elements, primitive regex patterns); `schema-json` is the default and the reference.
- They also differ on one thing that is **not** cosmetic: **mandatory primitive elements**. `structure-def` marks them `required` (the StructureDefinition says `min: 1`), while `schema-json` does not, because the official `fhir.schema.json` omits them — a FHIR primitive may legitimately appear as only its `_element` extension sibling (e.g. carrying a `dataAbsentReason`), so the JSON property itself is not strictly required. `Observation.status` is the canonical example: required under `structure-def`, optional under `schema-json`. Mandatory _complex_ elements (`Observation.code`) are required under both. Pick `structure-def` if you want stricter generated models.

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

The README demo (`docs/demo.gif`) is regenerated by `scripts/make-demo.mjs`. It
drives a real generation plus Swagger UI in headless Chromium, so it needs
dev-only tooling that is deliberately kept out of `package.json`:

```sh
npm install --no-save playwright swagger-ui-dist gifenc pngjs
npm run build && node scripts/make-demo.mjs
```
