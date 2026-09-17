import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package's own version, read from its package.json.
 *
 * Resolved at runtime rather than inlined at build time so the CLI cannot
 * report a version that disagrees with the installed package.json. The file
 * sits at the package root, next to `src/` when running from source and next
 * to `dist/` when published, so walking up from this module finds it in both
 * layouts — the same approach `definitionsRoot()` uses for `definitions/`.
 */
export function packageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    }
    dir = path.dirname(dir);
  }
  // Better to report an honest unknown than to invent a number.
  return "unknown";
}
