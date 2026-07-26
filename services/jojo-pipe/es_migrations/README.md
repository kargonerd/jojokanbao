# ES migrations

The JOJO Pipe ES repair workbench writes one JSON migration per repair or
logical deletion. The file contains operator context such as `reason`; those
fields are deliberately not indexed in Elasticsearch.

Each migration is deterministic and replayable. Applying it uses only
`_create/<revision-id>`, so replaying an already-applied migration is safe.

Commit reviewed migration JSON files when the repair history should travel with
the repository. Do not place credentials in this directory.
