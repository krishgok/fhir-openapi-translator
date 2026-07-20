#!/usr/bin/env bash
# Reproduce the example specs from examples/README.md into ./out.
# Run from anywhere; uses the locally built CLI (run `npm run build` first) or
# falls back to the published package via npx.
set -euo pipefail

cd "$(dirname "$0")"
OUT="out"
mkdir -p "$OUT"

# Prefer the locally built CLI; otherwise use npx.
if [ -f "../dist/cli.js" ]; then
  OAS() { node ../dist/cli.js "$@"; }
else
  OAS() { npx --yes fhir-openapi-translator "$@"; }
fi

echo "1/3  Patient (R4) base resource"
OAS generate Patient --fhir-version r4 -o "$OUT/patient.r4.openapi.yaml"

echo "2/3  US Core Patient profile"
OAS generate Patient -f r4 \
  --ig hl7.fhir.us.core@5.0.1 --profile us-core-patient \
  -o "$OUT/us-core-patient.r4.openapi.yaml" \
  || echo "   (skipped: needs network access to packages.fhir.org)"

echo "3/3  Server surface from a CapabilityStatement"
OAS generate -f r4 \
  --capability ../test/fixtures/capabilitystatement-minimal.json \
  -o "$OUT/server-from-capability.r4.openapi.yaml"

echo "Done. Specs written to examples/$OUT/"
