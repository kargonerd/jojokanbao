# JOJO news archive pipeline

> **Legacy migration reference.** This document describes the temporary
> runner's B2-backed Raw and validation layout. It is retained so those bytes
> and checkpoints can be migrated and verified. The active target contract is
> HF Raw → HF Canonical → B2 Delivery; see [README.md](README.md).

## Design

Raw acquisition and article interpretation are separate:

```text
publisher catalog
  -> Wayback CDX candidates
  -> publication-near Common Crawl WARC fallback where configured
  -> validated partner HTML or explicit Infini-News derived fallback
  -> jojo-raw-capture/1 + content-addressed HTML
  -> versioned publisher parser
  -> jojo-article/1
  -> selected editorial image downloads (later stage)
```

The raw stage normally stores response bytes before Beautiful Soup or any other
parser changes them. The explicit exceptions are validated FT and WSJ
`infini-news` candidates: they store deterministic HTML adapted from a complete
extracted CC-News row. Those records are marked `representation: derived-html`,
retain the dataset-row URL, official or partner source URL, WARC filename, and
content hash in provenance, and can be excluded from raw-DOM studies. Ordinary
responses remain `raw-html`. Image URLs are recorded only by the parser. Images
are not downloaded by `capture_archive_batch.py`; derived Infini rows contain
no images unless a separate validated page supplies them.

Parser readiness is measured on a reproducible, publisher-and-year-stratified
random sample. The archive workflow uses a stable SHA-256 pseudo-random
priority, captures years in round-robin order, and evaluates at least 800
articles for every configured year. The stable priority prevents resumptions
from changing the selected sample while keeping selection independent of URL
order. Already stored raw captures are sampled and replayed first; uncaptured
URLs fill only the remaining shortfall. Validation stores metrics and issue
codes, never article body text. A publisher/year is not ready until it has 800
evaluated samples, no parser exceptions, at least a 95% complete-extraction
rate, and a 100% QA-pass rate.

## B2 layout

For a publisher and discovery window, the workflow writes:

```text
news-archive/v1/{publisher}/{fromYear}-{toYear}/{manifestMode}/
  catalog/
    discovery.sqlite3.gz
    manifest.jsonl.gz
  raw/
    objects/html/{sha256[0:2]}/{sha256}.html.gz
    records/{articleSha256[0:2]}/{articleSha256}.json
  state/
    capture.sqlite3.gz
    summary.json
```

The capture checkpoint also contains the deterministic sample plan and parser
validation results. `state/summary.json` exposes progress and readiness by
year under `parserValidation`.

When a full publisher shard is progressing too slowly to exercise every year,
the `Parser validation accelerator` workflow filters that shard's existing
manifest to one year and uses an independent checkpoint. It never creates a
second raw corpus: canonical raw objects and records remain in the publisher
shard above.

```text
news-archive/v2/validation-state/{cohort}/{publisher}/{year}/
  catalog/manifest.jsonl.gz
  state/capture.sqlite3.gz
  state/summary.json
```

The filtered manifest is cached in B2 after its first use. Sampling uses the
same publisher, year, seed, parser version, 800-article target, and QA gates as
the full shard, so the result is directly comparable. The independent prefix
allows multiple years to run concurrently without two Actions jobs writing the
same SQLite checkpoint. It is an accelerator, not a second archive or a
replacement for the full archive shard.

## Validation checkpoints

The first formal NYT cell, `holdout-v248/nyt/2020`, reached the 800-article
target with parser `nyt-parser/0.8.120`; its rotation and content audits passed
and its raw/record delta was published below the canonical 2016–2026 shard.

The follow-up 2021 checkpoint `holdout-v249` was intentionally kept as a
historical failed attempt: parser `.120` reached its sample target, but its
content audit found one archived interactive containing literal Unicode
replacement markers. It is not counted as convergence.

After the parser fix, `holdout-v250/nyt/2021` was rebuilt from a disjoint
cohort with parser `nyt-parser/0.8.121`. It evaluated 801 article results (plus
11 explicitly screened non-article-desk entries); the formal 800-article
content audit passed with zero hard anomalies, zero replacement characters,
zero parser errors, and a passed zero-overlap rotation audit against v249.
The audit selected 1,717 editorial images; image bytes remain external URLs
until the separate image-download stage. The local v250 checkpoint contains
1,448 content-addressed objects and 1,390 records (392,604,791 logical HTML
bytes, 84,927,428 compressed bytes); only its hash delta was uploaded to the
canonical raw shard. The complete validation checkpoint is stored at
`news-archive/v2/validation-state/holdout-v250/nyt/2021/`.

The parser change preserves each raw HTML object as evidence while normalizing
unrecoverable literal U+FFFD runs from a small set of archived NYT interactives
to a readable gap in normalized text. The full olds-api suite passes (`1,246`
tests, one existing warning).

The Axios 2019 checkpoint, `holdout-v251/axios/2019`, was rebuilt from the
disjoint v209 cohort with parser `axios-parser/0.1.29`. It evaluated 831
results (830 QA-passing articles plus one screened desk entry); the formal
800-article content audit had 800/800 complete extractions, zero hard
anomalies, and 1,004 selected editorial images. The rotation audit found no
overlap with v209 and no missing exclusions. Its checkpoint is stored at
`news-archive/v2/validation-state/holdout-v251/axios/2019/`; only the raw hash
delta was added to the canonical Axios shard.

