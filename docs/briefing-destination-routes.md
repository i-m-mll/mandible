# Briefing destination route manifests

Mandible owns recurring Briefing destination identity. An installed scheduler
declares stable destination routes through the authenticated operator API. A
route names a logical Artifact and section, never a layout. Mandible derives
the active group from the Artifact's single destination-owner record.

The manifest is JSON:

```json
{
  "schema": "mandible-briefing-destination-routes@3",
  "routes": [
    {
      "route_key": "projects.example.maintenance",
      "logical_artifact_ref": "artifact:01ABCDEFGH",
      "publication_mode": "reviewed-document",
      "heading": "Maintenance",
      "composer_kind": "deterministic",
      "template": {
        "version": 1,
        "contribution_template": "- {{summary}} ([evidence]({{evidence_ref}}))",
        "slots": {
          "summary": { "type": "string", "required": true, "max_length": 400 }
        }
      },
      "limits": {
        "max_contributions": 25,
        "max_document_bytes": 100000,
        "max_directives": 0
      }
    }
  ]
}
```

`logical_artifact_ref` must resolve to one logical `artifact:` identity; a
version, blob, title, or external path is not accepted. That Artifact must have
one active destination owner, and the owner's Base must contain exactly one
active Briefing for it. Archived groups never satisfy key or destination
resolution.

`publication_mode` is destination policy, not publisher input. A
`reviewed-document` route preserves the Base-relative proposal and configured-human
accept/reject lifecycle. A `published-report` route reuses the one placed logical
Briefing and atomically appends each successful publication as its new Current
round. Report publication changes neither group Base nor membership and does not
mean that a human endorsed the report. Quiet runs record health without a round.

## Bootstrap order

1. Start the upgraded Mandible daemon so the existing destination-route schema
   is present.
2. Provision the configured operator's durable API token.
3. Register the destination Artifact, publish its exact initial version as a
   Briefing, create the Base bundle, and create the Briefing group with an
   immutable key and that bundle as Base.
4. Bind the previously unowned Artifact to that group, then put only the
   Artifact ref and route declaration in the installed manifest:

   ```bash
   mandible briefing group destination bind <group-key> <artifact-ref> --json
   ```

5. Check the manifest without mutation:

   ```bash
   mandible briefing route plan routes.json --json
   ```

6. Apply the same manifest atomically, then inspect the stored result:

   ```bash
   mandible briefing route apply routes.json --json
   mandible briefing route inspect --json
   ```

7. Only after route installation succeeds, enable the scheduler. Runtime
   publication remains `POST /api/briefings/runs`; there is no alternate or
   fallback publication path.

Plan and apply require the configured operator's durable token. Plan performs
the same ref, Base-document, ownership, composer, and template checks as apply
but makes no database changes. Output is ordered by `route_key`, so an installed
manifest has deterministic review output.

## Replay and upgrades

Reapplying an exact manifest reports every route as `unchanged`. A new route is
`create`. Raising `template.version`, or changing route limits while preserving
identity, is `update`. Install an upgrade in this order:

1. deploy the new manifest alongside the upgraded Mandible code;
2. run `route plan` and review the exact canonical group and Artifact IDs;
3. run `route apply`;
4. only then deploy or enable scheduler behavior that depends on the new
   template version.

A route key can never move to another logical Artifact, heading, or composer
kind. The Artifact's destination group may move only inside the same guarded
configured-human review transaction that accepts the new Base and full layout;
the binding digest includes the expected owner and the receipt preserves the
move. A template version can never be changed in place, and the active version
cannot move backwards. Any conflict fails the transaction without partial work.

## Manually staged proposals

A proposal staged with `briefing bundle create` and `briefing group add` can use
configured-human review when every proposed document has verified
Mandible-ingested custody. It does not need a recurring composer run. Composer
provenance, when present, must match the exact group, Base, and proposal.
Repository-backed or mixed-lineage documents still require protected-merge
promotion; this workflow does not authorize repository changes.

The configured operator first submits a frozen review of each added or changed
Briefing round. For a report without directives, add a review annotation and
submit it. Then preview the exact proposal and any explicit destination
ownership changes using the operator's durable API credential:

```bash
changes='[{"logical_artifact_ref":"artifact:<report>","expected_group_ref":null}]'
mandible briefing group review <group> --expected-base <base> --proposal <proposal> \
  --destination-changes "$changes" --json
```

Use `null` for an unowned destination, or the exact current owner group reference
for a move. Review the returned layouts, document versions, submissions,
destination changes, and `binding_digest`. The operator then passes that digest
and the same changes to either disposition command:

```bash
mandible briefing group accept <group> --expected-base <base> --proposal <proposal> \
  --binding-digest <reviewed-digest> --destination-changes "$changes" --json
# Use `reject` with the same arguments to retain Base and destination ownership.
```

Acceptance changes Base and ownership atomically. Rejection preserves both.
Changes to Base, proposal, submissions, or expected ownership require a new
review. Exact retries return the original receipt without reapplying the change;
a retry with different destination changes fails. The immutable receipt records
manual provenance as a null composition run and retains all custody anchors.
Route installation remains a separate operator action after acceptance.
