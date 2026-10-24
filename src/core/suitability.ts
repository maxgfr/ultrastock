// A suitability questionnaire in the spirit of MiFID II's: horizon, capacity
// for loss, reaction to a fall, experience, goal. The agent asks the user the
// questions as written, records the answers in a JSON file, and `profile
// suitability --answers <file>` turns them into a risk score from 1 to 7 and
// the limits the risk gate will enforce. Deterministic: the same answers give
// the same score, and the score's reasons are printed.
import type { Experience, Limits, Profile } from "./profile.js";

export interface Question {
  id: string;
  text: string;
  textFr: string;
  choices?: Array<{ value: string; label: string; labelFr: string; points: number }>;
  /** A number to type (months, %). */
  numeric?: { min: number; max: number };
}

export const QUESTIONS: Question[] = [
  {
    id: "horizon",
    text: "When will you need most of this money?",
    textFr: "Quand aurez-vous besoin de la majeure partie de cet argent ?",
    choices: [
      { value: "lt2", label: "Within 2 years", labelFr: "Dans moins de 2 ans", points: 0 },
      { value: "2to5", label: "In 2 to 5 years", labelFr: "Dans 2 à 5 ans", points: 1 },
      { value: "5to10", label: "In 5 to 10 years", labelFr: "Dans 5 à 10 ans", points: 2 },
      { value: "gt10", label: "In more than 10 years", labelFr: "Dans plus de 10 ans", points: 3 },
    ],
  },
  {
    id: "drop",
    text: "Your portfolio falls 20% in three months. What do you do?",
    textFr: "Votre portefeuille perd 20 % en trois mois. Que faites-vous ?",
    choices: [
      { value: "sell-all", label: "Sell everything", labelFr: "Je vends tout", points: 0 },
      { value: "sell-some", label: "Sell part of it", labelFr: "J'en vends une partie", points: 1 },
      { value: "hold", label: "Hold and wait", labelFr: "Je conserve et j'attends", points: 2 },
      { value: "buy", label: "Buy more", labelFr: "J'en rachète", points: 3 },
    ],
  },
  {
    id: "maxLoss",
    text: "What is the largest yearly loss you could bear without changing your plans?",
    textFr: "Quelle perte annuelle maximale pourriez-vous supporter sans changer vos projets ?",
    choices: [
      { value: "5", label: "5%", labelFr: "5 %", points: 0 },
      { value: "10", label: "10%", labelFr: "10 %", points: 1 },
      { value: "20", label: "20%", labelFr: "20 %", points: 2 },
      { value: "35", label: "35% or more", labelFr: "35 % ou plus", points: 3 },
    ],
  },
  {
    id: "share",
    text: "What share of your financial savings would this portfolio be?",
    textFr: "Quelle part de votre épargne financière ce portefeuille représente-t-il ?",
    choices: [
      { value: "gt75", label: "More than 75%", labelFr: "Plus de 75 %", points: 0 },
      { value: "50to75", label: "50 to 75%", labelFr: "50 à 75 %", points: 1 },
      { value: "25to50", label: "25 to 50%", labelFr: "25 à 50 %", points: 2 },
      { value: "lt25", label: "Less than 25%", labelFr: "Moins de 25 %", points: 3 },
    ],
  },
  {
    id: "income",
    text: "How stable is your income?",
    textFr: "Vos revenus sont-ils stables ?",
    choices: [
      { value: "unstable", label: "Irregular or uncertain", labelFr: "Irréguliers ou incertains", points: 0 },
      { value: "stable", label: "Stable", labelFr: "Stables", points: 1 },
      { value: "very-stable", label: "Very stable, with a margin", labelFr: "Très stables, avec une marge", points: 2 },
    ],
  },
  {
    id: "goal",
    text: "What is this money for, first of all?",
    textFr: "À quoi sert d'abord cet argent ?",
    choices: [
      { value: "preserve", label: "Preserve it", labelFr: "Le préserver", points: 0 },
      { value: "income", label: "Earn a regular income", labelFr: "Obtenir un revenu régulier", points: 1 },
      { value: "balanced", label: "Grow it steadily", labelFr: "Le faire croître régulièrement", points: 2 },
      { value: "growth", label: "Grow it as much as possible over time", labelFr: "Le faire croître au maximum sur la durée", points: 3 },
      { value: "speculate", label: "Speculate", labelFr: "Spéculer", points: 4 },
    ],
  },
  {
    id: "emergencyFundMonths",
    text: "How many months of expenses do you keep in cash outside this portfolio?",
    textFr: "Combien de mois de dépenses gardez-vous en épargne de précaution, hors de ce portefeuille ?",
    numeric: { min: 0, max: 120 },
  },
  ...(["stocks", "etfs", "crypto", "options", "leverage", "predictionMarkets"] as const).map(
    (k): Question => ({
      id: `experience.${k}`,
      text: `Your experience with ${{ stocks: "individual stocks", etfs: "ETFs", crypto: "crypto-assets", options: "options", leverage: "leverage or margin", predictionMarkets: "prediction markets" }[k]}?`,
      textFr: `Votre expérience des ${{ stocks: "actions en direct", etfs: "ETF", crypto: "crypto-actifs", options: "options", leverage: "effets de levier et marges", predictionMarkets: "marchés de prédiction" }[k]} ?`,
      choices: [
        { value: "none", label: "None", labelFr: "Aucune", points: 0 },
        { value: "basic", label: "Some — I know the risks", labelFr: "Un peu — je connais les risques", points: 0 },
        { value: "experienced", label: "Experienced — several years, real money", labelFr: "Confirmée — plusieurs années, argent réel", points: 0 },
      ],
    }),
  ),
];

