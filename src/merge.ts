import { Document, parseDocument, isMap, type YAMLMap } from "yaml";
import type { OpenApiDocument } from "./types.js";

export interface MergeOptions {
  /** Overwrite conflicting entries instead of failing. */
  force?: boolean;
}

export interface MergeConflict {
  /** e.g. "components.schemas.Patient" or "paths./Patient/{id}" */
  location: string;
}

export class MergeConflictError extends Error {
  constructor(public readonly conflicts: MergeConflict[]) {
    super(
      "Refusing to overwrite existing, differing entries (use --force to overwrite):\n" +
        conflicts.map((c) => `  - ${c.location}`).join("\n"),
    );
    this.name = "MergeConflictError";
  }
}

/** Top-level maps whose entries are merged key-by-key. */
const MERGED_SECTIONS: [string, string][] = [
  ["paths", ""],
  ["components", "schemas"],
  ["components", "parameters"],
];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `ResourceList` is narrowed to the resource types requested at generation
 * time (see ir/registry.ts), so two generated specs legitimately differ in
 * it. Merging unions the two narrowings instead of conflicting. Returns
 * undefined when either side is not the expected oneOf-of-$refs shape.
 */
function unionResourceList(existing: unknown, generated: unknown): unknown | undefined {
  const refsOf = (node: unknown): string[] | undefined => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    const oneOf = (node as { oneOf?: unknown }).oneOf;
    if (!Array.isArray(oneOf)) return undefined;
    const refs: string[] = [];
    for (const item of oneOf) {
      if (!item || typeof item !== "object" || Object.keys(item).length !== 1) return undefined;
      const ref = (item as { $ref?: unknown }).$ref;
      if (typeof ref !== "string") return undefined;
      refs.push(ref);
    }
    return refs;
  };
  const existingRefs = refsOf(existing);
  const generatedRefs = refsOf(generated);
  if (!existingRefs || !generatedRefs) return undefined;
  return {
    ...(generated as Record<string, unknown>),
    oneOf: [...new Set([...existingRefs, ...generatedRefs])].map(($ref) => ({ $ref })),
  };
}

interface MergePlan {
  doc: ReturnType<typeof parseDocument>;
  conflicts: MergeConflict[];
  additions: { path: (string | number)[]; value: unknown }[];
}

/**
 * Parses the existing YAML and computes what a merge would do: entries to add
 * (absent from the file, or ResourceList unions) and conflicting entries
 * (present with different content). Shared by merge and check.
 */
function computeMergePlan(
  generated: OpenApiDocument,
  existingText: string,
  options: MergeOptions,
): MergePlan {
  const doc = parseDocument(existingText);
  if (doc.errors.length > 0) {
    throw new Error(`Cannot parse existing YAML: ${doc.errors[0]?.message}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("Existing file is not a YAML mapping; refusing to merge");
  }

  const existingVersion = doc.getIn(["openapi"]);
  const generatedVersion = generated.openapi;
  if (existingVersion !== undefined && String(existingVersion) !== String(generatedVersion)) {
    throw new Error(
      `OpenAPI version mismatch: existing file declares ${String(existingVersion)}, ` +
        `generating ${String(generatedVersion)}. Regenerate with a matching --openapi-version.`,
    );
  }

  const conflicts: MergeConflict[] = [];
  const additions: { path: (string | number)[]; value: unknown }[] = [];

  // Top-level scalars/objects that only apply when absent.
  for (const key of ["openapi", "info", "servers"]) {
    if (generated[key] !== undefined && doc.getIn([key]) === undefined) {
      additions.push({ path: [key], value: generated[key] });
    }
  }

  // Tags: append missing tag names.
  const generatedTags = (generated.tags ?? []) as { name: string }[];
  if (generatedTags.length > 0) {
    const existingTags = doc.toJS()?.tags as { name: string }[] | undefined;
    if (existingTags === undefined) {
      additions.push({ path: ["tags"], value: generatedTags });
    } else {
      const existingNames = new Set(existingTags.map((t) => t?.name));
      let index = existingTags.length;
      for (const tag of generatedTags) {
        if (!existingNames.has(tag.name)) {
          additions.push({ path: ["tags", index++], value: tag });
        }
      }
    }
  }

  for (const [section, subsection] of MERGED_SECTIONS) {
    const generatedSection = subsection
      ? ((generated[section] as Record<string, unknown> | undefined)?.[subsection] as
          | Record<string, unknown>
          | undefined)
      : (generated[section] as Record<string, unknown> | undefined);
    if (!generatedSection) continue;
    const basePath = subsection ? [section, subsection] : [section];

    for (const [key, value] of Object.entries(generatedSection)) {
      const existing = doc.getIn([...basePath, key], true);
      if (existing === undefined) {
        additions.push({ path: [...basePath, key], value });
      } else {
        const existingJs =
          typeof (existing as YAMLMap)?.toJS === "function"
            ? (existing as YAMLMap).toJS(doc)
            : existing;
        if (!deepEqual(existingJs, value)) {
          if (section === "components" && subsection === "schemas" && key === "ResourceList") {
            const union = unionResourceList(existingJs, value);
            if (union !== undefined) {
              if (!deepEqual(existingJs, union)) {
                additions.push({ path: [...basePath, key], value: union });
              }
              continue;
            }
          }
          conflicts.push({ location: [...basePath, key].join(".") });
          if (options.force) additions.push({ path: [...basePath, key], value });
        }
      }
    }
  }

  return { doc, conflicts, additions };
}

/**
 * Merges a generated OpenAPI document into existing YAML text, preserving the
 * existing file's comments, anchors, and key order. Generated entries are
 * added alongside existing content; an existing entry with different content
 * is a conflict (all conflicts are reported; nothing is written unless every
 * conflict is resolved by `force`). Identical entries are left untouched, so
 * re-running the generator is idempotent.
 */
export function mergeIntoYaml(
  generated: OpenApiDocument,
  existingText: string,
  options: MergeOptions = {},
): string {
  const { doc, conflicts, additions } = computeMergePlan(generated, existingText, options);
  if (doc.contents === null) {
    // Empty file: treat as a fresh write.
    return stringifyDocument(generated);
  }
  if (conflicts.length > 0 && !options.force) {
    throw new MergeConflictError(conflicts);
  }
  for (const { path, value } of additions) {
    doc.setIn(path, doc.createNode(value));
  }
  return doc.toString({ lineWidth: 0 });
}

export interface SpecDiff {
  /** Entries the file lacks (dot paths), e.g. "components.schemas.Patient". */
  missing: string[];
  /** Entries present in the file but differing from generation. */
  changed: string[];
  /** True when the file already contains exactly what generation produces. */
  inSync: boolean;
}

/**
 * Compares existing spec text against a generated document without writing
 * anything — the CI drift guard behind `fhir-oas check`. The file is in sync
 * when a merge would be a no-op: nothing to add, nothing conflicting.
 */
export function diffAgainstYaml(generated: OpenApiDocument, existingText: string): SpecDiff {
  const { doc, conflicts, additions } = computeMergePlan(generated, existingText, {});
  if (doc.contents === null) {
    return { missing: ["(entire document: file is empty)"], changed: [], inSync: false };
  }
  const missing = additions.map((a) => a.path.join("."));
  const changed = conflicts.map((c) => c.location);
  return { missing, changed, inSync: missing.length === 0 && changed.length === 0 };
}

/** Serializes a generated document to YAML text. */
export function stringifyDocument(generated: OpenApiDocument): string {
  const doc = new Document(generated);
  return doc.toString({ lineWidth: 0 });
}
