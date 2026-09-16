import { loadSearchParameters, loadStructureDefinitions } from "./definitions.js";
import type { SearchParameter } from "./definitions.js";
import type { FhirVersion, SearchParamPreset, SearchParamSelection } from "./types.js";

/**
 * Search-value prefixes FHIR defines for ordered types (number, date,
 * quantity). They are part of the value, not the parameter name — `date=ge2021`
 * — so they cannot be modelled as separate parameters, but consumers need to
 * know the parameter accepts them.
 *
 * https://hl7.org/fhir/search.html#prefix
 */
export const SEARCH_PREFIXES = ["eq", "ne", "gt", "lt", "ge", "le", "sa", "eb", "ap"] as const;

/** Search parameter types whose values may carry a prefix. */
const PREFIXABLE_TYPES = new Set(["number", "date", "quantity"]);

export function prefixesFor(searchParamType: string): readonly string[] | undefined {
  return PREFIXABLE_TYPES.has(searchParamType) ? SEARCH_PREFIXES : undefined;
}

/**
 * Required-binding codes by element path. Search parameters name their element
 * in `expression`, so a token parameter over a bound `code` element can be
 * described with the codes the version actually defines — which differ between
 * versions (Encounter.status gains `on-hold`/`completed` in R5) and which HL7's
 * own SearchParameter.description text reports only sporadically.
 */
function requiredBindingCodes(fhirVersion: FhirVersion): Map<string, string[]> {
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

const bindingCache = new Map<FhirVersion, Map<string, string[]>>();

/**
 * Codes a token search parameter accepts for one resource, or undefined when
 * they can't be determined.
 *
 * Parameters shared across resources carry a union expression
 * ("Patient.gender | Person.gender | Practitioner.gender | ..."), and each
 * branch may bind a different ValueSet — MedicationRequest.status and
 * MedicationDispense.status share a parameter but not a code list. The branch
 * matching the resource being generated is the one that applies, so it is
 * selected rather than the parameter being skipped.
 *
 * FHIRPath using `where(...)`, `as(...)`, `.resolve()` or similar is left
 * alone: it does not name a single element, and guessing would misreport.
 */
export function searchParamCodes(
  fhirVersion: FhirVersion,
  resource: string,
  type: string,
  expression: string | undefined,
): string[] | undefined {
  if (type !== "token" || !expression) return undefined;

  const branch = expression
    .split("|")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${resource}.`) || !expression.includes("|"));
  if (!branch || !/^[A-Za-z]+(?:\.[A-Za-z]+)+$/.test(branch)) return undefined;
  if (branch.split(".")[0] !== resource) return undefined;

  let index = bindingCache.get(fhirVersion);
  if (!index) {
    index = requiredBindingCodes(fhirVersion);
    bindingCache.set(fhirVersion, index);
  }
  return index.get(branch);
}

/**
 * Codes a majority of servers index regardless of resource type. This is the
 * first and strongest signal for the `minimal` preset, but it cannot be the
 * only one: a handful of resources name none of these (Linkage's parameters
 * are `author`/`item`/`source`), and a preset that silently selected nothing
 * for them would be indistinguishable from `none`.
 */
const COMMON_CODES = new Set([
  "identifier",
  "status",
  "patient",
  "subject",
  "encounter",
  "code",
  "category",
  "date",
  "type",
  "url",
  "name",
]);

/**
 * The branch of a search parameter's expression addressing this resource
 * directly, i.e. a top-level element (`Linkage.author`) rather than something
 * nested, chained or filtered (`Observation.component.value`,
 * `Bundle.entry.request.where(...)`). Direct parameters address the resource
 * itself and are the cheapest to index, which makes them the right fallback
 * when none of the common codes apply.
 */
function directElementBranch(resource: string, expression: string | undefined): string | undefined {
  if (!expression) return undefined;
  const branch = expression
    .split("|")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${resource}.`));
  return branch && /^[A-Za-z]+\.[A-Za-z]+$/.test(branch) ? branch : undefined;
}

