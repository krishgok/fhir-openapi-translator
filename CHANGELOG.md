# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--search-params` limits which resource-specific search parameters are
  emitted: a preset (`all`, `minimal`, `none`), an explicit code list
  (`code,date,subject`), or per-resource (`Patient:name,birthdate`). Unknown
  codes are an error rather than being silently dropped. Combines with
  `--capability` by intersection. The common result parameters (`_id`,
  `_count`, ...) are always emitted. `minimal` is tiered — common parameter
  names first, then parameters addressing a top-level element directly, then
  everything — so no resource that defines a search parameter is left with
  none, while a median resource keeps 4.
- `x-fhir-search-values` on token search parameters bound to a required
  ValueSet, and `x-fhir-search-prefixes` on `number`/`date`/`quantity`
  parameters, listing the comparison prefixes (`eq`, `ne`, `gt`, `lt`, `ge`,
  `le`, `sa`, `eb`, `ap`) their values may carry. Both are metadata rather than
  schema constraints: an `enum` would reject the comma-OR, `system|code` and
  `:modifier` forms that FHIR search permits.

### Changed

- Search parameter descriptions are now derived from the definitions rather
  than passed through from HL7's prose, which is not uniform — `Encounter-status`
  spelled its codes out while `Observation-status` did not, though both are
  token parameters over a required binding. Every parameter of a given kind now
  reads the same way, and reports the codes its own FHIR version defines.
- Search parameters shared across resources carry a union expression
  (`Patient.gender | Person.gender | ...`); the branch matching the resource
  being generated is now resolved, so `MedicationRequest.status` and
  `MedicationDispense.status` each report their own code list. Previously such
  parameters were left unenumerated entirely.

## [0.1.1] - 2026-09-13

Three correctness fixes. Specs generated with 0.1.0 should be regenerated:
all three produced silently wrong output rather than errors.

### Fixed

- **Every schema was missing its `id` property.** The OpenAPI emitter stripped
  the JSON Schema `id`/`$id` keywords everywhere, including inside `properties`
  maps where `id` is an ordinary FHIR element name. 660 of 679 R4 definitions
  declare one, so nearly every generated model lacked its resource id.
- **Binding enums were absent on R4B and R5.** Enum generation read inline
  enums from the official `fhir.schema.json`, but HL7 stopped inlining them
  after R4 (R4 has 246 occurrences; R4B has 27 and R5 has 26). Required-binding
  codes are now resolved from the vendored definitions on every version, so
  `--no-enums` is once again the only thing that turns them off.
- **Profiles failed to generate against real IG packages.** A `contentReference`
  written in the absolute canonical form that IG snapshot generators emit
  (`http://hl7.org/fhir/StructureDefinition/Observation#Observation.referenceRange`)
  was parsed as though it were the core `#Observation.referenceRange` short
  form, producing a mangled schema name and aborting generation. US Core Blood
  Pressure, among others, could not be generated at all.

### Documentation

- Corrected the `fixed[x]` → `const` claim. Real IGs usually pin values at
  paths _inside_ a datatype or slice (`Observation.category.coding.code`).
  Those datatypes are emitted once as shared schemas and referenced by `$ref`,
  so such constraints cannot be represented and are **not** applied. Only fixed
  values on elements a profile emits as their own property become a `const`.

### Testing

- Added `claims.test.ts`: one assertion block per README capability claim,
  across every FHIR version, OpenAPI target and backend it claims to support.
- Added `fidelity.test.ts`: field-level checks that use the vendored FHIR
  definitions as an oracle instead of hand-written expectations. Covers 45
  resources drawn from the Foundation, Base, Clinical, Financial and
  Specialized modules, in R4/R4B/R5, down to backbone depth — cardinality,
  requiredness, primitive JSON types, choice expansion, `_field` primitive
  extension siblings, and `$ref` resolution.

All three bugs above shared a cause: coverage that confirmed expectations at a
single point of a multi-point matrix. Enums were asserted only on R4, profiles
only on `us-core-patient`, and `id` never at all.

## [0.1.0] - 2026-09-12

Initial release.
