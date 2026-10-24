# Broker statement samples — SYNTHETIC

Every file in this folder was written by hand from the published (or, where
none is published, the commonly seen) layout of each broker's export, to test
`src/portfolio/import/`. They are **format samples, not statements and not
market data**: account ids, ISINs of fictitious lines, trade ids, prices and
quantities are made up, and each file deliberately contains malformed or
out-of-scope rows that the parsers must report in `skipped`.

| File | Format | Layout source |
| --- | --- | --- |
| `ibkr-flex.xml` | IBKR Flex Query, XML | IBKR Flex Query reference (Trades, Cash Transactions) |
| `ibkr-flex-plain.csv` | IBKR Flex Query, CSV, one header row per section | same |
| `ibkr-flex-sections.csv` | IBKR Flex Query with header/trailer records (BOF/BOS/HEADER/DATA/EOS/EOF) | IBKR "Delivery Configuration and General Configuration" |
| `ibkr-activity.csv` | IBKR Activity Statement CSV (section-prefixed rows) | as exported from the Activity Statement |
| `binance-trades.csv` | Binance spot Trade History | best-effort (no published column reference) |
| `binance-transactions.csv` | Binance wallet Transaction History | best-effort |
| `kraken-trades.csv` | Kraken trades.csv | Kraken support: "How to interpret Trades history fields" |
| `kraken-ledgers.csv` | Kraken ledgers.csv | Kraken support: "How to interpret Ledger history fields" |
| `coinbase.csv` | Coinbase transaction history, with its preamble lines | best-effort |
| `generic-fr.csv` | a French broker export (`;`, `1 234,56`, DD/MM/YYYY, French labels) read with a column map | invented layout |
| `generic-en.csv` | an English CSV read with a column map | invented layout |

No sample sells more than it holds: each replays through `buildBook`.