/**
 * The `minimal` selection for one resource, in three tiers so that every
 * resource defining any search parameter keeps at least one:
 *
 *   1. the common codes above, where the resource defines any;
 *   2. otherwise, parameters addressing a top-level element directly;
 *   3. otherwise, everything the resource defines.
 *
 * A resource that defines no search parameters at all (Binary,
 * OperationOutcome) yields nothing, because there is nothing to select.
 */
function minimalCodes(resource: string, available: readonly SearchParameter[]): Set<string> {
  const common = available.filter((sp) => COMMON_CODES.has(sp.code));
  if (common.length > 0) return new Set(common.map((sp) => sp.code));

  const direct = available.filter((sp) => directElementBranch(resource, sp.expression));
  if (direct.length > 0) return new Set(direct.map((sp) => sp.code));

  return new Set(available.map((sp) => sp.code));
}

function parseOne(value: string): SearchParamPreset | ReadonlySet<string> {
  const lower = value.toLowerCase();
  if (lower === "all" || lower === "minimal" || lower === "none") return lower;
  const codes = value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (codes.length === 0) {
    throw new Error(`--search-params: empty selection in "${value}"`);
  }
  return new Set(codes);
}

/**
 * Parses `--search-params` arguments. Each is either a bare selection applying
 * to every resource (`none`, `minimal`, `code,date,subject`) or a
 * resource-scoped one (`Patient:name,birthdate`).
 */
export function parseSearchParamSpec(specs: readonly string[]): SearchParamSelection {
  const selection: SearchParamSelection = {};
  const byResource = new Map<string, SearchParamPreset | ReadonlySet<string>>();
  for (const spec of specs) {
    // A colon separates resource from codes. Codes never contain one, and a
    // resource name is always a leading capital, so the split is unambiguous.
    const colon = spec.indexOf(":");
    if (colon > 0 && /^[A-Z][A-Za-z]*$/.test(spec.slice(0, colon))) {
      const resource = spec.slice(0, colon);
      if (byResource.has(resource)) {
        throw new Error(`--search-params: ${resource} given more than once`);
      }
      byResource.set(resource, parseOne(spec.slice(colon + 1)));
      continue;
    }
    if (selection.default !== undefined) {
      throw new Error(
        `--search-params: more than one unscoped selection ("${spec}"). ` +
          "Scope them per resource (Patient:name,birthdate) or pass a single list.",
      );
    }
    selection.default = parseOne(spec);
  }
  if (byResource.size > 0) selection.byResource = byResource;
  return selection;
}

/**
 * Resolves a selection to the set of codes to emit for one resource, or
 * undefined to emit all of them. Unknown codes are an error: silently dropping
 * a typo'd parameter would quietly shrink the contract.
 */
export function resolveSearchParamCodes(
  selection: SearchParamSelection | undefined,
  fhirVersion: FhirVersion,
  resource: string,
): ReadonlySet<string> | undefined {
  const chosen = selection?.byResource?.get(resource) ?? selection?.default;
  if (chosen === undefined || chosen === "all") return undefined;

  const available = loadSearchParameters(fhirVersion).filter((sp) => sp.base.includes(resource));

  if (chosen === "none") return new Set();
  if (chosen === "minimal") return minimalCodes(resource, available);

  const codes = new Set(available.map((sp) => sp.code));
  const unknown = [...chosen].filter((code) => !codes.has(code));
  if (unknown.length > 0) {
    throw new Error(
      `--search-params: ${resource} has no search parameter ` +
        `${unknown.map((c) => `"${c}"`).join(", ")} in ${fhirVersion.toUpperCase()}. ` +
        `Run "fhir-oas generate ${resource} -f ${fhirVersion}" to see the available codes.`,
    );
  }
  return new Set(chosen);
}
