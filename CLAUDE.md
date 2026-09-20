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

- [x] **chat.fhir.org announcement** — posted 2026-09-20 to `#implementers`:
      https://chat.fhir.org/#narrow/channel/179166-implementers/topic/fhir-openapi-translator.3A.20OpenAPI.20specs.20from.20FHIR.20definitions
      The post asks three questions: prior art, whether search parameter codes
      belong in `x-fhir-search-values` metadata or a schema `enum`, and whether
      the profile mapping matches expectations given the `fixed[x]` gap. Replies
      may turn into work; check the thread before planning the next change.
- [ ] **`fhir-fuel/awesome-FHIR` PR** adding an entry under its empty
      `JSON Schema` section. Must come from the maintainer's own account (see
      Environment notes). Worth holding until the Zulip thread has settled, in
      case it surfaces prior art.
- [ ] **`fixed[x]` inside shared types — an `allOf` intersection may solve it.**
      The gap is documented in REFERENCE and raised in the Zulip post, and the
      obvious counter-suggestion is to narrow a `$ref` by intersecting it:
      `allOf: [{$ref: CodeableConcept}, {properties: {coding: ...}}]`. That is
      valid JSON Schema and so valid OpenAPI 3.1. It is untried here; the open
      question is how well `openapi-generator` targets handle `allOf` — several
      flatten it into a fresh inline model, which would undo the shared-type
      saving (CodeableConcept is referenced 25 times in a single Observation
      spec). Test against the CI codegen targets before committing to it.

### Environment notes

- The GitHub MCP server here exposes only **read** tools for releases
  (`get_release_by_tag`, `list_releases`) — no create or update. Release notes
  must be drafted here and pasted in the web UI.
- Agent sessions are scoped to `krishgok/fhir-openapi-translator`. Anything
  touching another repo has to come from the maintainer's own account.

### Not an issue (checked, do not re-open)

- The `v0.1.0` release notes were suspected of carrying an unterminated
  ` ```sh ` fence. They do not — both markers are present and the block
  closes correctly. Only cosmetic nit is a missing blank line after the
  closing fence, which GFM renders fine.
