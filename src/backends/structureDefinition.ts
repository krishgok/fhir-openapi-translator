import {
  loadStructureDefinitions,
  type MinStructureDefinition,
} from "../definitions.js";
import type { DefinitionRegistry } from "../ir/registry.js";
import { emitStructureDefinitionSchemas } from "../ir/structureWalker.js";
import type { FhirVersion, JsonSchemaNode } from "../types.js";

/**
 * Builds the definition registry by walking StructureDefinition snapshots —
 * the canonical FHIR metadata, and the basis for profile support. Produces the
 * same IR shape as the fhir.schema.json backend: named definitions referencing
 * each other via `#/definitions/<Name>`.
 *
 * The per-snapshot walk lives in ../ir/structureWalker.ts so profiles loaded
 * from an IG package emit identically-shaped schemas.
 */
export function buildRegistryFromStructureDefinitions(
  fhirVersion: FhirVersion,
): DefinitionRegistry {
  const sds = loadStructureDefinitions(fhirVersion);
  const definitions = new Map<string, JsonSchemaNode>();
  const resourceNames: string[] = [];

  const byName = new Map(sds.map((sd) => [sd.name, sd]));

  for (const sd of sds) {
    if (sd.kind === "primitive-type") {
      definitions.set(sd.name, primitiveSchema(sd));
    }
  }
  // `xhtml` (Narrative.div) has no StructureDefinition in the core packages.
  if (!definitions.has("xhtml")) {
    definitions.set("xhtml", {
      type: "string",
      description: "XHTML narrative content",
    });
  }

  for (const sd of sds) {
    if (sd.kind === "primitive-type" || sd.abstract) continue;
    emitStructureDefinitionSchemas(sd, definitions, {
      rootName: sd.name,
      isResourceRoot: sd.kind === "resource",
    });
    if (sd.kind === "resource") resourceNames.push(sd.name);
  }

  // Element/BackboneElement are abstract but referenced by primitive-extension
  // (`_field`) properties, so they need concrete definitions.
  for (const abstractName of ["Element", "BackboneElement"]) {
    const sd = byName.get(abstractName);
    if (sd && !definitions.has(abstractName)) {
      emitStructureDefinitionSchemas(sd, definitions, {
        rootName: sd.name,
        isResourceRoot: false,
      });
    }
  }

  resourceNames.sort();
  definitions.set("ResourceList", {
    oneOf: resourceNames.map((name) => ({ $ref: `#/definitions/${name}` })),
  });

  return { fhirVersion, definitions, resourceNames };
}

/** Maps FHIR primitive type names to their JSON representation. */
function primitiveJsonType(name: string): JsonSchemaNode {
  switch (name) {
    case "boolean":
      return { type: "boolean" };
    case "decimal":
      return { type: "number" };
    case "integer":
    case "positiveInt":
    case "unsignedInt":
      return { type: "number" };
    // integer64 (R5) is represented as a JSON string per the spec.
    default:
      return { type: "string" };
  }
}

function primitiveSchema(sd: MinStructureDefinition): JsonSchemaNode {
  const root = sd.elements[0];
  return {
    ...primitiveJsonType(sd.name),
    ...(root?.definition ? { description: root.definition } : {}),
  };
}
