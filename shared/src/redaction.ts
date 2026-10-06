/**
 * Deterministic redaction: strips people, dates, contact details, addresses
 * and account numbers, withholds sensitive categories outright, and keeps only
 * coarse intent signals (what an enterprise would pay for). Over-redaction is
 * the safe failure mode, so any capitalised word mid-sentence is treated as a
 * name unless it is a known safe word.
 */

export interface RedactedMessage { redacted: string; intents: string[]; withheld?: string }
export interface RedactedBundle {
  version: 1;
  messages: RedactedMessage[];
  stats: { messages: number; withheld: number; replacements: Record<string, number>; intents: Record<string, number> };
}

const RELATIONS = [
  "girlfriend", "boyfriend", "wife", "husband", "partner", "fiance", "fiancee", "mom", "mum", "mother", "dad", "father",
  "sister", "brother", "son", "daughter", "kid", "kids", "friend", "bestie", "best friend", "boss", "manager", "colleague",
  "coworker", "co-worker", "grandma", "grandmother", "grandpa", "grandfather", "aunt", "uncle", "cousin", "landlord",
  "neighbor", "neighbour", "ex", "roommate", "flatmate", "teacher", "doctor",
];
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const SAFE_WORDS = new Set([
  "I", "I'm", "I've", "I'll", "I'd", "OK", "Ok", "ADA", "USD", "USDM", "BTC", "ETH", "NFT", "DEX", "AI", "TV", "PM", "AM",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Christmas", "Easter", "Valentine's", "Valentine",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
]);

/** Common given names (English, Malay, Chinese, Indian) — masked wherever they appear. */
const FIRST_NAMES = new Set(`Aaron Abdul Adam Adrian Ahmad Aisha Alex Alice Alicia Aliya Amanda Amir Amy Andrew Angela Anna Anthony Arif Arjun Ashley Aziz
  Ben Benjamin Bob Brandon Brian Carol Caroline Charles Charlotte Chloe Chris Christina Christopher Daniel David Deepak Diana Dylan Edward Eleanor Elizabeth Emily Emma Eric Ethan Eve Faizal Farah Fatimah Grace Hafiz
  Hannah Hana Harry Hassan Henry Ian Isaac Isabella Ismail Jack Jacob James Jane Jason Jasmine Jennifer Jessica John Jonathan Joseph Joshua Julia Justin Karen Kate Kevin Kumar Laura Lauren Lily Linda Lisa
  Lucas Lucy Mark Mary Matthew Mei Melissa Michael Michelle Ming Mohamed Mohammed Muhammad Nadia Natalie Nicholas Nicole Noah Nur Nurul Olivia Omar Patrick Paul Peter Priya Rachel Rahul Raj Rajesh Ravi Rebecca
  Richard Robert Ryan Sam Samantha Sarah Sean Siti Sophia Steven Susan Thomas Tim Timothy Tom Victoria Vincent Wei William Yusuf Zara Zoe`.split(/\s+/));
/** Proper nouns that are places, so their possessive ("Singapore's") is kept. */
const PLACE_WORDS = new Set(["Singapore", "Malaysia", "Bali", "Bangkok", "Tokyo", "London", "Penang", "Jakarta", "Geylang", "Cardano", "Masumi", "Minswap"]);

// Sensitive categories are never sold, not even redacted.
const WITHHELD: Array<[string, RegExp]> = [
  ["health", /\b(diagnos\w*|therap(y|ist)|medication|prescription|cancer|depress\w*|anxiety|pregnan\w*|hiv|clinic|hospital|surgery)\b/i],
  ["credentials", /\b(password|passcode|pin code|seed phrase|mnemonic|private key|otp)\b/i],
  // API keys and tokens: CARSEM keys, OpenAI/Anthropic/Stripe, GitHub, Slack, AWS, bearer headers, .env lines.
  ["credentials", /\bcsm_[\w-]{16,}|\b(?:sk|pk|rk)[-_](?:live_|test_|proj-|ant-)?[\w-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[\w.~+/-]{16,}|\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|MNEMONIC|PASSWORD)=\S+|\b(?:api[ _-]?key|secret key|access token|auth token)\b/i],
  ["religion_politics", /\b(church|mosque|temple|synagogue|vote[ds]? for|election)\b/i],
];

const INTENTS: Array<[string, RegExp]> = [
  ["birthday gift — budget intent", /\b(birthday|anniversary|gift|present)\b/i],
  ["travel intent", /\b(flight|hotel|trip|travel|vacation|holiday|airbnb|visa)\b/i],
  ["housing intent", /\b(rent|mortgage|apartment|condo|lease|move house|moving)\b/i],
  ["career intent", /\b(job|salary|interview|promotion|resume|cv|hiring)\b/i],
  ["electronics purchase intent", /\b(phone|laptop|iphone|macbook|headphones|console|camera)\b/i],
  ["dining intent", /\b(restaurant|dinner|lunch|brunch|cafe|reservation)\b/i],
  ["fashion purchase intent", /\b(dress|shoes|sneakers|watch|bag|jewel\w*|ring|necklace)\b/i],
  ["investing intent", /\b(invest\w*|stock|crypto|token|staking|yield|portfolio)\b/i],
  ["purchase intent", /\b(buy|budget|price|cost|deal|discount|order|\$\s?\d+|\d+\s?(usd|dollars|rm|sgd))\b/i],
];