The first Axios 2020 retry, `holdout-v252`, reached its 800-article target
with parser `.1.29` but its content audit found one standalone weekly Axios
Navigate newsletter CTA leaking into the body. The parser now removes that
CTA family as interface chrome (`axios-parser/0.1.30`), with a regression test;
the full suite remains green (`1,247` tests). A disjoint rebuild,
`holdout-v253/axios/2020`, evaluated 804 results (802 QA-passing articles plus
two screened desk entries), passed the zero-overlap rotation audit, and passed
the formal 800-article content audit with zero hard anomalies and 949 selected
editorial images. Its checkpoint is stored at
`news-archive/v2/validation-state/holdout-v253/axios/2020/`.

The Axios 2021 checkpoint, `holdout-v254/axios/2021`, used the current
`axios-parser/0.1.30` and a cohort disjoint from v209. It evaluated 802
results, all QA-passing, and its formal 800-article content audit had complete
extractions, zero hard anomalies, and 909 selected editorial images. The
rotation audit reported zero overlap and zero missing exclusions. The
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v254/axios/2021/`.

The current Axios 2019 refresh, `holdout-v255/axios/2019`, evaluated 802
results with parser `axios-parser/0.1.30`; 801 were QA-passing articles and
one was screened as a desk/empty entry. Its zero-overlap rotation audit passed
against v251, and the formal 800-article content audit passed with zero hard
anomalies and 940 selected editorial images. One literal U+FFFD marker was
already present in the captured source (the article discusses that marker);
the content audit distinguishes source-level markers from decoder-introduced
ones while retaining the raw HTML unchanged. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v255/axios/2019/`.

The Axios 2022 checkpoint, `holdout-v256/axios/2022`, evaluated 802
QA-passing results with parser `axios-parser/0.1.30`. Its rotation audit was
disjoint from v209 with no missing exclusions; the formal 800-article content
audit had complete extraction, zero hard anomalies, and 944 selected editorial
images. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v256/axios/2022/`.

The Axios 2023 checkpoint, `holdout-v257/axios/2023`, evaluated 801
QA-passing results with parser `axios-parser/0.1.30`. Its zero-overlap rotation
audit against v209 passed; the formal 800-article content audit had complete
extractions, zero hard anomalies, and 998 selected editorial images. The
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v257/axios/2023/`.

The Axios 2018 refresh, `holdout-v258/axios/2018`, evaluated 804 results
(802 QA-passing articles plus two screened desk entries) with parser
`axios-parser/0.1.30`. The rotation audit excludes all 816 URLs evaluated by
the prior v217 checkpoint, with zero overlap and zero missing exclusions. The
formal 800-article content audit passed with complete extraction, zero hard
anomalies, and 811 selected editorial images. Its checkpoint is stored at
`news-archive/v2/validation-state/holdout-v258/axios/2018/`.

The Axios 2025 refresh, `holdout-v259/axios/2025`, reused the richer v209
capture index because the current canonical manifest is sparse for this year;
its independent plan contains 4,000 candidates. It evaluated 802
QA-passing results with parser `axios-parser/0.1.30`. The rotation audit against
v209 passed with zero overlap, zero missing exclusions, and correct cohort
provenance. The formal 800-article content audit passed with complete
extractions, zero hard anomalies, and 938 selected editorial images. Its
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v259/axios/2025/`.

The Axios 2024 refresh, `holdout-v260/axios/2024`, reused the v170 candidate
index, excluding its 501 previously evaluated URLs before sampling the current
parser. It evaluated 801 QA-passing results with parser
`axios-parser/0.1.30`. Rotation against v170 passed with zero overlap, zero
missing exclusions, and correct cohort provenance. The formal 800-article
content audit passed with complete extractions, zero hard anomalies, and 964
selected editorial images. Its checkpoint is stored at
`news-archive/v2/validation-state/holdout-v260/axios/2024/`.

The later independent Axios 2021 audit, `holdout-v255/axios/2021`, reached
800 complete QA-passing rows on `.1.30` but found five exact-content duplicate
groups spanning 13 distinct URLs. The raw captures were different; each Axios
deep-dive document embedded every chapter in `__NEXT_DATA__`, while the parser
selected the first structurally valid story rather than the story whose
permalink matched the requested URL. `axios-parser/0.1.32` selects the exact
canonical chapter. Replaying all 13 real captures produces 13 distinct bodies
with the correct chapter headlines. The failed `.1.30` cohort remains defect
evidence, and all Axios years require fresh zero-overlap `.1.31` validation.

All FT evidence through `ft-parser/0.8.65`, including the otherwise passing
`holdout-v281/ft/2020` sample, is now superseded. Manual review of that
800-article cohort proved that archived FT coronavirus recommendation cards
and newsletter promotions could survive as body headings, link lists, and
selected images in both Next-era HTML and JSON-LD `articleBody`. Version
`0.8.66` removes only structurally identified coronavirus cards and their
standalone CTAs while retaining real newsletter sections such as `Don't miss`,
`Tokyo talk`, `Charted waters`, `Job moves`, and `Smart reads`, plus substantive
editorial notes. Every FT year therefore requires a fresh zero-overlap
`0.8.66` cohort; the historical checkpoints below remain defect and exclusion
evidence, not current convergence evidence.

