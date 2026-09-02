# Briefing destination route manifests

Mandible owns recurring Briefing destination identity. An installed scheduler
declares stable destination routes through the authenticated operator API; it
does not create route rows, choose a group by title, or reuse a scheduler-owned
group identifier.

The manifest is JSON:

```json
{
  "schema": "mandible-briefing-destination-routes@1",
  "routes": [
    {
      "route_key": "projects.example.maintenance",
      "group_ref": "briefing-group:01ABCDEF",
      "logical_artifact_ref": "artifact:01ABCDEFGH",
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

`group_ref` must resolve through Mandible's Briefing group identity. The group
must be active and have a Base bundle containing exactly one active Briefing for
the logical Artifact named by `logical_artifact_ref`. That Artifact ref must
resolve as a logical `artifact:` identity; a version, blob, title, or external
path is not accepted.

## Bootstrap order

1. Start the upgraded Mandible daemon so the existing destination-route schema
   is present.
2. Provision the configured operator's durable API token.
3. Register the destination Artifact, publish its exact initial version as a
   Briefing, create the Base bundle, and create the Briefing group with that
   bundle as Base. Retain the canonical refs returned by those commands.
4. Put those refs in the installed route manifest. Check it without mutation:

   ```bash
   mandible briefing route plan routes.json --json
   ```

5. Apply the same manifest atomically, then inspect the stored result:

   ```bash
   mandible briefing route apply routes.json --json
   mandible briefing route inspect --json
   ```

6. Only after route installation succeeds, enable the scheduler. Runtime
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

A route key can never move to another group, logical Artifact, heading, or
composer kind. A template version can never be changed in place, and the active
version cannot move backwards. Any of those conditions fails the entire
manifest transaction without partially installing other routes.
