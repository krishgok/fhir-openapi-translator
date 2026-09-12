import { loadFhirSchema, loadStructureDefinitions } from "../definitions.js";
import type { DefinitionRegistry } from "../ir/registry.js";
import type { FhirVersion, JsonSchemaNode } from "../types.js";

/**
 * Builds the definition registry from the official `fhir.schema.json`
 * published with each FHIR release. This schema already has choice types
 * (value[x]) expanded and backbone elements flattened into named definitions
 * (e.g. `Patient_Contact`), so it maps directly onto the IR.
 *
 * One gap it does not cover: HL7 stopped inlining required-binding enums in
 * fhir.schema.json after R4, and even R4 only inlines some of them. The codes
 * are resolved at vendor time onto the StructureDefinition elements, so they
 * are applied here too — see applyBindingEnums.
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

  applyBindingEnums(definitions, fhirVersion);

  return { fhirVersion, definitions, resourceNames };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * fhir.schema.json names flattened backbones `<Root>_<Segment>`; the element
 * paths they came from are `<Root>.<segment>`. Reverses that so a definition
 * and property can be looked up against the StructureDefinition elements.
 */
function elementPathFor(definitionName: string, property: string): string {
  const [root, ...backbones] = definitionName.split("_");
  return [root, ...backbones.map(lowerFirst), property].join(".");
}

/** element path -> resolved codes, for required bindings only. */
function bindingCodeIndex(fhirVersion: FhirVersion): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const sd of loadStructureDefinitions(fhirVersion)) {
    for (const el of sd.elements) {
      if (el.binding?.strength === "required" && el.binding.codes?.length) {
        index.set(el.path, el.binding.codes);
      }
    }
  }
  return index;
}

/**
 * Replaces plain `code` references with the inline enum for that element's
 * required binding. Only `code` targets are touched: Coding/CodeableConcept
 * carry their binding differently and stay as they are. Properties that
 * already have an enum (R4 ships many inline) are left alone.
 */
function applyBindingEnums(
  definitions: Map<string, JsonSchemaNode>,
  fhirVersion: FhirVersion,
): void {
  const codesByPath = bindingCodeIndex(fhirVersion);
  const isCodeRef = (node: JsonSchemaNode | undefined) =>
    !!node && node.$ref === "#/definitions/code";

  for (const [name, definition] of definitions) {
    const properties = definition.properties as Record<string, JsonSchemaNode> | undefined;
    if (!properties) continue;

    for (const [property, schema] of Object.entries(properties)) {
      const codes = codesByPath.get(elementPathFor(name, property));
      if (!codes) continue;

      const description = schema.description as string | undefined;
      const withDescription = (node: JsonSchemaNode) =>
        description ? { description, ...node } : node;

      if (isCodeRef(schema)) {
        properties[property] = withDescription({ enum: [...codes] });
      } else if (schema.type === "array" && isCodeRef(schema.items as JsonSchemaNode)) {
        properties[property] = withDescription({ type: "array", items: { enum: [...codes] } });
      }
    }
  }
}
