# Source modules

Every publisher owns a directory. Its `source.json` keeps the selected sections, native discovery
endpoints, content policy, and archive policy together:

```text
{source}/
└─ source.json
```

Only real publisher-specific code is added alongside that file. A custom source module has four
small files:

```text
{source}/
├─ source.json  # sections, discovery endpoints, content/archive policy
├─ discover.ts  # publisher API/listing -> normalized candidates
├─ page.ts      # page capture mode and source-specific body selectors
├─ process.ts   # source normalization before Canonical is written
└─ index.ts     # module wiring
```

HTTP recording, RSS/XML parsing, sitemap parsing, browser/WACZ capture, quality gates, Raw writing,
and Canonical writing remain shared. A publisher that works with those shared adapters keeps only
`source.json`; it does not get empty TypeScript wrappers. Add a source module only when the publisher
needs real custom behavior.

`discover.ts` must use the publisher's own endpoint and must not publish Canonical data. `page.ts` is
serialized into the Raw source manifest and consumed by the browser body extractor. `process.ts` runs
after capture and immediately before Canonical generation.
