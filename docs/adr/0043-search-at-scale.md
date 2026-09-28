# ADR-043: Search at scale: bounded candidates and a word list for typos

## Status

Accepted.

## Context

T-034's target is search p95 under 150 ms at 1M documents. The load job's searches took 2–2.5 s at 227k documents (100 shards locally) and over 15 s at spec scale (500s).

Each search matched with `tsv @@ q OR trigram % q OR trigram LIKE %q%`, then ranked and counted every match per type. Two costs dominated:

- **Trigram similarity (`%`).** It rechecks every document that shares a trigram with the text: 88k candidates for "BR meta awareness", 1.5 s on its own. Full text found the same 2.3k hits in 84 ms.
- **Common words.** 23k comments contain "Black Friday". Ranking and counting them means reading all 23k rows (320 ms, growing with the data). Postgres also misestimated them and scanned the whole workspace.

## Decision

- **Exact first.** Documents match on the words (full text) or the typed string (substring of title and path).
- **Typos are the fallback.** They run only when nothing matches exactly. Each word is replaced by the workspace's most similar known word, from `search_term` via pg_trgm, and the corrected words go through the full-text index.
  - `search_term` holds the distinct words of the workspace's documents: 941 in titles and paths, 37k overall locally.
  - A statement-level trigger on `search_document` keeps it current for every write path.
  - Words are never removed; a stale word only corrects a search to a word that finds nothing.
- **Bounded candidates.** Each type ranks and counts at most `SEARCH_CANDIDATES` (1,000) matches, in a per-type `LATERAL … LIMIT`. Beyond that the count is a lower bound: the response says `more: true` and the UI shows "1000+".
  - The trade-off: when a word matches more than 1,000 documents of one type, the top hits are ranked among the first 1,000 found, not all of them.

## Consequences

Measured at 100 shards (227k documents), the load job's searches:

| search | before | after |
|---|---|---|
| "BR meta awareness" | 2,188 ms | 64 ms |
| "Black Friday" | 2,011 ms | 26 ms |
| "lookalike reforecast" | 2,146 ms | 78 ms |
| qualifier-only searches | 24–142 ms | 4–129 ms |

- Typos: before, "awarness" took 1.9 s and found 1 result; now 180 ms and 51 results. "brazl" and "lookalke reforcast" went from 0 results in about 2 s to results in 230–265 ms.
- The spec-scale job (1M documents) re-measures this on push.
- A word that becomes rare again keeps its row in `search_term`, which is harmless.