The FT 2015 checkpoint, `holdout-v273/ft/2015`, is the first formal holdout
on `ft-parser/0.8.56`. The parser fix removes Euro2day partner sidebars,
copyright/social/advertising chrome, and the Euro2day default artwork plus FT
brand template image that had been selected as article media in the preceding
`.8.55` audit. The fresh cohort was selected after importing all v272
exclusions; it evaluated 905 current-parser results (800 QA-passing articles
and 105 screened non-article-desk entries), with zero prior/exclusion overlap,
zero missing historical exclusions, and no parser or unbound-capture errors.
The formal 800-row content audit passed with zero hard anomalies and 768
selected editorial images; its two remaining review groups are non-hard
repeated podcast/interface text and repeated legacy image renditions. The
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v273/ft/2015/`.

The FT 2016 checkpoint, `holdout-v274/ft/2016`, uses the same
`ft-parser/0.8.56` parser after importing every accepted exclusion from the
formal v10 cohort and the prior local rotations. It evaluated 826 current
parser results, including 800 QA-passing articles and 26 screened
non-article-desk entries. Rotation against v10 passed with zero overlap and
zero missing historical exclusions. The formal 800-row content audit passed
with zero hard anomalies and 420 selected editorial images; its two remaining
groups are review-only. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v274/ft/2016/`.

The FT 2018 checkpoint, `holdout-v217/ft/2018`, completed on
`ft-parser/0.8.56` after importing the full prior exclusion union. It
evaluated 885 current-parser results: 800 QA-passing articles and 85 screened
non-article-desk entries. Rotation passed with zero prior-cohort overlap, zero
exclusion overlap, and zero missing historical exclusions. The formal 800-row
content audit passed with 800/800 complete extractions, zero hard anomalies,
and 357 selected editorial images; its two remaining review candidates are
non-hard. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v217/ft/2018/`.

The current-parser FT 2017 checkpoint, `holdout-v276/ft/2017`, completed on
`ft-parser/0.8.56` after importing the full prior exclusion union. It evaluated
842 current-parser results, yielding 800 QA-passing articles (799 complete and
one allowed partial). Rotation passed with 7,429 prior unique evaluations,
zero prior-cohort overlap, zero exclusion overlap, zero missing historical
exclusions, and no cohort-label errors. The formal 800-row content audit passed
with zero hard anomalies and 682 selected editorial images; one remaining
review candidate is non-hard. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v276/ft/2017/`.

The current-parser FT 2020 checkpoint, `holdout-v278/ft/2020`, completed on
`ft-parser/0.8.56` after importing the full prior exclusion union. It evaluated
890 current-parser results, yielding 800 QA-passing complete articles.
Rotation passed against 5,419 prior unique evaluations with zero prior-cohort
overlap, zero exclusion overlap, zero missing historical exclusions, and no
cohort-label errors. The formal 800-row content audit passed with zero hard
anomalies and 1,052 selected editorial images; its two remaining review groups
are non-hard. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v278/ft/2020/`.

The current-parser FT 2019 checkpoint, `holdout-v277/ft/2019`, completed on
`ft-parser/0.8.56` after importing the full prior exclusion union. It evaluated
880 current-parser results, yielding 800 QA-passing articles (799 complete and
one allowed partial). Rotation passed against 5,910 prior unique evaluations
with zero prior-cohort overlap, zero exclusion overlap, zero missing historical
exclusions, and no cohort-label errors. The formal 800-row content audit passed
with zero hard anomalies and 567 selected editorial images; its two remaining
review groups are non-hard. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v277/ft/2019/`.

The current-parser FT 2021 checkpoint, `holdout-v279/ft/2021`, completed on
`ft-parser/0.8.56` after importing the full prior exclusion union. It evaluated
915 current-parser results, yielding 800 QA-passing complete articles and one
unsupported result. Rotation passed with zero prior-cohort overlap, zero
exclusion overlap, zero missing historical exclusions, and no cohort-label
errors. The formal 800-row content audit passed with zero hard anomalies and
871 selected editorial images; its two remaining review groups are non-hard.
The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v279/ft/2021/`.

The Axios 2019 checkpoint, `holdout-v281/axios/2019`, completed on
`axios-parser/0.1.30` after importing the full prior exclusion union. It
evaluated 806 current-parser results: 800 QA-passing articles and six screened
desk entries. Rotation passed with zero prior-cohort overlap, zero exclusion
overlap, and zero missing historical exclusions. The formal 800-row content
audit passed with 800/800 complete extractions, zero hard anomalies, and 923
selected editorial images; two remaining review groups are non-hard repeated
cross-article blocks/image reuse. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v281/axios/2019/`.

The follow-up current-parser Axios 2018 rotation, `holdout-v280/axios/2018`,
was allowed to exhaust its disjoint source pool before any formal audit. After
excluding 16,585 URLs from the prior cohorts, only 140 candidates remained;
the run produced 119 QA-passing articles and 21 screened desk entries. It is
recorded as source-limited rather than parser convergence, with no rotation or
content audit emitted and no change to the formal convergence count. Its
checkpoint remains at
`news-archive/v2/validation-state/holdout-v280/axios/2018/`.

The current-parser Axios 2017 retry, `holdout-v283/axios/2017`, also exhausted
its disjoint source pool without producing a formal sample. The merged plan
left 45 candidates after excluding 15,138 historical URLs; 12 were screened
as desk/non-article entries and zero yielded a QA article. It is therefore
source-limited rather than parser convergence, with no rotation or content
audit emitted. Its checkpoint remains at
`news-archive/v2/validation-state/holdout-v283/axios/2017/`.

The NPR 2015 retry, `holdout-v288/npr/2015`, is also source-limited rather
than parser convergence. After the prior-cohort exclusions, the checkpoint
contained 72 eligible URLs; 56 were screened as non-articles and only 16
current-parser articles were available for QA. No rotation or content audit
was emitted, and the checkpoint remains at
`news-archive/v2/validation-state/holdout-v288/npr/2015/`.

