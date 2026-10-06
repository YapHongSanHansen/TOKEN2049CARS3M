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

// Sensitive categories are never sold, not even redacted.
const WITHHELD: Array<[string, RegExp]> = [
  ["health", /\b(diagnos\w*|therap(y|ist)|medication|prescription|cancer|depress\w*|anxiety|pregnan\w*|hiv|clinic|hospital|surgery)\b/i],
  ["credentials", /\b(password|passcode|pin code|seed phrase|mnemonic|private key|otp)\b/i],
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
  // "my girlfriend Sarah's", "my mom's", "our landlord" -> [PERSON]
  const relation = RELATIONS.map(r => r.replace(/[-\s]/g, "[-\\s]?")).join("|");
  out = out.replace(new RegExp(`\\b(?:my|our|his|her|their)\\s+(?:${relation})(?:\\s+[A-Z][a-z]+)?(?:'s)?\\b`, "gi"), () => { count(replacements, "person"); return "[PERSON]"; });
  // Remaining capitalised words that do not start a sentence: assume names/places.
  out = out.replace(/(^|[.!?]\s+|\s)([A-Z][a-z]+(?:'s)?)\b/g, (match, prefix: string, word: string) => {
    const sentenceStart = prefix === "" || /[.!?]\s+$/.test(prefix);
    if (sentenceStart || SAFE_WORDS.has(word) || SAFE_WORDS.has(word.replace(/'s$/, ""))) return match;
    count(replacements, "name");
    return `${prefix}[NAME]`;
  });
  // Sentence-initial names are caught only when followed by a possessive or verb-ish cue.
  out = out.replace(/^([A-Z][a-z]+)('s|\s+(?:said|says|wants|told|asked|is|was))\b/g, (match, word: string, rest: string) => {
    if (SAFE_WORDS.has(word) || ["My", "The", "Our", "Can", "Should", "What", "When", "Where", "How", "Why", "Need", "Please", "Remind", "Find", "Book", "Buy", "Get", "Help"].includes(word)) return match;
    count(replacements, "name");
    return `[NAME]${rest}`;
  });
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
