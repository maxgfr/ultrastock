// One small, safe expression language for everything that takes a formula:
// `calc` (derived figures), alert rules, strategy conditions and screen filters.
//
// A tokenizer and a recursive-descent parser — never `eval`, never `Function`:
// these strings come from an agent, and an agent reads news, filings and
// prediction-market questions that may carry instructions. The language can
// only read the variables it is handed and call the functions listed below.
//
//   rsi14 < 30 and close > sma200          comparison and logic
//   (E3 / E7 - 1) * 100                    arithmetic over evidence ids
//   macd.histogram > macd.histogram[-1]    a series one bar back
//   pct(close, high52w)                    a whitelisted function
//
// A variable that is missing makes the whole expression `undefined` — an alert
// on missing data does not fire, and a calc on a missing figure is refused.

export type Value = number | boolean | undefined;

type Node =
  | { t: "num"; v: number }
  | { t: "var"; name: string; offset: number }
  | { t: "un"; op: "-" | "not"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

export interface ExprEnv {
  /** The value of `name`, `offset` bars back (0 = now, -1 = previous). */
  get(name: string, offset: number): number | boolean | undefined;
}

export class ExprError extends Error {}

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...x: number[]) => number }> = {
  abs: { arity: [1, 1], fn: Math.abs },
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  ln: { arity: [1, 1], fn: Math.log },
  log10: { arity: [1, 1], fn: Math.log10 },
  exp: { arity: [1, 1], fn: Math.exp },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  min: { arity: [1, 32], fn: Math.min },
  max: { arity: [1, 32], fn: Math.max },
  round: { arity: [1, 2], fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  /** Percentage change from b to a: (a / b - 1) × 100. */
  pct: { arity: [2, 2], fn: (a, b) => (a / b - 1) * 100 },
  /** a as a percentage of b: a / b × 100. */
  share: { arity: [2, 2], fn: (a, b) => (a / b) * 100 },
  /** Compound annual growth from b to a over n years, in %. */
  cagr: { arity: [3, 3], fn: (a, b, n) => ((a / b) ** (1 / n) - 1) * 100 },
};

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(?:<=|>=|==|!=|&&|\|\||[-+*/%^<>()!,[\]])/.exec(src.slice(i));
    if (op) {
      out.push({ k: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new ExprError(`unexpected "${ch}" at position ${i + 1}`);
  }
  return out;
}

/** Parse once, evaluate many times. Throws ExprError on a malformed expression. */
export function compileExpr(src: string): Node {
  if (src.length > 2000) throw new ExprError("expression too long (2000 characters max)");
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  const isWord = (v: string) => peek()?.k === "id" && String(peek()!.v).toLowerCase() === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"${peek() ? ` before "${String(peek()!.v)}"` : " at the end"}`);
    p++;
  };

  const parseOr = (): Node => {
    let a = parseAnd();
    while (isOp("||") || isWord("or")) {
      p++;
      a = { t: "bin", op: "or", a, b: parseAnd() };
    }
    return a;
  };
  const parseAnd = (): Node => {
    let a = parseNot();
    while (isOp("&&") || isWord("and")) {
      p++;
      a = { t: "bin", op: "and", a, b: parseNot() };
    }
    return a;
  };
  const parseNot = (): Node => {
    if (isOp("!") || isWord("not")) {
      p++;
      return { t: "un", op: "not", a: parseNot() };
    }
    return parseCmp();
  };
  const parseCmp = (): Node => {
    const a = parseAdd();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (isOp(op)) {
        p++;
        return { t: "bin", op, a, b: parseAdd() };
      }
    }
    return a;
  };
  const parseAdd = (): Node => {
    let a = parseMul();
    while (isOp("+") || isOp("-")) {
      const op = String(toks[p++]!.v);
      a = { t: "bin", op, a, b: parseMul() };
    }
    return a;
  };
  const parseMul = (): Node => {
    let a = parseUnary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = String(toks[p++]!.v);
      a = { t: "bin", op, a, b: parseUnary() };
    }
    return a;
  };
  const parseUnary = (): Node => {
    if (isOp("-")) {
      p++;
      return { t: "un", op: "-", a: parseUnary() };
    }
    if (isOp("+")) {
      p++;
      return parseUnary();
    }
    return parsePow();
  };
  const parsePow = (): Node => {
    const base = parsePrimary();
    if (isOp("^")) {
      p++;
      return { t: "bin", op: "^", a: base, b: parseUnary() };
    }
    return base;
  };
  const parsePrimary = (): Node => {
    const tok = peek();
    if (!tok) throw new ExprError("expression ends too early");
    if (tok.k === "num") {
      p++;
      return { t: "num", v: tok.v };
    }
    if (tok.k === "op" && tok.v === "(") {
      p++;
      const inner = parseOr();
      expect(")");
      return inner;
    }
    if (tok.k === "id") {
      p++;
      const name = tok.v;
      if (/^(true|false)$/i.test(name)) return { t: "num", v: name.toLowerCase() === "true" ? 1 : 0 };
      if (isOp("(")) {
        p++;
        const fn = name.toLowerCase();
        const def = Object.hasOwn(FUNCTIONS, fn) ? FUNCTIONS[fn] : undefined;
        if (!def) throw new ExprError(`unknown function "${name}" — available: ${Object.keys(FUNCTIONS).join(", ")}`);
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(parseOr());
          while (isOp(",")) {
            p++;
            args.push(parseOr());
          }
        }
        expect(")");
        if (args.length < def.arity[0] || args.length > def.arity[1]) throw new ExprError(`${fn}() takes ${def.arity.join("–")} arguments, got ${args.length}`);
        return { t: "call", fn, args };
      }
      let offset = 0;
      if (isOp("[")) {
        p++;
        let neg = 1;
        if (isOp("-")) {
          p++;
          neg = -1;
        }
        const n = peek();
        if (n?.k !== "num" || !Number.isInteger(n.v)) throw new ExprError(`${name}[…] takes a whole number of bars back, like ${name}[-1]`);
        p++;
        offset = neg * n.v;
        if (offset > 0) throw new ExprError(`${name}[${offset}] looks into the future — a lookback is ${name}[-${offset}]`);
        expect("]");
      }
      return { t: "var", name, offset };
    }
    throw new ExprError(`unexpected "${tok.v}"`);
  };

  const ast = parseOr();
  if (p < toks.length) throw new ExprError(`unexpected "${String(toks[p]!.v)}" after a complete expression`);
  return ast;
}

