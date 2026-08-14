# RSSHub media coverage monitor

This tool probes the protected JOJO RSSHub instance and records how many dated entries each
configured publisher route returns for today and yesterday in `Asia/Shanghai`.

It produces three files in `rsshub-coverage-report/`:

- `coverage.json`: complete machine-readable diagnostics;
- `coverage.csv`: one row per publisher;
- `summary.md`: the table shown in the GitHub Actions run summary.

Omitting RSSHub's `limit` query parameter does not mean unlimited output: routes such as AP fall
back to a 20-item default. The monitor therefore requests a deliberately large 500-item window.
When a route returns fewer than 500 items, the report has captured its current complete item pool;
when it returns exactly 500, the report marks it for a larger follow-up probe. This is still not
all articles ever published by a newsroom. Description length is measured only as a payload
diagnostic and is not evidence that the full article is present.

The catalog intentionally keeps currently failing routes such as Reuters and The Wall Street
Journal. Removing them would make the apparent publisher coverage rate look better while hiding
the sources JOJO actually wants to monitor.

## Run locally

Set the access key in the environment, then run from the repository root:

```powershell
$env:JOJOKANBAO_RSSHUB_ACCESS_KEY = "..."
python tools/rsshub-coverage/rsshub_coverage.py
```

Probe only selected publishers:

```powershell
python tools/rsshub-coverage/rsshub_coverage.py --publisher zaobao --publisher caixin
```

Run the dependency-free tests:

```bash
python -m unittest discover -s tools/rsshub-coverage/tests -v
```

## GitHub Actions secret

The workflow requires the repository secret `JOJOKANBAO_RSSHUB_ACCESS_KEY`. The key is appended
only to outbound requests and is never written to logs or report artifacts. Scheduled runs occur
at 08:30 and 22:30 China Standard Time; the workflow can also be dispatched manually.