export interface SuitabilityResult {
  score: number;
  label: string;
  points: number;
  maxPoints: number;
  reasons: string[];
  warnings: string[];
  limits: Limits;
  constraints: Partial<Profile["constraints"]>;
  experience: Profile["experience"];
  emergencyFundMonths?: number;
  lossTolerancePct?: number;
  horizonYears?: number;
}

const LABELS = ["", "very conservative", "conservative", "cautious", "balanced", "growth", "dynamic", "speculative"];
const HORIZON_YEARS: Record<string, number> = { lt2: 1, "2to5": 3, "5to10": 7, gt10: 15 };

/** Limits by score: tighter for a low score, never wider than a 7. */
const LIMITS_BY_SCORE: Record<number, Limits> = {
  1: {
    maxPositionPct: 3,
    maxSectorPct: 20,
    maxCryptoPct: 0,
    cashBufferPct: 15,
    riskPerTradePct: 0.25,
    maxDailyLossPct: 1,
    maxWeeklyLossPct: 2,
    maxMonthlyLossPct: 4,
    maxOrdersPerDay: 2,
    maxOpenPositions: 10,
  },
  2: {
    maxPositionPct: 4,
    maxSectorPct: 20,
    maxCryptoPct: 2,
    cashBufferPct: 10,
    riskPerTradePct: 0.25,
    maxDailyLossPct: 1.5,
    maxWeeklyLossPct: 3,
    maxMonthlyLossPct: 5,
    maxOrdersPerDay: 2,
    maxOpenPositions: 12,
  },
  3: {
    maxPositionPct: 5,
    maxSectorPct: 25,
    maxCryptoPct: 3,
    cashBufferPct: 8,
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 4,
    maxMonthlyLossPct: 6,
    maxOrdersPerDay: 3,
    maxOpenPositions: 15,
  },
  4: {
    maxPositionPct: 7,
    maxSectorPct: 25,
    maxCryptoPct: 5,
    cashBufferPct: 5,
    riskPerTradePct: 0.75,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 5,
    maxMonthlyLossPct: 8,
    maxOrdersPerDay: 4,
    maxOpenPositions: 20,
  },
  5: {
    maxPositionPct: 10,
    maxSectorPct: 30,
    maxCryptoPct: 10,
    cashBufferPct: 5,
    riskPerTradePct: 1,
    maxDailyLossPct: 3,
    maxWeeklyLossPct: 6,
    maxMonthlyLossPct: 10,
    maxOrdersPerDay: 5,
    maxOpenPositions: 25,
  },
  6: {
    maxPositionPct: 12,
    maxSectorPct: 35,
    maxCryptoPct: 15,
    cashBufferPct: 3,
    riskPerTradePct: 1,
    maxDailyLossPct: 3,
    maxWeeklyLossPct: 7,
    maxMonthlyLossPct: 12,
    maxOrdersPerDay: 6,
    maxOpenPositions: 30,
  },
  7: {
    maxPositionPct: 15,
    maxSectorPct: 40,
    maxCryptoPct: 20,
    cashBufferPct: 2,
    riskPerTradePct: 1.5,
    maxDailyLossPct: 4,
    maxWeeklyLossPct: 8,
    maxMonthlyLossPct: 15,
    maxOrdersPerDay: 8,
    maxOpenPositions: 40,
  },
};

