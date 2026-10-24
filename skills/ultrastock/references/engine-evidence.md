# Engine evidence

ultrastock vendors the [webindex](https://github.com/maxgfr/webindex) engine
(pinned by tag and sha256 in `src/vendor/webindex.meta.json`) for HTTP,
argument parsing and claim parsing, configured under the `ULTRASTOCK_` prefix.
Prices, indicators, the evidence register and the check are ultrastock's own.

## Failure notes, and what to do

| Note | Meaning / action |
|---|---|
| `no Euronext listing for …` | the ticker is not listed on that venue: check the suffix, or pass the ISIN |
| `no US listing for …` | not a Nasdaq-known US ticker: check the symbol |
| `Euronext serves about two years` | the window asked for is older than Euronext keeps |
| `Binance refuses requests from this location (HTTP 451)` | Binance blocks this jurisdiction: tell the user; do not route around it |
| `… is not a Binance spot pair` | the pair does not exist on Binance spot |
| `no provider covers the ".XX" market yet` | not covered: say so, do not guess another market |
| `fixture … has no recorded answer` | a replay asked for a URL never recorded: re-record with `--record` |

`doctor --probe` times one live call per source and names the ones that fail.

## Fixtures and the cache

- `--record <dir>` saves every HTTP answer read, with the time it was made;
  `--fixture <dir>` replays them offline — the same evidence, the same ids.
- The dataset cache keeps each answer as long as it stays true (a minute for a
  quote, hours for daily bars, a week for a listing); `--refresh` ignores it,
  `--offline` serves only what is on disk.

## Variables

| Variable | Sets |
|---|---|
| `ULTRASTOCK_HOME` | state directory: runs, and later the profile and the journal (default `~/.ultrastock`) |
| `ULTRASTOCK_CACHE_DIR` | dataset cache (default `ULTRASTOCK_HOME/cache`) |
| `ULTRASTOCK_TIMEOUT_MS` | network budget per attempt (default 20000) |
