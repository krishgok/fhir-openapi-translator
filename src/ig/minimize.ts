import type { MinElement, MinElementType, MinStructureDefinition } from "../definitions.js";

/**
 * Minimizes raw FHIR StructureDefinition / terminology resources loaded from
 * an IG package into the same `MinStructureDefinition` shape the vendored core
 * definitions use, so profile snapshots feed the shared structure walker.
 *
 * This mirrors the element-minimizing shape in scripts/update-definitions.mjs
 * (which vendors the core packages at build time). The two are kept separate
 * on purpose: this one runs at generation time on arbitrary IG packages and
 * additionally captures profile constraints (`fixed[x]`, `mustSupport`,
 * unenforced `pattern`/slicing), which the base definitions never need.
 */

/** Above this size an enum stops helping codegen and starts hurting it. */
const MAX_ENUM_CODES = 150;

interface RawElement {
  path: string;
  min?: number;
  max?: string;
  short?: string;
  definition?: string;
  contentReference?: string;
  mustSupport?: boolean;
  slicing?: unknown;
  sliceName?: string;
  type?: { code: string; targetProfile?: string[]; extension?: RawExtension[] }[];
  binding?: { strength?: string; valueSet?: string };
  [key: string]: unknown;
}

interface RawExtension {
  url: string;
  valueUrl?: string;
}

export interface RawStructureDefinition {
  resourceType: string;
  name: string;
  id?: string;
  url: string;
  kind: string;
  type: string;
  abstract?: boolean;
  derivation?: string;
  baseDefinition?: string;
  fhirVersion?: string;
  snapshot?: { element: RawElement[] };
}

export type ValueSetResolver = (valueSetUrl: string) => string[] | undefined;

const FHIR_TYPE_EXTENSION =
  "http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type";

/** Extracts the normalized `fixed[x]` value from a snapshot element, if any. */
function fixedValue(el: RawElement): unknown {
  for (const key of Object.keys(el)) {
    if (key.startsWith("fixed") && key.length > 5) return el[key];
  }
  return undefined;
}

function omittedConstraints(el: RawElement): string[] | undefined {
  const notes: string[] = [];
  if (el.slicing || el.sliceName) notes.push("slicing");
  if (Object.keys(el).some((k) => k.startsWith("pattern") && k.length > 7)) {
    notes.push("pattern");
  }
  return notes.length > 0 ? notes : undefined;
}

function minimizeElement(el: RawElement, resolveValueSet?: ValueSetResolver): MinElement {
  const out: MinElement = { path: el.path, min: el.min ?? 0, max: el.max ?? "*" };
  if (el.short) out.short = el.short;
  if (el.definition) out.definition = el.definition;
  if (el.contentReference) out.contentReference = el.contentReference;
  if (el.type) {
    out.types = el.type.map((t) => {
      const type: MinElementType = { code: t.code };
      if (t.targetProfile) type.targetProfile = t.targetProfile;
      const fhirType = (t.extension ?? []).find((e) => e.url === FHIR_TYPE_EXTENSION);
      if (fhirType?.valueUrl) type.fhirType = fhirType.valueUrl;
      return type;
    });
  }
  if (el.binding?.strength === "required" && el.binding.valueSet) {
    out.binding = { strength: el.binding.strength, valueSet: el.binding.valueSet };
    const codes = resolveValueSet?.(el.binding.valueSet);
    if (codes) out.binding.codes = [...codes].sort();
  }
  const fixed = fixedValue(el);
  if (fixed !== undefined) out.fixed = fixed;
  if (el.mustSupport) out.mustSupport = true;
  const omitted = omittedConstraints(el);
  if (omitted) out.omittedConstraints = omitted;
  return out;
}

export function minimizeStructureDefinition(
  sd: RawStructureDefinition,
  resolveValueSet?: ValueSetResolver,
): MinStructureDefinition {
  return {
    name: sd.name,
    url: sd.url,
    kind: sd.kind as MinStructureDefinition["kind"],
    type: sd.type,
    abstract: !!sd.abstract,
    baseDefinition: sd.baseDefinition,
    elements: (sd.snapshot?.element ?? []).map((el) => minimizeElement(el, resolveValueSet)),
  };
}

interface RawValueSet {
  resourceType: string;
  url?: string;
  compose?: {
    include?: RawValueSetGroup[];
    exclude?: RawValueSetGroup[];
  };
}

interface RawValueSetGroup {
  system?: string;
  concept?: { code: string }[];
  filter?: unknown[];
  valueSet?: string[];
}

interface RawCodeSystem {
  resourceType: string;
  url?: string;
  content?: string;
  concept?: RawConcept[];
}

interface RawConcept {
  code: string;
  concept?: RawConcept[];
}

/**
 * Builds a ValueSet URL -> flat code list resolver from the ValueSet and
 * CodeSystem resources available (IG-local plus, optionally, a fallback for
 * the vendored core terminology). Only simple composes are resolved; anything
 * with filters or valueSet imports is left unresolved, so the binding stays a
 * plain code — exactly the core behavior.
 */
export function buildValueSetResolver(
  resources: (RawValueSet | RawCodeSystem)[],
  fallback?: ValueSetResolver,
): ValueSetResolver {
  const codeSystems = new Map<string, RawCodeSystem>();
  const valueSets = new Map<string, RawValueSet>();
  for (const r of resources) {
    if (r.resourceType === "CodeSystem" && r.url) codeSystems.set(r.url, r as RawCodeSystem);
    if (r.resourceType === "ValueSet" && r.url) valueSets.set(r.url, r as RawValueSet);
  }

  function conceptCodes(concepts: RawConcept[] | undefined, out: string[]): string[] {
    for (const c of concepts ?? []) {
      out.push(c.code);
      if (c.concept) conceptCodes(c.concept, out);
    }
    return out;
  }

  function resolveGroup(group: RawValueSetGroup): string[] | undefined {
    if (group.filter?.length || group.valueSet?.length) return undefined;
    if (group.concept?.length) return group.concept.map((c) => c.code);
    if (!group.system) return undefined;
    const cs = codeSystems.get(group.system);
    if (!cs || cs.content === "not-present" || !cs.concept) return undefined;
    return conceptCodes(cs.concept, []);
  }

  return function resolve(valueSetUrl: string): string[] | undefined {
    const versionless = valueSetUrl.split("|")[0]!;
    const vs = valueSets.get(versionless);
    if (!vs?.compose?.include?.length) return fallback?.(valueSetUrl);
    const codes = new Set<string>();
    for (const group of vs.compose.include) {
      const groupCodes = resolveGroup(group);
      if (!groupCodes) return fallback?.(valueSetUrl);
      for (const code of groupCodes) codes.add(code);
    }
    for (const group of vs.compose.exclude ?? []) {
      const groupCodes = resolveGroup(group);
      if (!groupCodes) return fallback?.(valueSetUrl);
      for (const code of groupCodes) codes.delete(code);
    }
    if (codes.size === 0 || codes.size > MAX_ENUM_CODES) return fallback?.(valueSetUrl);
    return [...codes];
  };
}
