import {
  loadStructureDefinitions,
  type MinElement,
  type MinStructureDefinition,
} from "../definitions.js";
import type { DefinitionRegistry } from "../ir/registry.js";
import type { FhirVersion, JsonSchemaNode } from "../types.js";

/**
 * Builds the definition registry by walking StructureDefinition snapshots —
 * the canonical FHIR metadata, and the basis for future profile support.
 * Produces the same IR shape as the fhir.schema.json backend: named
 * definitions referencing each other via `#/definitions/<Name>`.
 *
 * Naming: backbone elements become `<Root>_<Segment>_<Segment>` (e.g.
 * `Bundle_Entry_Search`), which is collision-free but can differ from
 * fhir.schema.json's flatter names for deeply nested backbones.
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
    buildComplexDefinitions(sd, definitions);
    if (sd.kind === "resource") resourceNames.push(sd.name);
  }

  // Element/BackboneElement are abstract but referenced by primitive-extension
  // (`_field`) properties, so they need concrete definitions.
  for (const abstractName of ["Element", "BackboneElement"]) {
    const sd = byName.get(abstractName);
    if (sd && !definitions.has(abstractName)) {
      buildComplexDefinitions(sd, definitions);
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

function segmentToPascal(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function definitionNameForPath(path: string): string {
  const [root, ...rest] = path.split(".");
  if (rest.length === 0) return root ?? path;
  return [root, ...rest.map(segmentToPascal)].join("_");
}

function isBackbone(el: MinElement): boolean {
  return (el.types ?? []).some((t) => t.code === "BackboneElement" || t.code === "Element");
}

/** Type codes from the FHIRPath system (used on `id`, `Extension.url`, ...). */
function systemTypeSchema(code: string): JsonSchemaNode | undefined {
  if (!code.startsWith("http://hl7.org/fhirpath/System.")) return undefined;
  const kind = code.slice("http://hl7.org/fhirpath/System.".length);
  switch (kind) {
    case "Boolean":
      return { type: "boolean" };
    case "Integer":
    case "Decimal":
      return { type: "number" };
    default:
      return { type: "string" };
  }
}

interface ElementNode {
  element: MinElement;
  children: Map<string, ElementNode>;
}

function buildElementTree(sd: MinStructureDefinition): ElementNode | undefined {
  const rootPath = sd.type ?? sd.name;
  let root: ElementNode | undefined;
  const nodes = new Map<string, ElementNode>();
  for (const el of sd.elements) {
    const node: ElementNode = { element: el, children: new Map() };
    nodes.set(el.path, node);
    if (el.path === rootPath) {
      root = node;
      continue;
    }
    const parentPath = el.path.slice(0, el.path.lastIndexOf("."));
    const segment = el.path.slice(el.path.lastIndexOf(".") + 1);
    nodes.get(parentPath)?.children.set(segment, node);
  }
  return root;
}

function buildComplexDefinitions(
  sd: MinStructureDefinition,
  definitions: Map<string, JsonSchemaNode>,
): void {
  const root = buildElementTree(sd);
  if (!root) return;
  emitObjectDefinition(sd, sd.name, root, definitions, sd.kind === "resource");
}

function emitObjectDefinition(
  sd: MinStructureDefinition,
  name: string,
  node: ElementNode,
  definitions: Map<string, JsonSchemaNode>,
  isResourceRoot: boolean,
): void {
  if (definitions.has(name)) return;
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  if (isResourceRoot) {
    properties.resourceType = {
      description: `This is a ${sd.name} resource`,
      const: sd.name,
    };
    required.push("resourceType");
  }

  // Reserve the name before recursing so cycles terminate.
  const definition: JsonSchemaNode = {
    ...(node.element.definition ? { description: node.element.definition } : {}),
    properties,
    additionalProperties: false,
  };
  definitions.set(name, definition);

  for (const [segment, child] of node.children) {
    emitProperty(sd, name, segment, child, properties, required, definitions);
  }
  if (required.length > 0) definition.required = required.sort();
}

function emitProperty(
  sd: MinStructureDefinition,
  parentName: string,
  segment: string,
  node: ElementNode,
  properties: Record<string, JsonSchemaNode>,
  required: string[],
  definitions: Map<string, JsonSchemaNode>,
): void {
  const el = node.element;
  const description = el.definition ?? el.short;
  const isArray = el.max === "*" || Number(el.max) > 1;
  const isChoice = segment.endsWith("[x]");

  const addProperty = (fieldName: string, schema: JsonSchemaNode, primitive: boolean) => {
    properties[fieldName] = wrapCardinality(schema, isArray, description);
    if (primitive) {
      properties[`_${fieldName}`] = wrapCardinality(
        { $ref: "#/definitions/Element" },
        isArray,
        `Extensions for ${fieldName}`,
      );
    }
  };

  if (isChoice) {
    const base = segment.slice(0, -3);
    for (const type of el.types ?? []) {
      const fieldName = base + segmentToPascal(type.code);
      const { schema, primitive } = schemaForTypeCode(type.code, el);
      addProperty(fieldName, schema, primitive);
    }
    // Choice fields are never individually required: the constraint "exactly
    // one of the expansions" is not expressible in required[].
    return;
  }

  if (el.contentReference) {
    // e.g. "#Questionnaire.item" -> Questionnaire_Item
    const target = definitionNameForPath(el.contentReference.replace(/^#/, ""));
    addProperty(segment, { $ref: `#/definitions/${target}` }, false);
  } else if (isBackbone(el) && node.children.size > 0) {
    const childName = `${parentName}_${segmentToPascal(segment)}`;
    emitObjectDefinition(sd, childName, node, definitions, false);
    addProperty(segment, { $ref: `#/definitions/${childName}` }, false);
  } else {
    const type = (el.types ?? [])[0];
    if (!type) return; // extension-only or profiled-out element
    const { schema, primitive } = schemaForTypeCode(type.code, el);
    addProperty(segment, schema, primitive);
  }

  if (el.min >= 1) required.push(segment);
}

function schemaForTypeCode(
  code: string,
  el: MinElement,
): { schema: JsonSchemaNode; primitive: boolean } {
  const system = systemTypeSchema(code);
  if (system) return { schema: system, primitive: false };
  if (code === "Resource" || code === "DomainResource") {
    return { schema: { $ref: "#/definitions/ResourceList" }, primitive: false };
  }
  const primitive = code.charAt(0) === code.charAt(0).toLowerCase();
  // Required bindings whose ValueSet was resolved at vendor time become
  // inline enums on `code` elements, mirroring the official fhir.schema.json.
  if (code === "code" && el.binding?.codes?.length) {
    return { schema: { enum: el.binding.codes }, primitive: true };
  }
  return { schema: { $ref: `#/definitions/${code}` }, primitive };
}

function wrapCardinality(
  schema: JsonSchemaNode,
  isArray: boolean,
  description?: string,
): JsonSchemaNode {
  const withDescription = (s: JsonSchemaNode) =>
    description && !("$ref" in s) ? { description, ...s } : s;
  if (isArray) {
    return {
      ...(description ? { description } : {}),
      type: "array",
      items: schema,
    };
  }
  if ("$ref" in schema && description) {
    // JSON Schema draft-06/OAS 3.0 ignores siblings of $ref; nest description
    // via allOf only in 3.1. Keep plain $ref for compatibility.
    return schema;
  }
  return withDescription(schema);
}
