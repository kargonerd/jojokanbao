# ES migrations

The JOJO Pipe ES repair workbench writes one JSON migration per repair or
logical deletion. The file contains operator context such as `reason`; those
fields are deliberately not indexed in Elasticsearch.

Each migration is deterministic and replayable. Applying it uses only
`_create/<revision-id>`, so replaying an already-applied migration is safe.

Commit reviewed migration JSON files when the repair history should travel with
the repository. Reader Search derives its excluded document IDs from applied
migrations in this directory, scoped by the migration's `index`. A repair
excludes its `supersedesId`; a deletion also excludes its own tombstone ID.
Do not place credentials in this directory.
