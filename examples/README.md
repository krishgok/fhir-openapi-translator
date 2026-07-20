# Examples

Worked scenarios showing what `fhir-oas` produces and how it feeds a code generator. Run [`./generate.sh`](generate.sh) to reproduce the full specs locally, or follow along below.

> New here? Start with the [project README](../README.md) and the [full reference](../docs/REFERENCE.md).

## 1. A base resource → typed models in any language

```sh
fhir-oas generate Patient --fhir-version r4 -o patient.yaml
```

You get a complete OpenAPI document: the `Patient` schema, its dependency closure, and the standard REST paths.

```
paths:  /Patient  /Patient/{id}  /Patient/{id}/_history  /Patient/{id}/_history/{vid}  /Patient/_history
```

Required-binding fields come out as **typed enums**, not bare strings:

```yaml
gender:
  description: Administrative Gender - the gender that the patient is considered to have...
  enum: [male, female, other, unknown]
```

Generate a TypeScript client from it:

```sh
npx @openapitools/openapi-generator-cli generate \
  -i patient.yaml -g typescript-fetch -o ./client \
  --additional-properties=modelPropertyNaming=original
```

(The `modelPropertyNaming=original` flag keeps FHIR's `_field` primitive-extension properties from colliding — see [Codegen recipes](../docs/REFERENCE.md#codegen-recipes).)

## 2. A US Core profile

```sh
fhir-oas generate Patient -f r4 \
  --ig hl7.fhir.us.core@5.0.1 --profile us-core-patient
```

The profiled schema (`USCorePatientProfile`) carries the profile's constraints — `identifier`, `name`, and `gender` become **required**, and the profile URL is recorded for traceability:

```yaml
USCorePatientProfile:
  x-fhir-profile: http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient
  required: [gender, identifier, name, resourceType]
```

The base `/Patient` paths reference it, so generated clients speak US Core.

## 3. Match one server's declared surface

Point at a running server (or a saved `metadata.json`) and get a spec of **exactly** what it supports:

```sh
fhir-oas generate -f r4 --capability https://server.example.org/fhir
```

If the server declares only `read` + `search-type` on Patient plus `$everything`, that's all you get — no `create`/`update`/`delete`, and search restricted to its declared parameters:

```
paths:  /Patient  /Patient/{id}  /Patient/$everything  /Patient/{id}/$everything
```

## 4. Keep specs honest in CI

Commit a generated spec next to your service and fail the build if it drifts from the FHIR definitions:

```sh
fhir-oas check Patient Observation -f r4 --file api.yaml
```