The NPR 2016 retry, `holdout-v306/npr/2016`, is also source-limited rather
than parser convergence. Its disjoint plan contained 21 candidates; 13
captures passed QA and eight archive responses failed, so it cannot reach the
800-article gate. No rotation or content audit was emitted.

The NPR 2014 retry, `holdout-v312/npr/2014`, is likewise source-limited. Its
merged Wayback/Common Crawl plan exhausted at 574 QA-passing complete articles;
the remaining nine actionable rows terminated after archive-error or
`npr-parser-unusable` fallbacks, with no usable HTML left to evaluate. No
rotation or content audit was emitted, so this cell is not counted as parser
convergence.

The Al Jazeera 2016 holdout, `holdout-v297/aljazeera/2016`, is source-limited
rather than parser convergence. Its disjoint plan contained only 40 eligible
URLs; all 40 were screened as non-article-desk shells, leaving no QA article
to evaluate. No rotation or content audit was emitted, and the checkpoint is
stored at `news-archive/v2/validation-state/holdout-v297/aljazeera/2016/`.

The SCMP 2016 holdout, `holdout-v298/scmp/2016`, reached 800/800 QA-passing
complete extractions and passed the zero-overlap rotation audit. Its content
audit correctly selected editorial images but the audit detector falsely
classified two renditions of a Google Pixel article image as tracking pixels
because `pixel` appeared in the editorial slug. The detector now requires a
pixel filename or an explicit 1x1/tracking/beacon suffix; the failed cohort is
retained as evidence. A fresh zero-overlap revalidation, `holdout-v301/scmp/2016`,
then evaluated 800/800 QA-passing complete articles. Rotation passed with zero
prior-cohort overlap, zero exclusion overlap, and zero missing historical
exclusions; the formal content audit passed with zero hard anomalies and 2,593
selected editorial images (seven non-hard review candidates).

The Caixin 2016 holdout, `holdout-v300/caixin/2016`, completed on the current
`caixin-parser/0.1.15` after excluding all prior cohorts. It evaluated 800
QA-passing complete articles; rotation passed with zero prior-cohort overlap,
zero exclusion overlap, and zero missing historical exclusions. The formal
content audit passed with zero hard anomalies and 61 selected editorial
images. Its checkpoint is stored at
`news-archive/v2/validation-state/holdout-v300/caixin/2016/`.

The Caixin 2018 retry, `holdout-v302/caixin/2018`, is source-limited rather
than parser convergence. Its disjoint plan exhausted 183 candidates: one
article capture passed QA and 182 archive responses failed, leaving no path to
the 800-article gate. The Nikkei 2020 retry, `holdout-v305/nikkei/2020`,
exhausted its two eligible candidates without a usable article. The Reuters
2012 retry, `holdout-v307/reuters/2012`, likewise found no usable article in
its 12-candidate source pool (five archive errors and seven unresolved
candidates). These checkpoints remain source-limited and are not counted as
parser convergence.

The pre-`0.8.122` NYT 2017 checkpoint, `holdout-v285/nyt/2017`, reached its
800-row target with `nyt-parser/0.8.121`: all 800 rows passed QA, with 797
complete and three allowed partial extractions. Its zero-overlap rotation
audit and formal content audit both passed with zero hard anomalies (1,060
selected editorial images). It is retained as historical parser evidence, but
is not advanced as the current-parser convergence cell until the `0.8.122`
revalidation completes, because the adjacent NYT 2012 audit exposed a legacy
icon-selection defect.

The NYT 2012 checkpoint, `holdout-v287/nyt/2012`, reached 800/800 QA-passing
complete extractions and passed rotation, but its content audit found one hard
`suspicious-selected-image` anomaly: a legacy `graphics8.nytimes.com` `ccc-icon`
asset was incorrectly selected as article media. The parser now classifies
that legacy icon directory as non-editorial (`nyt-parser/0.8.122`), and fresh
zero-overlap revalidations are running as `holdout-v293/nyt/2012` and
`holdout-v294/nyt/2017`.

The current-parser NYT 2012 revalidation, `holdout-v293/nyt/2012`, has now
completed with 800/800 QA-passing complete articles. Rotation passed with zero
prior-cohort overlap, zero exclusion overlap, and zero missing historical
exclusions; the formal content audit passed with zero hard anomalies and 567
selected editorial images (one non-hard review candidate). The NYT 2017
revalidation `holdout-v294/nyt/2017` has also completed on
`nyt-parser/0.8.122` with 800/800 QA-passing complete articles. Rotation
passed with zero prior-cohort overlap, zero exclusion overlap, and zero
missing historical exclusions; the formal content audit passed with zero hard
anomalies and 1,097 selected editorial images (one non-hard review candidate).

