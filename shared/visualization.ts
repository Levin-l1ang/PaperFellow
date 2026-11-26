import { z } from 'zod';

type Op = 'add' | 'sub' | 'mul' | 'div' | 'pow' | 'log' | 'exp' | 'sqrt' | 'abs';
type Expression = number | { var: string } | { op: Op; args: Expression[] };
const binary = ['add', 'sub', 'mul', 'div', 'pow'] as const;
const unary = ['log', 'exp', 'sqrt', 'abs'] as const;
const label = z.string().min(1).max(140);
const coordinate = z.number().finite().min(-1e12).max(1e12);
const controlId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/);
const control = z.discriminatedUnion('kind', [
  z.object({ id: controlId, label, kind: z.literal('slider'), min: coordinate, max: coordinate, step: coordinate.positive(), value: coordinate }).strict(),
  z.object({ id: controlId, label, kind: z.literal('select'), options: z.array(z.object({ label, value: coordinate }).strict()).min(1).max(16), value: coordinate }).strict(),
]);

function expressionSchema(depth: number): z.ZodType<Expression> {
  const atom = z.union([coordinate, z.object({ var: controlId }).strict()]);
  if (depth === 0) return atom;
  return z.union([atom, z.object({ op: z.enum([...binary, ...unary]), args: z.array(z.lazy(() => expressionSchema(depth - 1))).min(1).max(2) }).strict()
    .refine(({ op, args }) => args.length === ((unary as readonly string[]).includes(op) ? 1 : 2))]);
}

const common = { title: label, xLabel: label, yLabel: label, caption: z.string().max(300).optional() };
const series = z.array(z.object({ name: label, points: z.array(z.object({ x: coordinate, y: coordinate, value: coordinate.optional() }).strict()).min(1).max(500) }).strict()).min(1).max(6);
const schema = z.union([
  z.object({ ...common, kind: z.enum(['bar', 'line', 'scatter', 'heatmap']), series }).strict()
    .refine((spec) => spec.kind !== 'heatmap' || (spec.series.length === 1 && spec.series[0].points.every((p) => p.value !== undefined) &&
      new Set(spec.series[0].points.map((p) => p.x)).size <= 24 && new Set(spec.series[0].points.map((p) => p.y)).size <= 24)),
  z.object({ ...common, kind: z.literal('demo'), domain: z.tuple([coordinate, coordinate]),
    controls: z.array(control).min(1).max(8), expr: expressionSchema(9) }).strict().superRefine((spec, ctx) => {
    const ids = new Set(['x']);
    let valid = spec.domain[0] < spec.domain[1];
    for (const item of spec.controls) {
      if (ids.has(item.id)) valid = false;
      ids.add(item.id);
      if (item.kind === 'slider') valid &&= item.min < item.max && item.min <= item.value && item.value <= item.max && (item.max - item.min) / item.step <= 50_000;
      else valid &&= item.options.some((option) => option.value === item.value) && new Set(item.options.map((option) => option.value)).size === item.options.length;
    }
    let nodes = 0;
    function walk(expression: Expression) {
      nodes++;
      if (typeof expression === 'number') return;
      if ('var' in expression) { if (!ids.has(expression.var)) valid = false; }
      else expression.args.forEach(walk);
    }
    walk(spec.expr);
    if (!valid || nodes > 160) ctx.addIssue({ code: 'custom', message: '表达式或交互参数无效。' });
  }),
]);

export type Visualization = z.infer<typeof schema>;

export function parseVisualization(source: string): Visualization | null {
  if (source.length > 100_000) return null;
  try {
    const result = schema.safeParse(JSON.parse(source));
    return result.success ? result.data : null;
  } catch { return null; }
}

export function evaluate(expression: Expression, variables: Record<string, number>): number {
  if (typeof expression === 'number') return expression;
  if ('var' in expression) return variables[expression.var];
  const [a, b] = expression.args.map((part) => evaluate(part, variables));
  switch (expression.op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return a / b;
    case 'pow': return Math.pow(a, b);
    case 'log': return Math.log(a);
    case 'exp': return Math.exp(a);
    case 'sqrt': return Math.sqrt(a);
    case 'abs': return Math.abs(a);
  }
}
