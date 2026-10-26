// The valuations `analyze --depth full` adds to the DCF: residual income (fit
// for banks and insurers, where free cash flow means little), the Gordon
// dividend discount model (for a dividend payer), and the WACC the DCF's cost
// of equity sits inside. Each one reads only evidence `valuation` already
// registered — price, P/B, ROE, payout, dividend yield, cost of equity, net
// debt, the risk-free rate — and registers its result as a derived [E#] with
// its inputs and its assumptions in the formula. An input missing is a model
// skipped, said in a note, never a value guessed.
import { type EvidenceItem, EvidenceStore, formatEvidence } from "../core/evidence.js";
import { gordonValue, residualIncome, wacc } from "../analytics/fundamentals.js";

export interface ExtraValuation {
  lines: string[];
  notes: string[];
  count: number;
}

const KD_SPREAD = 0.015;
const TAX = 0.25;
const RI_YEARS = 5;
const RI_PERSISTENCE = 0.6;
const DDM_G_CAP = 0.03;

export function extendedValuation(dir: string, sym: string): ExtraValuation {
  const store = EvidenceStore.load(dir);
  const notes: string[] = [];
  const lines: string[] = [];
  if (!store) return { lines, notes: ["no evidence in the run: no valuation to extend"], count: 0 };
  const get = (key: string) => store.byKey(key);
  const n = (i?: EvidenceItem) => (i && typeof i.value === "number" && Number.isFinite(i.value) ? i.value : undefined);
  const price = get(`${sym}.quote.price`);
  const coe = get(`${sym}.coe`);
  const roe = get(`${sym}.quality.roe`);
  const payout = get(`${sym}.quality.payoutRatio`);
  const pb = get(`${sym}.mult.pb`);
  const dy = get(`${sym}.mult.dividendYield`);
  const mcap = get(`${sym}.mult.marketCap`);
  const netDebt = get(`${sym}.quality.netDebt`);
  const rf = store.items.find((i) => /\.(ust|aaa)\.10Y$/.test(i.key) && typeof i.value === "number");
  const P = n(price);
  const r = n(coe) !== undefined ? n(coe)! / 100 : undefined;
  const ccy = price?.unit;
  const added: string[] = [];
  const derive = (key: string, label: string, value: number, unit: string | undefined, inputs: Array<EvidenceItem | undefined>, formula: string) =>
    added.push(
      store.addDerived(
        key,
        label,
        value,
        unit,
        inputs.filter((x): x is EvidenceItem => !!x).map((x) => x.id),
        formula,
      ),
    );
  if (P === undefined || r === undefined) {
    return { lines, notes: ["the valuation slice registered no price or cost of equity: residual income, DDM and WACC skipped"], count: 0 };
  }
  const payoutRatio = n(payout) !== undefined ? Math.min(Math.max(n(payout)!, 0), 1) : undefined;

  // Residual income: book + discounted excess returns, fading after the explicit years.
  const ROE = n(roe);
  const PB = n(pb);
  if (ROE !== undefined && PB !== undefined && PB > 0) {
    const book = P / PB;
    const v = residualIncome(book, Array(RI_YEARS).fill(ROE), r, payoutRatio ?? 0, RI_PERSISTENCE);
    if (Number.isFinite(v) && v > 0) {
      derive(
        `${sym}.val.residualIncome`,
        `${sym} residual-income value per share`,
        v,
        ccy,
        [price, pb, roe, coe, payout],
        `book (price / P/B) + Σ (ROE − r) × book over ${RI_YEARS} years at the current ROE, then fading at ${RI_PERSISTENCE} a year; payout ${payoutRatio === undefined ? "0 assumed" : "as reported"}`,
      );
      derive(
        `${sym}.val.residualIncome.vsPrice`,
        `${sym} residual-income value vs price`,
        (v / P - 1) * 100,
        "%",
        [price, ...added.slice(-1).map((id) => store.get(id))],
        "(value / price − 1) × 100",
      );
    } else notes.push("residual income: no positive value (ROE below the cost of equity erodes book value)");
    if (payoutRatio === undefined) notes.push("residual income: no payout ratio registered — all earnings assumed retained");
  } else notes.push("residual income skipped: no ROE or P/B registered");

  // Gordon dividend discount: D1 / (r − g), g capped and below r.
  const DY = n(dy);
  if (DY !== undefined && DY > 0) {
    const sustainable = ROE !== undefined && payoutRatio !== undefined ? ROE * (1 - payoutRatio) : DDM_G_CAP;
    const g = Math.min(sustainable, DDM_G_CAP, r - 0.01);
    const d0 = P * DY;
    const v = gordonValue(d0 * (1 + g), r, g);
    derive(
      `${sym}.val.ddm`,
      `${sym} dividend discount (Gordon) value per share`,
      v,
      ccy,
      [price, dy, coe, roe, payout],
      `D0 (price × dividend yield) × (1 + g) / (r − g), g = min(ROE × (1 − payout), ${DDM_G_CAP * 100} %, r − 1 pt) = ${(g * 100).toFixed(2)} %`,
    );
    derive(
      `${sym}.val.ddm.vsPrice`,
      `${sym} dividend discount value vs price`,
      (v / P - 1) * 100,
      "%",
      [price, ...added.slice(-1).map((id) => store.get(id))],
      "(value / price − 1) × 100",
    );
  } else notes.push("dividend discount model skipped: no dividend yield registered (not a dividend payer, or no dividend in the statements)");

  // WACC: equity at market, net debt as the debt proxy, cost of debt = rf + a spread.
  const E = n(mcap);
  const RF = n(rf) !== undefined ? n(rf)! / 100 : undefined;
  if (E !== undefined && E > 0 && RF !== undefined) {
    const D = Math.max(0, n(netDebt) ?? 0);
    const kd = RF + KD_SPREAD;
    derive(
      `${sym}.val.wacc`,
      `${sym} weighted average cost of capital`,
      wacc(E, D, r, kd, TAX) * 100,
      "%",
      [mcap, netDebt, coe, rf],
      `E/(E+D) × cost of equity + D/(E+D) × (rf + ${KD_SPREAD * 100} pt) × (1 − ${TAX * 100} % tax); D = net debt (0 when net cash) — the spread and the tax rate are assumptions`,
    );
  } else notes.push("WACC skipped: no market capitalisation or risk-free rate registered");
  store.save();
  for (const id of added) lines.push(`- ${formatEvidence(store.get(id)!)}`);
  return { lines, notes, count: added.length };
}