const num = (v: Value): number | undefined => (v === undefined ? undefined : typeof v === "boolean" ? (v ? 1 : 0) : v);

/** Evaluate a compiled expression. `undefined` when any variable it reads is missing or the result is not finite. */
export function evaluateExpr(node: Node, envr: ExprEnv): Value {
  const go = (n: Node): Value => {
    switch (n.t) {
      case "num":
        return n.v;
      case "var": {
        const v = envr.get(n.name, n.offset);
        return typeof v === "number" && !Number.isFinite(v) ? undefined : v;
      }
      case "un": {
        const a = go(n.a);
        if (a === undefined) return undefined;
        return n.op === "not" ? !truthy(a) : -num(a)!;
      }
      case "call": {
        const args = n.args.map((x) => num(go(x)));
        if (args.some((x) => x === undefined)) return undefined;
        const r = FUNCTIONS[n.fn]!.fn(...(args as number[]));
        return Number.isFinite(r) ? r : undefined;
      }
      case "bin": {
        if (n.op === "and") {
          const a = go(n.a);
          if (a === undefined) return undefined;
          if (!truthy(a)) return false;
          const b = go(n.b);
          return b === undefined ? undefined : truthy(b);
        }
        if (n.op === "or") {
          const a = go(n.a);
          if (a !== undefined && truthy(a)) return true;
          const b = go(n.b);
          if (b === undefined) return a === undefined ? undefined : false;
          return truthy(b);
        }
        const a = num(go(n.a));
        const b = num(go(n.b));
        if (a === undefined || b === undefined) return undefined;
        let r: number | boolean;
        switch (n.op) {
          case "+":
            r = a + b;
            break;
          case "-":
            r = a - b;
            break;
          case "*":
            r = a * b;
            break;
          case "/":
            r = a / b;
            break;
          case "%":
            r = a % b;
            break;
          case "^":
            r = a ** b;
            break;
          case "<":
            r = a < b;
            break;
          case "<=":
            r = a <= b;
            break;
          case ">":
            r = a > b;
            break;
          case ">=":
            r = a >= b;
            break;
          case "==":
            r = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
            break;
          case "!=":
            r = Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
            break;
          default:
            throw new ExprError(`unknown operator ${n.op}`);
        }
        return typeof r === "number" && !Number.isFinite(r) ? undefined : r;
      }
    }
  };
  return go(node);
}

function truthy(v: number | boolean): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

/** Every variable an expression reads, for "which evidence does this calc use". */
export function exprVariables(node: Node): string[] {
  const seen = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === "var") seen.add(n.name);
    else if (n.t === "un") walk(n.a);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    } else if (n.t === "call") n.args.forEach(walk);
  };
  walk(node);
  return [...seen];
}

export type CompiledExpr = Node;
