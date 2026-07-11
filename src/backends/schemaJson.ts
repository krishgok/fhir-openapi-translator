import { loadFhirSchema } from "../definitions.js";
import type { DefinitionRegistry } from "../ir/registry.js";
import type { FhirVersion, JsonSchemaNode } from "../types.js";

/**
 * Builds the definition registry from the official `fhir.schema.json`
 * published with each FHIR release. This schema already has choice types
 * (value[x]) expanded and backbone elements flattened into named definitions
 * (e.g. `Patient_Contact`), so it maps directly onto the IR.
 */
export function buildRegistryFromSchemaJson(fhirVersion: FhirVersion): DefinitionRegistry {
  const schema = loadFhirSchema(fhirVersion);
  const definitions = new Map<string, JsonSchemaNode>(Object.entries(schema.definitions));

  // Resource types are exactly the discriminator mapping keys; fall back to
  // "has a resourceType const" for robustness.
  let resourceNames: string[];
  if (schema.discriminator?.mapping) {
    resourceNames = Object.keys(schema.discriminator.mapping);
  } else {
    resourceNames = [...definitions.entries()]
      .filter(([, def]) => {
        const props = def.properties as Record<string, JsonSchemaNode> | undefined;
        return props?.resourceType !== undefined && "const" in (props.resourceType ?? {});
      })
      .map(([name]) => name);
  }

  return { fhirVersion, definitions, resourceNames };
}
