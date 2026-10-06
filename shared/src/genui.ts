/**
 * CARSEM's generative UI, in OpenUI Lang (@openuidev). The agent answers with UI, not only text:
 * data cards, the paywall, the loan, the trade and receipts, with buttons that send a message back.
 *
 * The component schemas live here, once. The agent (Node) builds the library without renderers to
 * generate and validate OpenUI Lang; the web app builds it again with React renderers to draw it.
 * OpenUI Lang arguments are positional, in the schema's key order, so required keys come first.
 */
import { createLibrary, createParser, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";

export const TONES = ["default", "muted", "good", "bad", "warn"] as const;
const tone = z.enum(TONES).optional();
const tx = z.object({ hash: z.string(), url: z.string().optional() }).optional();

/** Schemas in positional order. `children` entries name other components. */
export const UI_SCHEMAS = {
  Text: { description: "A short paragraph.", props: z.object({ text: z.string(), tone }) },
  Stat: { description: "One figure with a label.", props: z.object({ label: z.string(), value: z.string(), tone }) },
  Button: { description: "A button. Without an action it sends its label to the agent as the user's next message.", props: z.object({ label: z.string(), action: z.any().optional(), variant: z.enum(["primary", "secondary"]).optional() }) },
  DataCard: {
    description: "A CARSEM dataset: a trading signal or a flight / hotel / product price. rows are the data fields; locked means they are behind the paywall.",
    props: z.object({ title: z.string(), meta: z.string(), rows: z.array(z.object({ label: z.string(), value: z.string() })), locked: z.boolean().optional(), tx }),
  },
  Paywall: { description: "An x402 paywall the agent cannot afford.", props: z.object({ title: z.string(), price: z.string(), balance: z.string(), shortfall: z.string() }) },
  LoanCard: {
    description: "A CARSEM collateral loan.",
    props: z.object({ loanId: z.string(), amount: z.string(), fee: z.string(), due: z.string(), deadline: z.string(), collateral: z.string(), status: z.enum(["open", "repaid", "defaulted"]) }),
  },
  TradeCard: { description: "A DEX trade made on a signal.", props: z.object({ pair: z.string(), side: z.string(), outcome: z.enum(["win", "loss"]), pnl: z.string(), venue: z.string(), tx }) },
  Receipt: { description: "A payment that settled.", props: z.object({ title: z.string(), amount: z.string(), tx }) },
} as const;
export type UiName = keyof typeof UI_SCHEMAS | "Actions" | "Stack";
const LEAVES = Object.keys(UI_SCHEMAS) as Array<keyof typeof UI_SCHEMAS>;

type Define = (config: { name: string; description: string; props: z.ZodObject<z.ZodRawShape>; component: unknown }) => { ref: z.ZodType };
type Create = (definition: { components: unknown[]; root: string }) => unknown;

/**
 * Builds the library for one runtime: lang-core (`component: null`) on the agent, react-lang with
 * renderers in the browser. Both get the same components, so what the agent writes, the page renders.
 */
export function buildUiLibrary<L>(define: Define, create: Create, renderers: Partial<Record<UiName, unknown>> = {}): L {
  const made: Record<string, ReturnType<Define>> = {};
  for (const name of LEAVES) made[name] = define({ name, description: UI_SCHEMAS[name].description, props: UI_SCHEMAS[name].props, component: renderers[name] ?? null });
  made.Actions = define({ name: "Actions", description: "A row of buttons.", props: z.object({ children: z.array(made.Button.ref) }), component: renderers.Actions ?? null });
  const leafRefs = LEAVES.map(name => made[name].ref);
  made.Stack = define({
    name: "Stack", description: "The root: its children stack vertically.",
    props: z.object({ children: z.array(z.union([...leafRefs, made.Actions.ref] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])) }),
    component: renderers.Stack ?? null,
  });
  return create({ components: Object.values(made), root: "Stack" }) as L;
}

// ---- writing OpenUI Lang (the agent) -------------------------------------------------------

