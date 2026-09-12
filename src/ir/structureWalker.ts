import type { MinElement, MinStructureDefinition } from "../definitions.js";
import type { JsonSchemaNode } from "../types.js";

/**
 * Walks a StructureDefinition snapshot into named IR schema definitions
 * (`#/definitions/<Name>` refs). Shared by the core structure-def backend
 * (base resources/types) and the profile applier (IG profiles), so the two
 * produce identical schema shapes and only differ in the constraints applied.
 */
export interface EmitOptions {
  /** Schema name for the root definition (e.g. "Patient" or "USCorePatient"). */
  rootName: string;
  /** Emit a `resourceType` discriminator property. */
  isResourceRoot: boolean;
  /**
   * Wire resourceType/description name. Defaults to the SD `type`. For a
   * profile this stays the base resource ("Patient") even though rootName is
   * the profile name, because resourceType on the wire is the base type.
   */
  resourceDisplayName?: string;
  /**
   * Apply profile constraints while walking: drop `max: "0"` elements and
   * turn `fixed[x]` into a `const`. Off for base definitions so their output
   * is unchanged.
   */
  profile?: boolean;
}

interface ElementNode {
  element: MinElement;
  children: Map<string, ElementNode>;
}

function segmentToPascal(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
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

/**
 * Names a backbone reached by a `contentReference` (e.g. "#Questionnaire.item"
 * -> "Questionnaire_Item"). When walking a profile, a self-reference to the
 * base type root is remapped onto the profile's own name so the ref resolves
 * within the emitted profile schemas.
 */
function contentReferenceName(reference: string, sd: MinStructureDefinition, rootName: string): string {
  // Two forms occur: the core definitions use "#Observation.referenceRange",
  // while IG snapshot generators emit the absolute canonical
  // "http://hl7.org/fhir/StructureDefinition/Observation#Observation.referenceRange".
  // Only the fragment names the element path.
  const hash = reference.lastIndexOf("#");
  const path = hash >= 0 ? reference.slice(hash + 1) : reference;
  const [root, ...rest] = path.split(".");
  if (rest.length === 0) return root ?? path;
  const prefix = root === (sd.type ?? sd.name) ? rootName : (root ?? "");
  return [prefix, ...rest.map(segmentToPascal)].join("_");
}

export function emitStructureDefinitionSchemas(
  sd: MinStructureDefinition,
  definitions: Map<string, JsonSchemaNode>,
  opts: EmitOptions,
): void {
  const root = buildElementTree(sd);
  if (!root) return;
  emitObjectDefinition(sd, opts.rootName, root, definitions, opts.isResourceRoot, opts);
}

function emitObjectDefinition(
  sd: MinStructureDefinition,
  name: string,
  node: ElementNode,
  definitions: Map<string, JsonSchemaNode>,
  isResourceRoot: boolean,
  opts: EmitOptions,
): void {
  if (definitions.has(name)) return;
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  const displayName = opts.resourceDisplayName ?? sd.type ?? sd.name;

  if (isResourceRoot) {
    properties.resourceType = {
      description: `This is a ${displayName} resource`,
      const: displayName,
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
    emitProperty(sd, name, segment, child, properties, required, definitions, opts);
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
  opts: EmitOptions,
): void {
  const el = node.element;
  // Profile constraint: an element constrained out (max 0) is removed.
  if (opts.profile && el.max === "0") return;

  const isArray = el.max === "*" || Number(el.max) > 1;
  const isChoice = segment.endsWith("[x]");

  // In profile mode, annotate must-support and constraints not enforced in
  // OpenAPI (pattern, slicing) so they survive into generated docs.
  let description = el.definition ?? el.short;
  const omitted: string[] = [];
  if (opts.profile) {
    if (el.mustSupport) omitted.push("must-support");
    if (el.omittedConstraints) omitted.push(...el.omittedConstraints);
    if (omitted.length > 0) {
      const note = `Profile constraints not enforced here: ${omitted.join(", ")}.`;
      description = description ? `${description} ${note}` : note;
    }
  }

  const addProperty = (fieldName: string, schema: JsonSchemaNode, primitive: boolean) => {
    const annotated =
      omitted.length > 0 && !("$ref" in schema)
        ? { ...schema, "x-fhir-constraints-omitted": omitted }
        : schema;
    properties[fieldName] = wrapCardinality(annotated, isArray, description);
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
      const { schema, primitive } = schemaForTypeCode(type.code, el, opts);
      addProperty(fieldName, schema, primitive);
    }
    // Choice fields are never individually required: the constraint "exactly
    // one of the expansions" is not expressible in required[].
    return;
  }

  if (el.contentReference) {
    const target = contentReferenceName(el.contentReference, sd, opts.rootName);
    addProperty(segment, { $ref: `#/definitions/${target}` }, false);
  } else if (isBackbone(el) && node.children.size > 0) {
    const childName = `${parentName}_${segmentToPascal(segment)}`;
    emitObjectDefinition(sd, childName, node, definitions, false, opts);
    addProperty(segment, { $ref: `#/definitions/${childName}` }, false);
  } else {
    const type = (el.types ?? [])[0];
    if (!type) return; // extension-only or profiled-out element
    const { schema, primitive } = schemaForTypeCode(type.code, el, opts);
    addProperty(segment, schema, primitive);
  }

  if (el.min >= 1) required.push(segment);
}

function schemaForTypeCode(
  code: string,
  el: MinElement,
  opts: EmitOptions,
): { schema: JsonSchemaNode; primitive: boolean } {
  const primitive = code.charAt(0) === code.charAt(0).toLowerCase();

  const system = systemTypeSchema(code);
  if (system) return { schema: system, primitive: false };
  if (code === "Resource" || code === "DomainResource") {
    return { schema: { $ref: "#/definitions/ResourceList" }, primitive: false };
  }
  // Profile constraint: a fixed value pins the element to a single constant.
  if (opts.profile && el.fixed !== undefined) {
    return { schema: { const: el.fixed }, primitive };
  }
  // Required bindings whose ValueSet was resolved become inline enums on
  // `code` elements, mirroring the official fhir.schema.json.
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
