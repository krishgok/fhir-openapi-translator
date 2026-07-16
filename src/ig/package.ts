import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildValueSetResolver,
  minimizeStructureDefinition,
  type RawStructureDefinition,
  type ValueSetResolver,
} from "./minimize.js";
import type { MinStructureDefinition } from "../definitions.js";
import { FHIR_VERSIONS, type FhirVersion } from "../types.js";

/** Maps an IG package's FHIR version string to our supported version keys. */
const FHIR_VERSION_BY_NUMBER: Record<string, FhirVersion> = {
  "4.0.1": "r4",
  "4.0.0": "r4",
  "4.3.0": "r4b",
  "5.0.0": "r5",
};

export interface IgProfile {
  /** Versionless canonical URL. */
  url: string;
  id?: string;
  name: string;
  type: string;
  definition: MinStructureDefinition;
}

export interface IgContext {
  name: string;
  version: string;
  fhirVersion: FhirVersion;
  profiles: IgProfile[];
  /** Names/URLs of constraint profiles that lack a snapshot (cannot be applied). */
  profilesMissingSnapshot: string[];
  resolveValueSet: ValueSetResolver;
}

export interface LoadIgOptions {
  /** Resolve core bindings (e.g. administrative-gender) not defined in the IG. */
  coreValueSetFallback?: ValueSetResolver;
  /** Base directory for the registry download cache. Defaults to ~/.fhir-oas. */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

interface RawResource {
  resourceType?: string;
  url?: string;
  name?: string;
  id?: string;
  type?: string;
  kind?: string;
  derivation?: string;
  snapshot?: unknown;
  [key: string]: unknown;
}

const REGISTRY_BASE = "https://packages.fhir.org";

/**
 * Resolves the `--ig` input to an IgContext. Accepts a path to a package
 * tarball (`.tgz`), a path to an unpacked package directory, or a registry
 * coordinate (`name` or `name@version`) fetched from packages.fhir.org and
 * cached locally. Async because registry coordinates hit the network.
 */
export async function loadIg(input: string, options: LoadIgOptions = {}): Promise<IgContext> {
  if (isRegistryCoordinate(input)) {
    const tarball = await fetchFromRegistry(input, options);
    return buildContext(readFromTarball(tarball), options.coreValueSetFallback);
  }
  return loadIgSync(input, options);
}

/**
 * Synchronous IG loader for local inputs (a `.tgz` or an unpacked directory).
 * Registry coordinates require the async {@link loadIg} because they fetch
 * over the network.
 */
export function loadIgSync(input: string, options: LoadIgOptions = {}): IgContext {
  if (isRegistryCoordinate(input)) {
    throw new Error(
      `"${input}" looks like a registry package coordinate, which requires a network ` +
        `fetch. Use loadIg() (async) or the CLI, or download the package and pass a local path.`,
    );
  }
  const stat = fs.existsSync(input) ? fs.statSync(input) : undefined;
  if (!stat) {
    throw new Error(
      `--ig "${input}" is not a file or directory. Pass a package .tgz, an unpacked ` +
        `package directory, or a registry coordinate like hl7.fhir.us.core@5.0.1.`,
    );
  }
  const files = stat.isDirectory() ? readFromDirectory(input) : readFromTarball(input);
  return buildContext(files, options.coreValueSetFallback);
}

/** package.json plus every FHIR JSON resource, keyed by base filename. */
interface PackageFiles {
  packageJson: { name?: string; version?: string; "fhir-version-list"?: string[]; fhirVersions?: string[] };
  resources: RawResource[];
}

function isRegistryCoordinate(input: string): boolean {
  // A registry coordinate is a package id (optionally @version); it never
  // looks like a path and does not exist on disk.
  if (fs.existsSync(input)) return false;
  if (input.includes("/") || input.includes("\\") || input.endsWith(".tgz")) return false;
  return /^[a-z0-9][a-z0-9.\-]*(@[\w.\-]+)?$/i.test(input);
}

function packageDir(root: string): string {
  const nested = path.join(root, "package");
  if (fs.existsSync(path.join(nested, "package.json"))) return nested;
  if (fs.existsSync(path.join(root, "package.json"))) return root;
  throw new Error(`No package.json found under "${root}" (looked in ./ and ./package)`);
}

function readFromDirectory(dir: string): PackageFiles {
  const base = packageDir(dir);
  const packageJson = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
  const resources: RawResource[] = [];
  for (const file of fs.readdirSync(base).sort()) {
    if (!file.endsWith(".json") || file === "package.json" || file === ".index.json") continue;
    try {
      resources.push(JSON.parse(fs.readFileSync(path.join(base, file), "utf8")));
    } catch {
      // Skip non-resource JSON (e.g. index files that aren't FHIR resources).
    }
  }
  return { packageJson, resources };
}

/**
 * Extracts a package tarball to an isolated temp directory (tar refuses
 * absolute/`..` members, and the destination is a private mkdtemp), reads the
 * JSON resources, then removes the directory.
 */
function readFromTarball(tarballPath: string): PackageFiles {
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Package tarball not found: ${tarballPath}`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fhir-oas-ig-"));
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", tmp], { stdio: "pipe" });
    return readFromDirectory(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchFromRegistry(coordinate: string, options: LoadIgOptions): Promise<string> {
  const [name, version] = coordinate.split("@");
  const cacheDir = path.join(options.cacheDir ?? path.join(os.homedir(), ".fhir-oas"), "packages");
  const resolvedVersion = version ?? "latest";
  const cachePath = path.join(cacheDir, `${name}#${resolvedVersion}.tgz`);
  if (fs.existsSync(cachePath)) return cachePath;

  const url = `${REGISTRY_BASE}/${name}/${resolvedVersion}`;
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url);
  } catch (cause) {
    throw new Error(
      `Failed to reach the FHIR package registry at ${url}: ${(cause as Error).message}. ` +
        `If you are offline or behind a restrictive proxy, download the package and pass ` +
        `--ig ./${name}.tgz instead.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `FHIR package registry returned ${response.status} for ${url}. ` +
        `Check the package name and version, or download it and pass --ig ./${name}.tgz.`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, buffer);
  return cachePath;
}

function detectFhirVersion(packageJson: PackageFiles["packageJson"]): FhirVersion {
  const versions = packageJson["fhir-version-list"] ?? packageJson.fhirVersions ?? [];
  for (const v of versions) {
    const mapped = FHIR_VERSION_BY_NUMBER[v];
    if (mapped) return mapped;
  }
  throw new Error(
    `Could not determine a supported FHIR version for IG package "${packageJson.name}" ` +
      `(found: ${versions.join(", ") || "none"}). Supported: ${FHIR_VERSIONS.join(", ")}.`,
  );
}

function buildContext(files: PackageFiles, coreFallback?: ValueSetResolver): IgContext {
  const fhirVersion = detectFhirVersion(files.packageJson);
  const terminology = files.resources.filter(
    (r) => r.resourceType === "ValueSet" || r.resourceType === "CodeSystem",
  );
  const resolveValueSet = buildValueSetResolver(terminology as never[], coreFallback);

  const profiles: IgProfile[] = [];
  const profilesMissingSnapshot: string[] = [];
  for (const r of files.resources) {
    if (
      r.resourceType === "StructureDefinition" &&
      r.derivation === "constraint" &&
      r.kind === "resource"
    ) {
      if (!r.snapshot) {
        profilesMissingSnapshot.push(r.name ?? r.url ?? "unknown");
        continue;
      }
      const sd = r as unknown as RawStructureDefinition;
      profiles.push({
        url: sd.url.split("|")[0]!,
        id: sd.id,
        name: sd.name,
        type: sd.type,
        definition: minimizeStructureDefinition(sd, resolveValueSet),
      });
    }
  }
  profiles.sort((a, b) => a.url.localeCompare(b.url));

  return {
    name: files.packageJson.name ?? "unknown",
    version: files.packageJson.version ?? "unknown",
    fhirVersion,
    profiles,
    profilesMissingSnapshot,
    resolveValueSet,
  };
}
