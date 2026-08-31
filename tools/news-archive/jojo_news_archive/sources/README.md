# Source modules

Every publisher is a vertical module under `sources/<publisher>/`. A source
owns all decisions that differ by publisher; the shared archive packages own
only transport, persistence, parsing primitives, and orchestration mechanics.

```text
sources/<publisher>/
  spec.py          identity, URL rules, versions, scheduler configuration
  discovery.py     provider queries and source-specific catalog policy
  capture.py       candidate order, fallback and completeness policy
  parser.py        body, metadata, image and quality extraction policy
  validation.py    independent QA and sampling hooks
```

Large discovery implementations may use a `discovery/` package instead of one
file. A source should not add an empty module merely to match this example.

The registry is the only place that enumerates concrete source packages.
Shared engines resolve the current module through generic registries and hook
contracts. They must not compare `publisher` with a concrete source ID,
import a concrete source statically or dynamically, embed a publisher domain,
or carry source-named functions and configuration tables.

To add a source:

1. Create the source directory and its real implementations.
2. Export one `SourceModule` from `spec.py` and register it once.
3. Add focused source tests and independent validation fixtures.
4. Run the package-layout test; it prevents source policy from leaking back
   into the shared engines.
