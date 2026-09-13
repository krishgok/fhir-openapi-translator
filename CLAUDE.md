# fhir-openapi-translator — working notes

Generates OpenAPI specs from vendored HL7 FHIR definitions, for model/client
codegen in any language. TypeScript CLI (`fhir-oas`) + library.

## Conventions

- Two definition backends: `schema-json` (default, the reference) and
  `structure-def`. Cosmetic divergence between them is expected and pinned by
  tests; behavioural divergence is a bug.
- `definitions/` is vendored and gzipped. Refresh with
  `node scripts/update-definitions.mjs`, never by hand.
- Tests use the definitions as an **oracle** rather than hand-written
  expectations (`test/fidelity.test.ts`), and assert every published README
  claim across the full matrix it claims (`test/claims.test.ts`). Three
  shipped bugs all came from asserting one point of a multi-point matrix —
  when adding a claim, add it to `claims.test.ts` across every version,
  OpenAPI target and backend it covers.
- New assertions should be mutation-tested: break the behaviour on purpose and
  confirm the test fails. Several "passing" tests previously did not bite.
- Release gate is `prepublishOnly`: typecheck → lint → build → test, in that
  order (tests exec `dist/`, so build must precede them).

## Open follow-ups

Pick these up when a change is next planned; none is urgent, and none blocks
a release.

- [ ] **`fhir-oas --version` is unsupported** — exits with
      `error: unknown option '--version'`. Standard CLI affordance; smallest
      real papercut on the list. Good candidate for 0.1.2.
- [ ] **`./package.json` is not in the `exports` map** — so
      `require("fhir-openapi-translator/package.json")` throws
      `ERR_PACKAGE_PATH_NOT_EXPORTED`. A legitimate choice, but some bundlers
      and version-introspection scripts reach for it. Add the subpath export
      if anyone hits it.
- [ ] **GitHub release for `v0.1.1`** — the tag is pushed and points at
      `main`, but no release exists. Draft notes were prepared; regenerate
      from `CHANGELOG.md` if lost. The GitHub MCP server exposes no
      create/update release tool, so this must be done in the web UI.
- [ ] **Repo Website field is empty** — should point at
      https://www.npmjs.com/package/fhir-openapi-translator
- [ ] **npm downloads badge** renders blank. Expected to self-resolve once the
      package has download history; revisit if still blank well after 0.1.1.
- [ ] **Community launch, both drafted and unsent**: a chat.fhir.org (Zulip)
      announcement, and a `fhir-fuel/awesome-FHIR` PR adding an entry under
      its empty `JSON Schema` section. The awesome-FHIR PR must come from the
      maintainer's own account — agent sessions here are scoped to
      `krishgok/fhir-openapi-translator` only.

### Not an issue (checked, do not re-open)

- The `v0.1.0` release notes were suspected of carrying an unterminated
  ` ```sh ` fence. They do not — both markers are present and the block
  closes correctly. Only cosmetic nit is a missing blank line after the
  closing fence, which GFM renders fine.