/** A piece of OpenUI Lang code (a component call) that can be nested in another call. */
export class UiCode { constructor(readonly code: string) {} }
const literal = (value: unknown): string => {
  if (value instanceof UiCode) return value.code;
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${literal(v)}`).join(", ")}}`;
  return JSON.stringify(value ?? null);
};
/** `Name(arg, arg, …)`: args in schema order; trailing undefineds are dropped, inner ones become null. */
function call(name: UiName, ...args: unknown[]): UiCode {
  let last = args.length;
  while (last > 0 && args[last - 1] === undefined) last--;
  return new UiCode(`${name}(${args.slice(0, last).map(literal).join(", ")})`);
}
type Props<N extends keyof typeof UI_SCHEMAS> = z.infer<(typeof UI_SCHEMAS)[N]["props"]>;
const ordered = <N extends keyof typeof UI_SCHEMAS>(name: N, props: Props<N>) => call(name, ...Object.keys(UI_SCHEMAS[name].props.shape).map(key => (props as Record<string, unknown>)[key]));

/** Sends `message` to the agent as the user's next message when the button is pressed. */
export const toAgent = (message: string, context?: string) => new UiCode(`Action([@ToAssistant(${literal(message)}${context ? `, ${literal(context)}` : ""})])`);
export const openUrl = (url: string) => new UiCode(`Action([@OpenUrl(${literal(url)})])`);

export const ui = {
  text: (props: Props<"Text">) => ordered("Text", props),
  stat: (props: Props<"Stat">) => ordered("Stat", props),
  button: (label: string, action?: UiCode, variant?: "primary" | "secondary") => call("Button", label, action, variant),
  dataCard: (props: Props<"DataCard">) => ordered("DataCard", props),
  paywall: (props: Props<"Paywall">) => ordered("Paywall", props),
  loan: (props: Props<"LoanCard">) => ordered("LoanCard", props),
  trade: (props: Props<"TradeCard">) => ordered("TradeCard", props),
  receipt: (props: Props<"Receipt">) => ordered("Receipt", props),
  actions: (buttons: UiCode[]) => call("Actions", buttons),
  /** A complete program: `root = Stack([...])`. */
  stack: (children: UiCode[]) => `root = ${call("Stack", children).code}`,
};

// ---- checking OpenUI Lang (the agent, tests) ---------------------------------------------

let parser: ReturnType<typeof createParser> | undefined;
/** Parses a program against the CARSEM library; `ok` means it will render in full. */
export function checkUi(code: string): { ok: boolean; errors: string[] } {
  if (!parser) {
    const library = coreLibrary<{ toJSONSchema(): unknown; root: string }>();
    parser = createParser(library.toJSONSchema() as Parameters<typeof createParser>[0], library.root);
  }
  const result = parser.parse(code) as { root: unknown; meta: { errors: Array<{ message?: string; code?: string }>; unresolved: unknown[]; orphaned: unknown[]; incomplete?: boolean } };
  const errors = result.meta.errors.map(e => e.message ?? e.code ?? "error");
  if (!result.root) errors.push("no root");
  if (result.meta.unresolved.length) errors.push(`unresolved: ${result.meta.unresolved.length}`);
  if (result.meta.orphaned.length) errors.push(`orphaned: ${result.meta.orphaned.length}`);
  if (result.meta.incomplete) errors.push("incomplete");
  return { ok: errors.length === 0, errors };
}

/** The library without renderers (Node): for parsing and the prompt. */
const coreLibrary = <L>() => buildUiLibrary<L>(defineComponent as unknown as Define, createLibrary as unknown as Create);

/** The system-prompt section that teaches an LLM brain to answer in OpenUI Lang. */
export function uiPrompt(): string {
  const library = coreLibrary<{ prompt(options: Record<string, unknown>): string }>();
  return library.prompt({
    preamble: "When you have something to show (data, a paywall, a loan, a trade, a receipt), answer with OpenUI Lang in a ```openui fenced block, then one or two plain sentences. Buttons send their label (or ToAssistant message) back to you as the user's next message.",
    examples: [
      'root = Stack([card, acts])\ncard = DataCard("MIN/ADA trading signal", "Trading signal · 5 USDM · WhaleWatcher 88%", [{"label": "Direction", "value": "LONG"}, {"label": "Confidence", "value": "82%"}], false)\nacts = Actions([Button("Trade it", Action([@ToAssistant("Trade the MIN signal")]), "primary")])',
    ],
  });
}
