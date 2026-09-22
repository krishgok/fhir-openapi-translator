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
- [ ] **Read `supportedProfile` in `--capability`.** Per FHIR's own
      "Two uses of Profiles" (profiling.html#profile-uses), a
      `CapabilityStatement` names profiles two ways: `rest.resource.profile`
      (the resource-level superset of everything the system supports) and
      `rest.resource.supportedProfile` (per-use-case profiles a consumer is
      meant to find via `_profile` search or a `Meta.profile` assertion — e.g.
      one lab system declaring a different supportedProfile per report type).
      `capability.ts` reads neither; profile selection is entirely manual via
      `--ig`/`--profile`. A real server can declare many `supportedProfile`
      entries against one resource type (HL7's own example: "several hundred
      different reports"), which collides with the existing "Multiple profiles
      target X; generate one profiled resource per run" guard — so this isn't
      just a lookup, it's a design question: pick one, require the user to
      name one, or emit a `oneOf` of all declared shapes. Decide the shape
      before building it.

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

- **"No system-level id" — the actual FHIR distinction (my first guess was
  wrong).** Asked in reply why a profile has no stable identity to key a
  schema name on, Grahame pointed at FHIR's "Two uses of Profiles"
  (profiling.html#profile-uses). It is not "data constraint vs capability
  declaration," which is what got guessed here before reading it — it's two
  named elements of `CapabilityStatement.rest.resource`: `profile` (the
  resource-level superset of everything the system supports for that type)
  and `supportedProfile` (a narrower, per-use-case profile a consumer finds by
  `_profile` search or a `Meta.profile` assertion, not by requesting the
  resource type generically). US Core Blood Pressure is a `supportedProfile`
  in that sense. This doesn't change what's built — schema naming still keys
  off `StructureDefinition.name`/`url`, which is orthogonal to which
  CapabilityStatement element cites the profile — but it reframes the
  `supportedProfile` follow-up below: reading it isn't just "discover which
  profile to apply," it's specifically the mechanism FHIR defines for a
  consumer to filter one resource type into several shapes, which is why one
  resource type can legitimately have many of them declared at once.

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
