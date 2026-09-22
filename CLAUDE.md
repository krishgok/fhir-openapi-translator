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
- [ ] **Read `supportedProfile` in `--capability`.** `CapabilityStatement`
      `rest.resource.supportedProfile` names the profiles a server claims to
      support; `capability.ts` does not look at it at all today, so profile
      selection is entirely manual via `--ig`/`--profile`. Wiring it up would
      let one `--capability` call pick the right profiles for a server instead
      of the user guessing. Raised indirectly on chat.fhir.org.

### Answered on chat.fhir.org (do not re-open)

- **`allOf` will not rescue `fixed[x]`/`pattern[x]` on shared types.** The idea
  was to narrow a `$ref` by intersecting it. Lloyd McKenzie pointed out why it
  fails: a fixed code has to match **both** `code` and `system`, and
  `CodeableConcept.coding` is an array that may carry translations, so the
  constraint is "some coding matches on both fields" — `contains`, not
  `properties`. `contains` needs JSON Schema draft-6+, so OpenAPI 3.0.3 (a
  draft-4 subset) cannot express it at all, and code generators ignore it
  because it yields no type information. Not worth building.

- **What a profile actually carries is mostly not schema.** Grahame Grieve's
  point, and the census for US Core Blood Pressure bears it out: of 94
  elements, 31 `mustSupport`, 84 `constraint`, 44 slice members, 16 extensible
  bindings, 6 `fixed[x]`, 3 `pattern[x]` — against only 3 required bindings.
  What this tool represents is 23 cardinality constraints, 3 required-binding
  enums and 3 choice narrowings. That ratio is the honest description of
  "profile support" and should be stated wherever the feature is described.

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
