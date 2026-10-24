# Onboarding: the profile and the jurisdiction

## First use

1. `ultrastock profile init --jurisdiction FR --currency EUR` — a conservative
   default profile in `ULTRASTOCK_HOME/profile.json` (mode 600).
2. `ultrastock profile suitability` prints the questionnaire. Ask the user each
   question in their language, one at a time, with the choices as written;
   never answer for them. Write the answers to a JSON file:
   `{ "horizon": "gt10", "drop": "hold", "maxLoss": "20", "share": "25to50",
   "income": "stable", "goal": "growth", "emergencyFundMonths": 6,
   "experience.stocks": "basic", "experience.crypto": "none", … }`.
3. `ultrastock profile suitability --answers <file>` scores it 1–7 and sets the
   limits the risk gate enforces (position, sector and crypto caps, risk per
   trade, loss stops). Read the reasons and the warnings back to the user: an
   emergency fund under three months caps the score and comes first.
4. `ultrastock profile envelope <id> --type PEA|PEA-PME|CTO|AV|PER|CRYPTO --broker <name>`
   for each account the user holds.

`profile set <field> <value>` changes one field (`profile set` with no value
lists them); every change is kept in the profile's history. Loosening a limit
is the user's decision, never the agent's: say what it changes, then ask.

## The jurisdiction

`ultrastock jurisdiction show` lists the rules for the profile's country, each
with its status (allowed, restricted, blocked, unknown), its sources and the
date it was last verified. For France:

- **Polymarket is blocked**: unauthorised gambling (ANJ), DNS-blocked since
  July 2026; showing its live odds in France is treated as illegal gambling
  advertising. ultrastock neither reads nor paper-trades it for a French
  resident, and never routes around the block.
- **US-domiciled ETFs** are not sold to EU retail (no PRIIPs KID): use the
  UCITS equivalent.
- **Crypto venues** need a MiCA CASP authorisation:
  `jurisdiction verify --out <dir>` checks Binance, Kraken and Coinbase (or
  `--venues …`) against ESMA's register and registers the result as evidence.
- **PEA** eligibility and ceilings; **foreign accounts** (IBKR → form 3916,
  crypto exchanges → 3916-bis) must be declared.

`verify` also prints what no register answers: a search query and the official
sources per rule. Run the searches when a decision depends on a rule, cite what
you find, and tell the user when a rule looks out of date. A jurisdiction with
no rules recorded is **unknown**: everything is readable and paper-tradable,
nothing is live-tradable.