The current-parser AP 2016 holdout, `holdout-v295/ap/2016`, has now reached
800/800 QA-passing complete articles on `ap-parser/0.6.25`. Rotation passed
against the full prior exclusion union with zero prior-cohort overlap, zero
exclusion overlap, zero missing prior exclusions, and no wrong cohort labels.
The formal content audit passed with zero hard anomalies and 598 selected
editorial images (two non-hard review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v295/ap/2016/`.

The current-parser Zaobao 2016 holdout, `holdout-v299/zaobao/2016`, has also
completed with 800/800 QA-passing complete articles on
`zaobao-parser/0.1.12`. Rotation passed with zero prior-cohort overlap, zero
exclusion overlap, zero missing prior exclusions, and no wrong cohort labels.
The formal content audit passed with zero hard anomalies and 1,064 selected
editorial images (two non-hard review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v299/zaobao/2016/`.

The current-parser Nikkei 2015 holdout, `holdout-v289/nikkei/2015`, has now
completed with 800/800 QA-passing complete articles on
`nikkei-parser/0.1.8`. Rotation passed with zero prior-cohort overlap, zero
exclusion overlap, zero missing prior exclusions, and no wrong cohort labels.
The formal content audit passed with zero hard anomalies and 449 selected
editorial images (10 non-hard review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v289/nikkei/2015/`.

The current-parser FT 2013 holdout, `holdout-v308/ft/2013`, has now completed
with 800/800 QA-passing complete articles on `ft-parser/0.8.56`. Rotation
passed with zero prior-cohort overlap, zero exclusion overlap, zero missing
prior exclusions, and no wrong cohort labels. The formal content audit passed
with zero hard anomalies and 584 selected editorial images (two non-hard
review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v308/ft/2013/`.

The current-parser NYT 2015 holdout, `holdout-v267/nyt/2015`, has reached the
formal 800-row target on `nyt-parser/0.8.122`: all 800 rows passed QA, with
798 complete extractions and two allowed partial gallery extractions. Rotation
passed with zero prior-cohort overlap, zero exclusion overlap, zero missing
prior exclusions, and no wrong cohort labels. The formal content audit passed
with zero hard anomalies and 816 selected editorial images (one non-hard
review candidate). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v267/nyt/2015/`.

The current-parser NYT 2014 holdout, `holdout-v268/nyt/2014`, has now
completed with 800/800 QA-passing complete articles on `nyt-parser/0.8.122`.
Rotation passed with zero prior-cohort overlap, zero exclusion overlap, zero
missing prior exclusions, and no wrong cohort labels. The formal content audit
passed with zero hard anomalies and 918 selected editorial images (two
non-hard review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v268/nyt/2014/`.

The current-parser NYT 2013 holdout, `holdout-v269/nyt/2013`, has now
completed with 800/800 QA-passing complete articles on `nyt-parser/0.8.122`.
Rotation passed with zero prior-cohort overlap, zero exclusion overlap, zero
missing prior exclusions, and no wrong cohort labels. The formal content audit
passed with zero hard anomalies and 813 selected editorial images (two
non-hard review candidates). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v269/nyt/2013/`.

The NYT 2020 refresh, `holdout-v261/nyt/2020`, moved from parser
`nyt-parser/0.8.120` to the current `nyt-parser/0.8.121` using a disjoint plan
from v248. It evaluated 812 results, with 803 QA-passing results and nine
screened desk entries. Rotation passed with zero overlap and zero missing
exclusions; the formal 800-article content audit passed with zero hard
anomalies and 1,767 selected editorial images. Review-only repeated blocks
were confined to expected briefing/election-interactive templates. The
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v261/nyt/2020/`.

The NYT 2019 refresh, `holdout-v262/nyt/2019`, moved from parser
`nyt-parser/0.8.109` to the current `nyt-parser/0.8.121` using a disjoint plan
from v237. It evaluated 815 results, with 800 QA-passing results and 15
screened desk entries. Rotation passed with zero overlap and zero missing
exclusions; the formal 800-article content audit passed with zero hard
anomalies and 1,439 selected editorial images. One review-only repeated-block
pattern was confined to expected briefing/letters templates. The checkpoint
is stored at
`news-archive/v2/validation-state/holdout-v262/nyt/2019/`.

The NYT 2018 refresh, `holdout-v263/nyt/2018`, moved from parser
`nyt-parser/0.8.107` to the current `nyt-parser/0.8.121` using a disjoint plan
from v234. It evaluated 819 current-parser results, with 800 QA-passing
articles and 19 screened desk entries. Rotation passed with zero overlap and
zero missing exclusions; the formal 800-article content audit passed with zero
hard anomalies and 1,222 selected editorial images. Two review-only repeated
block groups were retained for inspection. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v263/nyt/2018/`.

The NYT 2017 refresh, `holdout-v264/nyt/2017`, moved from parser
`nyt-parser/0.8.101` to the current `nyt-parser/0.8.121` using a disjoint plan
from v227. It evaluated 811 current-parser results, with 800 QA-passing
articles and 11 screened desk entries. Rotation passed with zero overlap and
zero missing exclusions; the formal 800-article content audit passed with zero
hard anomalies and 937 selected editorial images. Two review-only repeated
block groups were retained for inspection. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v264/nyt/2017/`.

The NYT 2016 refresh, `holdout-v265/nyt/2016`, moved from parser
`nyt-parser/0.8.92` to the current `nyt-parser/0.8.121` using a disjoint plan
from v217. It evaluated 809 current-parser results, with 800 QA-passing
articles and nine screened desk entries. Seven additional Wayback captures
were preserved as raw provenance but removed from the article denominator
after their final URLs and HTML titles were independently confirmed as NYT
authentication/login shells. Rotation passed with zero overlap and zero
missing exclusions; the formal 800-article content audit passed with zero
hard anomalies and 959 selected editorial images. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v265/nyt/2016/`.

The NYT 2015 refresh, `holdout-v266/nyt/2015`, moved from parser
`nyt-parser/0.8.90` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v214 evaluated cohort. It evaluated 811 current-parser
results, with 802 QA-passing articles and nine screened desk entries. One
image-led T Magazine package (one short dek plus a figure caption) was kept as
raw provenance but removed from the text-article denominator; all 857 URLs
from the prior evaluated cohort are excluded. Rotation passed with zero
overlap and zero missing prior exclusions; the formal 800-article content
audit passed with zero hard anomalies and 736 selected editorial images. The
checkpoint is stored at
`news-archive/v2/validation-state/holdout-v266/nyt/2015/`.

The NYT 2014 refresh, `holdout-v267/nyt/2014`, moved from parser
`nyt-parser/0.8.90` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v213 evaluated cohort. It evaluated 811 current-parser
results, with 805 QA-passing articles and six screened corrections-desk
entries. All 861 URLs evaluated by v213 (including its inherited exclusion
boundary) are excluded. Rotation passed with zero overlap and zero missing
prior exclusions; the formal 800-article content audit passed with zero hard
anomalies and 690 selected editorial images. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v267/nyt/2014/`.

The NYT 2013 refresh, `holdout-v268/nyt/2013`, moved from parser
`nyt-parser/0.8.87` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v209 evaluated cohort. It evaluated 810 current-parser
results, with 805 QA-passing articles and five screened corrections-desk
entries. All 867 URLs evaluated by v209 are excluded. Rotation passed with
zero overlap and zero missing prior exclusions; the formal 800-article
content audit passed with zero hard anomalies and 776 selected editorial
images. The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v268/nyt/2013/`.

The NYT 2012 refresh, `holdout-v269/nyt/2012`, moved from parser
`nyt-parser/0.8.87` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v208 evaluated cohort. It evaluated 811 current-parser
results, with 805 QA-passing articles and six screened corrections-desk
entries. All 889 URLs evaluated by v208 and its inherited exclusion boundary
are excluded. Rotation passed with zero overlap and zero missing prior
exclusions; the formal 800-article content audit passed with zero hard
anomalies and 557 selected editorial images (796 complete and four partial
extractions in the audited sample). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v269/nyt/2012/`.

The NYT 2011 refresh, `holdout-v270/nyt/2011`, moved from parser
`nyt-parser/0.8.85` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v205 evaluated cohort. It evaluated 809 current-parser
results, with 804 QA-passing articles and five screened corrections-desk
entries. All 803 URLs evaluated by v205 and its inherited exclusion boundary
are excluded. Rotation passed with zero overlap and zero missing prior
exclusions; the formal 800-article content audit passed with zero hard
anomalies and 389 selected editorial images (796 complete and four partial
extractions in the audited sample). The checkpoint is stored at
`news-archive/v2/validation-state/holdout-v270/nyt/2011/`.

The NYT 2010 refresh, `holdout-v271/nyt/2010`, moved from parser
`nyt-parser/0.8.83` to the current `nyt-parser/0.8.121` using a disjoint plan
from the complete v203 evaluated cohort. The first 1,000-candidate pool was
expanded to 1,103 after Wayback failures left three QA-passing results short
of the target; the additional candidates were selected without overlap. It
evaluated 803 current-parser results, with 800 QA-passing articles and three
screened corrections-desk entries. Rotation passed with zero overlap and zero
missing prior exclusions; the formal 800-article content audit passed with
zero hard anomalies and 356 selected editorial images. The checkpoint is
stored at `news-archive/v2/validation-state/holdout-v271/nyt/2010/`.

The watchdogs share a controlled budget of at most two sustained catalog or
validation runs. Parser validation stores its selected canonical raw samples
without duplicating them below validation state. The archive watchdog is
catalog-only (`max_captures=0`), so automatic source expansion cannot silently
restart a full raw-corpus download. B2 must retain its keep-latest lifecycle
policy so superseded checkpoints do not accumulate as hidden object versions.

HTML objects are addressed by the SHA-256 of the uncompressed response or
explicitly derived representation. Gzip is deterministic (`mtime=0`), so
repeated identical captures produce the same B2 object. The raw capture record's
`representation` field distinguishes the two without changing object layout.
Each canonical publisher URL appears once in a manifest with ranked
fallback snapshots. The capture worker evaluates usable candidates and stores
only the highest-quality response; it stops early when a response reaches the
maximum raw quality score. FT capture first queries the historically
higher-yield exact Wayback timemap. Common Crawl is the bounded fallback: it
queries the nearest indexes for the exact canonical URL, range-downloads only
the indexed WARC record, validates the WARC target URL, reconstructs the
original HTTP response, and applies the same subscription-shell and raw-quality
gates. Publication-near guesses are used only when the timemap is empty.
Common Crawl and Wayback use separate host circuit breakers and bounded retries
so one unhealthy archive cannot stall every source. The raw record retains the
Common Crawl object URL, WARC filename, offset, and length.

FT also has a catalog-only Common Crawl supplement for each source window
(`ft/2010-2015/commoncrawl-prefix` and `ft/2016-2026/commoncrawl-prefix`). It is
merged during parser validation alongside the sitemap/Wayback manifest so a
subscription-shell replay can be retried against an independently captured
response. The supplement stores URL/date metadata and WARC coordinates; it does
not download a full WACZ or bulk WARC collection.

Wayback URL-key discovery may begin capture before every query is exhausted
once every requested year has at least 1,100 unique article candidates. Discovery
continues in later resumable runs, while the 300-article buffer allows the
800-sample parser gate to tolerate unusable archive responses.

Objects and records are uploaded before the capture checkpoint. A restored
checkpoint therefore never references data that has not reached B2.
Cancelling a workflow skips checkpoint and object publishing, while ordinary
failures still publish a recoverable checkpoint.

During a long capture batch, the workflow also creates a consistent SQLite
backup and incrementally uploads completed objects every ten minutes. The
checkpoint is still published last. A runner failure therefore loses at most
the work completed since the latest live checkpoint rather than the whole
batch.

## Schemas

- [`schemas/jojo-raw-capture-v1.schema.json`](schemas/jojo-raw-capture-v1.schema.json)
  describes retrieval provenance, candidate snapshots, response metadata,
  quality signals, and the raw HTML blob reference.
- [`schemas/jojo-article-v1.schema.json`](schemas/jojo-article-v1.schema.json)
  describes normalized metadata, ordered body blocks, source links, parser
  version, extraction quality, and classified image candidates.

Regenerate them after a model change:

```bash
python tools/export_news_schemas.py
```

## Local discovery

Build or resume a publisher manifest:

```bash
python tools/build_wayback_manifest.py \
  --publisher reuters \
  --from-year 2016 \
  --to-year 2026 \
  --output .archive-work/reuters/catalog/manifest.jsonl.gz \
  --state .archive-work/reuters/catalog/discovery.sqlite3 \
  --max-pages 5
```

Supported publisher IDs are `ap`, `wsj`, `bloomberg`, `nyt`, `reuters`, `ft`,
`axios`, `npr`, `nikkei`, `zaobao`, `aljazeera`, `scmp`, and `caixin`.

## Local raw capture

```bash
python tools/capture_archive_batch.py \
  --publisher reuters \
  --manifest .archive-work/reuters/catalog/manifest.jsonl.gz \
  --output-dir .archive-work/reuters/raw \
  --workers 4 \
  --max-captures 100
```

Replay one stored capture through its versioned parser:

```bash
python tools/parse_raw_capture.py \
  --capture-record .archive-work/reuters/raw/records/aa/article.json \
  --archive-root .archive-work/reuters/raw \
  --output .archive-work/reuters/parsed/article.json
```

## GitHub Actions

The `News raw archive` workflow requires:

- `B2_ARCHIVE_KEY_ID`
- `B2_ARCHIVE_APPLICATION_KEY`
- `B2_ARCHIVE_BUCKET`

It can optionally use a Clash/Mihomo subscription for archive transport:

- `CLASH_SUBSCRIPTION_URL`

This must be added as a GitHub Actions secret, not committed to the repository
or pasted into workflow inputs. On Linux runners the workflow materializes the
subscription on the ephemeral runner, starts a pinned Mihomo binary with a
round-robin load-balancing group, and exposes it only to archive clients. The
raw subscription and generated node config are not uploaded to B2. The
ArchiveClient enforces the configured request interval, retries, and circuit
breaker. Without a proxy the interval is process-global; with the explicit
round-robin pool it is bounded independently per worker connection so the
pool can make progress in parallel without turning all nodes into one queue.
macOS runners currently fall back to their normal network.

The B2 key must be restricted to the private archive bucket and allow bucket
listing plus file list/read/write/delete operations.

Set `max_captures` to `0` for a catalog-only run. That mode restores and
publishes only `catalog/discovery.sqlite3.gz` and `catalog/manifest.jsonl.gz`;
it does not restore raw capture state, download article HTML, replay a parser,
or write anything below `raw/` or `state/`.

For a storage smoke test, select:

```text
publisher: bloomberg
from_year: 2020
to_year: 2020
manifest_mode: committed-bloomberg-2020
max_captures: 2
auto_continue: false
```

For AP, Bloomberg, NYT, and FT, use `manifest_mode: sitemap-wayback`. It obtains
the canonical URL and publication month from the publisher's historical
sitemaps, then asks Wayback for snapshots near publication. This avoids large
CDX prefix queries for AP and NYT and tends to select better article versions.
For Bloomberg and FT, the same mode additionally advances bounded,
resume-keyed Wayback URL-key queries and merges their exact snapshots into the
sitemap manifest. Exact URL-key candidates take precedence over guessed
publication-near timestamps, while sitemap or validated partner publication
dates remain authoritative when available. This fills historical sitemap gaps
without creating a second capture database or discarding existing progress.

Use `manifest_mode: wayback` for partitioned CDX adapters such as WSJ. Discovery
checkpoints are published every ten minutes and after each bounded run. A
sitemap-based shard may begin capture after its sitemap baseline is complete
while its supplemental URL-key and partner catalogs continue to grow.

WSJ and legacy Reuters also run a parallel `wayback-urlkey` shard. It asks CDX
for one first capture per unique URL, instead of paging through every distinct
HTML digest. This provides the cross-year parser-validation corpus much sooner
while the original digest-mode shards continue the deeper, three-candidate
archive discovery. When a canonical URL has no embedded date, the first capture
timestamp supplies the provisional sampling year; the parser still prefers the
publication metadata contained in the archived page.

For WSJ years 2016–2023, the URL-key shard also searches Infini-News for
historical WSJ paywall/copyright templates, draws a reproducible random sample
across every matching shard, and accepts only normalized official `wsj.com`
article URLs with matching-year metadata. Rows with at least 1,000 extracted
body characters are exported as direct `infini-news` candidates ahead of
publication-near Wayback captures. Capture re-fetches the manifest-bound
dataset row, validates URL, headline, year, length, and WARC provenance, and
stores deterministic `derived-html`; incomplete previews fail closed. The
derived representation passes through the same parser and 800-article QA gate
but remains distinguishable from original HTML. This avoids treating other Dow
Jones publications that share the copyright template as WSJ articles.

For the sparse 2016–2018 WSJ years, the same catalog also performs bounded,
resumable scans of Infini-News' year-partitioned Parquet metadata. It reads only
the URL, hostname, date, headline, text-length, language, and WARC-provenance
columns until each year has 1,600 strict official-origin candidates. A row is
accepted only when the metadata hostname and URL hostname agree on an official
WSJ host, URL normalization accepts an article path, the year agrees, the
headline and text-length gates pass, the language is English, and the WARC is a
`CC-NEWS-*.warc.gz` object. The remote Parquet files are never copied to B2;
only the small resumable catalog state, manifest, and selected validation
captures are stored. A selected row can enter parser validation through a
validated Infini `derived-html` capture or another usable page candidate.

For WSJ articles from 2023 onward, the same shard also enumerates the public
Wall Street Journal category on To Vima, resolves each licensed-copy headline
to its canonical `wsj.com` URL, and records the partner page as a direct
candidate. A copy is accepted only when the final host and `/wsj/` path,
headline, publication date, complete-body threshold, and visible Wall Street
Journal attribution all pass. Failed provenance checks never enter the parser
validation sample.

Axios uses a separate, resumable Common Crawl prefix catalog for 2017–2026.
The catalog checks recent collections first, because current Axios URLs retain
their publication year while older collection/prefix pairs are frequently
empty. Both successful pages and empty page-count queries are checkpointed;
each run has independent page and query limits, so a broad prefix cannot turn a
nominally bounded run into an unbounded scan. Only normalized official Axios
article paths with a URL-derived matching publication year and exact WARC
coordinates enter the supplemental manifest. Parser validation merges that
manifest with the Wayback URL-key source, then applies the same fresh-cohort,
zero-overlap 800-article gate; Common Crawl catalog capacity alone is never
treated as parser convergence.

FT discovery also augments sparse Wayback results with licensed partner
copies. It searches Infini-News' CC-News index for the exact visible
`Copyright The Financial Times Limited` attribution, samples occurrences
across the whole result range for each year, and retains the CC-News WARC
filename and document index as discovery provenance. Each partner headline is
resolved to an `ft.com/content/` URL with an exact-title search. Capture first
tries exact publisher archives and the live partner HTML. Partner HTML enters
the archive only when its final host, headline, publication date, complete-body
threshold, and visible FT copyright statement all pass.

The discovery checkpoint also serves as a local headline-and-date provenance
index for all accepted Infini-News partner rows, including rows whose canonical
FT URL could not be found by a search engine. After an exact FT archive response
reveals the original headline, capture can match it against that local index
with a same-year, two-day and 90%-token-overlap gate. It tries the indexed raw
partner URL first and the derived dataset row second. This reuses already
verified discovery work and avoids scanning hundreds of gigabytes of Parquet
files during each validator run; all downstream host, headline, date, body,
copyright, row-index and WARC checks still apply.

If those raw candidates fail, a mapped row can be fetched from Infini-News'
official Hugging Face dataset by its exact year and document index. The adapter
accepts only the expected dataset endpoint, one exact row, the mapped partner
URL and headline, a `CC-NEWS-*.warc.gz` provenance match, at least 400 body
characters, the publication-date gate, and visible FT copyright attribution.
It then creates deterministic, escaped article HTML for the same FT parser.
The resulting capture is explicitly `derived-html`, never presented as original
FT or partner HTML, and retains both source links. Failed or ambiguous mappings
remain outside the parser validation sample.

The direct FT Infini-News scan is not limited to URLs already present in the
Wayback manifest. Strictly validated FT-origin rows may materialize a new
pending capture with `derived-html` provenance; the normal capture worker, FT
parser, and zero-overlap validation gate then process it exactly like any
other manifest row. This lets the direct corpus fill sparse historical years
instead of only adding a fallback to previously discovered URLs.

Bloomberg discovery augments sparse canonical Wayback results with licensed
partner copies. For 2017 onward, it searches Infini-News' CC-News index for the
exact year-specific visible `©YYYY Bloomberg L.P.` statement and draws a
reproducible random sample across each year's entire occurrence range. It
retains the CC-News WARC filename and document index solely as discovery
provenance, resolves each partner headline to its canonical `bloomberg.com`
URL, then obtains the publication-near partner capture from Wayback.

From 2025 onward it additionally enumerates BNN Bloomberg's public
date-addressable daily sitemaps. Because older BNN article routes now redirect
to the home page, it resolves the nearest exact Wayback capture of each partner
URL. Every Bloomberg partner capture must pass complete-body, headline,
publication-date, Bloomberg News attribution, and visible year-matched
`Bloomberg L.P.` copyright checks. BNN copies must additionally contain the
canonical Bloomberg link or a matching mirrored source slug. Infini-News text
is never stored as article content; only the independently fetched and
validated archived partner HTML is stored, with the canonical Bloomberg URL
preserved as the source link.

Reuters uses two catalog shards because its URL design changed:

- `wayback` for the legacy `/article/` catalog (2016–2020);
- `reuters-sitemap-wayback` for 2021 onward. This mode enumerates archived
  snapshots of Reuters' rolling sitemap, extracts canonical article URLs, and
  then selects publication-near Wayback captures. For gaps after Reuters'
  archived rolling sitemaps stop, bounded weekly searches of public urlscan.io
  metadata contribute canonical Reuters URLs. Those rows retain `urlscan` as
  discovery provenance and try Wayback before a live-origin fallback; urlscan
  metadata is never treated as article content.

`News archive watchdog` runs at 7 and 37 minutes past each hour, offset from
the parser-validation watchdog. A single dispatcher counts active
`news-raw-*` and `parser-*` runs, fills only the available portion of the
two-run budget, skips shards whose B2 manifest summary is already complete,
and advances incomplete shards in explicit research-priority order. It always
uses catalog-only mode; any future full-corpus capture must be a separate,
deliberate operation with a new storage-cost review.
