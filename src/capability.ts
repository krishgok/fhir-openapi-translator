import fs from "node:fs";
import type { FhirInteraction } from "./paths.js";

/**
 * Loads and parses a FHIR CapabilityStatement (a server's `/metadata`) into a
 * per-resource description of what the server actually supports, so a spec can
 * be generated to match exactly one server's surface rather than the full
 * standard interaction set.
 */

export interface ResourceCapability {
  type: string;
  interactions: Set<FhirInteraction>;
  /** Search parameter codes the server declares for this resource. */
  searchParamCodes: Set<string>;
  /** Operation codes and canonical URLs the server declares for this resource. */
  operations: Set<string>;
}

export interface Capability {
  /** FHIR version string from the statement, e.g. "4.0.1" (may be undefined). */
  fhirVersion?: string;
  resources: ResourceCapability[];
}

interface RawInteraction {
  code?: string;
}
interface RawSearchParam {
  name?: string;
}
interface RawOperation {
  name?: string;
  definition?: string;
}
interface RawResource {
  type?: string;
  interaction?: RawInteraction[];
  searchParam?: RawSearchParam[];
  operation?: RawOperation[];
}
interface RawCapabilityStatement {
  resourceType?: string;
  fhirVersion?: string;
  rest?: { mode?: string; resource?: RawResource[] }[];
}

const KNOWN_INTERACTIONS = new Set<string>([
  "read",
  "vread",
  "update",
  "patch",
  "delete",
  "history-instance",
  "history-type",
  "create",
  "search-type",
]);

export interface LoadCapabilityOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Loads a CapabilityStatement from a local JSON file or an http(s) URL. A URL
 * that does not already end in `/metadata` has it appended, so a base server
 * URL works directly.
 */
export async function loadCapabilityStatement(
  input: string,
  options: LoadCapabilityOptions = {},
): Promise<Capability> {
  let json: unknown;
  if (/^https?:\/\//i.test(input)) {
    const url = /\/metadata\/?$/.test(input) ? input : `${input.replace(/\/$/, "")}/metadata`;
    const doFetch = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url, { headers: { Accept: "application/fhir+json" } });
    } catch (cause) {
      throw new Error(
        `Failed to fetch CapabilityStatement from ${url}: ${(cause as Error).message}. ` +
          `Save it locally (curl -H 'Accept: application/fhir+json' ${url} > metadata.json) ` +
          `and pass the file instead.`,
      );
    }
    if (!response.ok) {
      throw new Error(`CapabilityStatement request to ${url} returned ${response.status}.`);
    }
    json = await response.json();
  } else {
    if (!fs.existsSync(input)) throw new Error(`No such CapabilityStatement file: ${input}`);
    json = JSON.parse(fs.readFileSync(input, "utf8"));
  }
  return parseCapabilityStatement(json);
}

export function parseCapabilityStatement(json: unknown): Capability {
  const statement = json as RawCapabilityStatement;
  if (statement?.resourceType !== "CapabilityStatement") {
    throw new Error(
      `Expected a CapabilityStatement resource, got "${statement?.resourceType ?? "unknown"}".`,
    );
  }

  // Merge resource entries across all `rest` blocks with mode "server".
  const byType = new Map<string, ResourceCapability>();
  for (const rest of statement.rest ?? []) {
    if (rest.mode && rest.mode !== "server") continue;
    for (const raw of rest.resource ?? []) {
      if (!raw.type) continue;
      let cap = byType.get(raw.type);
      if (!cap) {
        cap = {
          type: raw.type,
          interactions: new Set(),
          searchParamCodes: new Set(),
          operations: new Set(),
        };
        byType.set(raw.type, cap);
      }
      for (const i of raw.interaction ?? []) {
        if (i.code && KNOWN_INTERACTIONS.has(i.code)) cap.interactions.add(i.code as FhirInteraction);
      }
      for (const sp of raw.searchParam ?? []) {
        if (sp.name) cap.searchParamCodes.add(sp.name);
      }
      for (const op of raw.operation ?? []) {
        if (op.name) cap.operations.add(op.name);
        if (op.definition) cap.operations.add(op.definition);
      }
    }
  }

  if (byType.size === 0) {
    throw new Error(
      "CapabilityStatement declares no server resources (rest[].resource). Nothing to generate.",
    );
  }

  return {
    fhirVersion: statement.fhirVersion,
    resources: [...byType.values()].sort((a, b) => a.type.localeCompare(b.type)),
  };
}