/** Score a set of answers: `{ horizon: "gt10", drop: "hold", …, emergencyFundMonths: 6, "experience.crypto": "basic" }`. */
export function scoreSuitability(answers: Record<string, string | number>): SuitabilityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let points = 0;
  let maxPoints = 0;
  for (const q of QUESTIONS) {
    const a = answers[q.id];
    if (q.id.startsWith("experience.") || q.numeric) continue;
    if (a === undefined) throw new Error(`answer "${q.id}" is missing — ask: ${q.text}`);
    const c = q.choices!.find((x) => x.value === String(a));
    if (!c) throw new Error(`answer "${q.id}" must be one of ${q.choices!.map((x) => x.value).join(", ")}, not "${a}"`);
    points += c.points;
    maxPoints += Math.max(...q.choices!.map((x) => x.points));
    reasons.push(`${q.id}: ${c.label} (+${c.points})`);
  }
  // 0…18 points onto 1…7, then capped by the weakest link: a short horizon or a
  // panic seller cannot be "dynamic" whatever the other answers say.
  let score = 1 + Math.round((points / maxPoints) * 6);
  if (answers.horizon === "lt2") {
    score = Math.min(score, 2);
    reasons.push("capped at 2: the money is needed within two years");
  }
  if (answers.drop === "sell-all") {
    score = Math.min(score, 3);
    reasons.push("capped at 3: a 20% fall would end the plan");
  }
  if (answers.maxLoss === "5") {
    score = Math.min(score, 2);
    reasons.push("capped at 2: a 5% yearly loss is the limit");
  }
  const months = answers.emergencyFundMonths === undefined ? undefined : Number(answers.emergencyFundMonths);
  if (months === undefined || !Number.isFinite(months)) warnings.push("emergency fund unknown — ask how many months of expenses are kept in cash");
  else if (months < 3) {
    score = Math.min(score, 2);
    warnings.push(`only ${months} month(s) of expenses in cash: build a 3–6 month emergency fund before investing at risk`);
  }
  const experience = Object.fromEntries(
    (["stocks", "etfs", "crypto", "options", "leverage", "predictionMarkets"] as const).map((k) => {
      const v = String(answers[`experience.${k}`] ?? "none");
      if (v !== "none" && v !== "basic" && v !== "experienced") throw new Error(`answer "experience.${k}" must be none, basic or experienced, not "${v}"`);
      return [k, v as Experience];
    }),
  ) as Profile["experience"];
  const limits = { ...LIMITS_BY_SCORE[score]! };
  if (experience.crypto === "none") {
    limits.maxCryptoPct = Math.min(limits.maxCryptoPct, 2);
    reasons.push("crypto capped at 2%: no experience with crypto-assets");
  }
  const constraints: Partial<Profile["constraints"]> = {
    allowOptions: experience.options === "experienced" && score >= 5,
    allowLeverage: experience.leverage === "experienced" && score >= 6,
    allowShort: experience.leverage === "experienced" && score >= 6,
    allowPredictionMarkets: experience.predictionMarkets !== "none" && score >= 5,
  };
  return {
    score,
    label: LABELS[score]!,
    points,
    maxPoints,
    reasons,
    warnings,
    limits,
    constraints,
    experience,
    emergencyFundMonths: months,
    lossTolerancePct: answers.maxLoss !== undefined ? Number(answers.maxLoss) : undefined,
    horizonYears: typeof answers.horizon === "string" ? HORIZON_YEARS[answers.horizon] : undefined,
  };
}

/** Apply a suitability result to a profile, recording every change. */
export function applySuitability(p: Profile, r: SuitabilityResult, now = new Date()): void {
  const record = (path: string, from: unknown, to: unknown) => p.history.push({ at: now.toISOString(), path, from, to });
  record("riskScore", p.riskScore, r.score);
  p.riskScore = r.score;
  p.riskLabel = r.label;
  record("limits", p.limits, r.limits);
  p.limits = r.limits;
  p.constraints = { ...p.constraints, ...r.constraints };
  p.experience = r.experience;
  if (r.emergencyFundMonths !== undefined) p.emergencyFundMonths = r.emergencyFundMonths;
  if (r.lossTolerancePct !== undefined) p.lossTolerancePct = r.lossTolerancePct;
  if (r.horizonYears !== undefined) p.horizonYears = r.horizonYears;
  p.updatedAt = now.toISOString();
}