const PATTERNS: Array<[string, RegExp, string]> = [
  ["email", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  ["url", /\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[URL]"],
  ["wallet", /\b(addr(_test)?1[0-9a-z]{20,}|0x[0-9a-fA-F]{40})\b/g, "[WALLET]"],
  ["date", new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?`, "gi"), "[DATE]"],
  ["date", new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), "[DATE]"],
  ["date", /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, "[DATE]"],
  ["account", /\b(?:\d[ -]?){12,19}\b/g, "[ACCOUNT]"],
  ["phone", /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{3,4}\b/g, "[PHONE]"],
  ["address", /\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Jalan|Jln|Lorong)\b\.?/g, "[ADDRESS]"],
  ["address", /\b(?:Jalan|Jln|Lorong)\s+[A-Z][\w ]{1,30}/g, "[ADDRESS]"],
  ["age", /\b(?:I'?m|I am|aged?)\s+\d{1,3}(?:\s+years? old)?\b/gi, "[AGE]"],
];

function count(stats: Record<string, number>, key: string, by = 1) { stats[key] = (stats[key] ?? 0) + by; }

export function redactMessage(text: string, replacements: Record<string, number> = {}): RedactedMessage {
  const intents = INTENTS.filter(([, re]) => re.test(text)).map(([name]) => name);
  for (const [category, re] of WITHHELD) {
    if (re.test(text)) {
      count(replacements, `withheld:${category}`);
      return { redacted: `[WITHHELD: ${category}]`, intents: [], withheld: category };
    }
  }
  let out = text;
  for (const [kind, re, token] of PATTERNS) {
    out = out.replace(re, () => { count(replacements, kind); return token; });
  }
  // People, not places or products: "Kuala Lumpur", "Singapore Geylang" and "Pokemon Pack"
  // are what the data is worth; names of people are what must go.
  const name = (match: string) => { count(replacements, "name"); return match; };
  // 1. Relationships: "my girlfriend Sarah's", "my mom", "our landlord John" -> [PERSON]
  const relation = RELATIONS.map(r => r.replace(/[-\s]/g, "[-\\s]?")).join("|");
  out = out.replace(new RegExp(`\\b(?:my|our|his|her|their)\\s+(?:${relation})(?:\\s+[A-Z][a-z]+)?(?:'s)?\\b`, "gi"), () => { count(replacements, "person"); return "[PERSON]"; });
  // 2. People you interact with: "call Sarah", "email Ahmad", "meet Wei Ming".
  // The verb is case-insensitive; the name must be Capitalised (so "call at 5pm" is untouched).
  const verbs = ["call", "text", "message", "email", "e-mail", "tell", "ask", "meet", "invite", "pay", "send", "ping", "dm", "thank"]
    .map(v => `[${v[0].toUpperCase()}${v[0]}]${v.slice(1)}`).join("|");
  out = out.replace(new RegExp(`\\b(${verbs})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\b`, "g"), (match, verb: string, who: string) =>
    SAFE_WORDS.has(who.split(" ")[0]) || PLACE_WORDS.has(who.split(" ")[0]) ? match : name(`${verb} [NAME]`));
  // 3. Possessives that are not places or things we know: "Sarah's".
  out = out.replace(/\b([A-Z][a-z]+)'s\b/g, (match, word: string) => (SAFE_WORDS.has(word) || PLACE_WORDS.has(word) ? match : name("[NAME]")));
  // 4. Common first names anywhere.
  out = out.replace(/\b([A-Z][a-z]+)\b/g, (match, word: string) => (FIRST_NAMES.has(word) ? name("[NAME]") : match));
  return { redacted: out.replace(/\s{2,}/g, " ").trim(), intents };
}

export function redactChats(chats: string[]): RedactedBundle {
  const replacements: Record<string, number> = {};
  const intents: Record<string, number> = {};
  const messages = chats.map(chat => chat.trim()).filter(Boolean).map(chat => redactMessage(chat, replacements));
  for (const message of messages) for (const intent of message.intents) count(intents, intent);
  return {
    version: 1,
    messages,
    stats: { messages: messages.length, withheld: messages.filter(m => m.withheld).length, replacements, intents },
  };
}

/** One display line per message, e.g. "[PERSON] birthday on [DATE] — birthday gift — budget intent". */
export const displayLine = (m: RedactedMessage) => (m.intents.length ? `${m.redacted} — ${m.intents.join("; ")}` : m.redacted);
