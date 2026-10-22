// MIA — Supabase Edge Function. Secrets: ANTHROPIC_API_KEY, SUPA_URL, SUPA_SERVICE_KEY
// v16 — wired to GL Deck. Advisor-only. Returns 3 languages x 3 options.
// v18 — sales flow: Stage 0-8 + step-to-close always in the prompt, the advisor's stage chip is used,
//       replies carry optional step / handover / lead fields. Old front ends ignore the new fields.
//       Fix: the Deck search now reads the advisor's text when it is sent as content blocks
//       (gl-mia.html always sends blocks, so v16/v17 never matched a single Deck card).

const MODEL = "claude-opus-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* loaders                                                             */
/* ------------------------------------------------------------------ */

async function rest(url: string, key: string, path: string) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  return await r.json();
}

async function loadKB(url: string, key: string) {
  const rows = await rest(url, key, `gl_mia_kb?select=data&id=eq.kb`);
  return rows?.[0]?.data ?? {};
}

async function loadCatalogue(url: string, key: string) {
  const rows = await rest(
    url,
    key,
    `gl_services?select=category,brand,section,name,subtitle,base_price,price_by_type&hidden=eq.false&order=category,brand,section,name`,
  );
  if (!rows) return "(catalogue unavailable)";

  const money = (n: unknown) => {
    const v = Number(n);
    return Number.isFinite(v) ? String(Math.round(v)) : "";
  };

  const priceOf = (row: Record<string, unknown>) => {
    const pbt = row.price_by_type as Record<string, unknown> | null;
    if (pbt) {
      const parts: string[] = [];
      const push = (label: string, k: string) => {
        const v = money(pbt[k]);
        if (v) parts.push(`${label} ${v}`);
      };
      push("Sedan", "Sedan");
      push("SUV", "SUV");
      push("MPV", "MPV");
      push("Super", "Supercar");
      push("Bike", "Motorcycle");
      if (parts.length) return "RM " + parts.join(" / ");
    }
    const base = money(row.base_price);
    return base ? `RM ${base}` : "price on request";
  };

  const tree: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const row of rows) {
    const cat = (row.category as string) || "Other";
    const brand = (row.brand as string) || "-";
    const sec = (row.section as string) || "-";
    tree[cat] ??= {};
    tree[cat][brand] ??= {};
    tree[cat][brand][sec] ??= [];
    const tag = row.subtitle ? ` [${row.subtitle}]` : "";
    tree[cat][brand][sec].push(`${row.name}${tag} = ${priceOf(row)}`);
  }

  const out: string[] = [];
  for (const cat of Object.keys(tree)) {
    out.push(`\n### ${cat.toUpperCase()}`);
    for (const brand of Object.keys(tree[cat])) {
      if (brand !== "-") out.push(`\n**${brand}**`);
      for (const sec of Object.keys(tree[cat][brand])) {
        if (sec !== "-") out.push(`_${sec}_`);
        out.push(tree[cat][brand][sec].join("\n"));
      }
    }
  }
  return out.join("\n");
}

async function loadStarred(url: string, key: string) {
  const rows = await rest(
    url,
    key,
    `gl_mia_log?select=question,answer&starred=eq.true&order=created_at.desc&limit=6`,
  );
  if (!rows?.length) return "";
  return rows
    .map(
      (x: { question: string; answer: string }, i: number) =>
        `--- APPROVED EXAMPLE ${i + 1} ---\nCUSTOMER SAID:\n${x.question}\n\nWHAT WE SENT:\n${x.answer}`,
    )
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* GL Deck — load once, cache warm, pick the relevant cards            */
/* ------------------------------------------------------------------ */

type Card = {
  slug: string;
  tab: string;
  grp: string | null;
  title: string;
  subtitle: string | null;
  content: Record<string, unknown>;
};

let deckCache: { at: number; cards: Card[] } | null = null;
const DECK_TTL_MS = 5 * 60 * 1000;

async function loadDeck(url: string, key: string): Promise<Card[]> {
  if (deckCache && Date.now() - deckCache.at < DECK_TTL_MS) return deckCache.cards;
  const rows = await rest(
    url,
    key,
    `gl_deck?select=slug,tab,grp,title,subtitle,content&hidden=eq.false&order=tab,sort`,
  );
  const cards: Card[] = rows ?? [];
  deckCache = { at: Date.now(), cards };
  return cards;
}

const STOP = new Set(
  ("the a an and or for to of is are was were be been my your our this that with on in it he she they " +
    "i we you me can could would should do does did got have has had not no yes so if then than " +
    "saya kami kita dia nak dan atau untuk yang ini itu ada tak boleh dengan dari pada je ke lah " +
    "bos encik puan sir maam mam").split(" "),
);

function tokenise(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9一-鿿]+/g) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w),
  );
}

function cardText(c: Card): string {
  const parts: string[] = [c.title, c.subtitle ?? "", c.grp ?? ""];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(c.content);
  return parts.join(" ").toLowerCase();
}

function pickCards(cards: Card[], customerText: string, limit = 6): Card[] {
  const words = tokenise(customerText);
  if (!words.length) return [];
  const scored = cards.map((c) => {
    const hay = cardText(c);
    const title = (c.title + " " + (c.subtitle ?? "")).toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 3;
      else if (hay.includes(w)) score += 1;
    }
    return { c, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

function renderCards(cards: Card[]): string {
  if (!cards.length) return "(no matching card — write from the rules and the catalogue)";
  const block = (label: string, v: unknown) => {
    if (!v || typeof v !== "object") return "";
    const o = v as Record<string, string>;
    return `${label}\nEN: ${o.en ?? ""}\nBM: ${o.bm ?? ""}\nZH: ${o.zh ?? ""}\n`;
  };
  const list = (label: string, v: unknown) => {
    if (!Array.isArray(v) || !v.length) return "";
    return `${label}\n` + v.map((x) => `- ${x}`).join("\n") + "\n";
  };

  return cards
    .map((c) => {
      const k = c.content as Record<string, unknown>;
      const alts = (k.alts ?? {}) as Record<string, unknown>;
      return [
        `### CARD: ${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}   [${c.tab}/${c.grp ?? "-"}]`,
        k.why ? `WHY THEY ASK: ${k.why}` : "",
        block("EXPLAIN VERSION:", k.say ?? k.send),
        block("SHORT VERSION:", alts.short),
        block("RECOMMEND VERSION:", alts.push),
        k.goal ? `GOAL: ${k.goal}` : "",
        k.next ? `MOVE ON WHEN: ${k.next}` : "",
        list("NEVER DO THIS:", k.avoid ?? k.kills),
        list("ADVISOR NOTES:", k.notes),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* v18 — the sales flow, built from the Deck's "close" tab             */
/* ------------------------------------------------------------------ */

// The whole map goes in every call (titles + goal + move-on rule only, no wording),
// so MIA always knows where the chat is and what the next step is.
function flowBlock(cards: Card[]): string {
  const close = cards.filter((c) => c.tab === "close");
  if (!close.length) return "";
  const groups: Record<string, Card[]> = {};
  for (const c of close) (groups[c.grp ?? "-"] ??= []).push(c);

  const detail = (c: Card) => {
    const k = (c.content ?? {}) as Record<string, unknown>;
    const goal = typeof k.goal === "string" && k.goal ? ` Goal: ${k.goal}` : "";
    const next = typeof k.next === "string" && k.next ? ` Move on when: ${k.next}` : "";
    return `${goal}${next}`;
  };

  const out: string[] = [];
  if (groups.flow) {
    out.push(
      "### THE GRANDLAB SALES FLOW (the shape of every enquiry)\n" +
        groups.flow.map((c) => `- ${c.title}.${detail(c)}`).join("\n"),
    );
  }
  for (const g of Object.keys(groups)) {
    if (g === "flow") continue;
    out.push(
      `### STEP TO CLOSE: ${g.toUpperCase()}\n` +
        groups[g].map((c, i) => `${i + 1}. ${c.title}.${detail(c)}`).join("\n"),
    );
  }
  return out.join("\n\n");
}

const FLOW_RULES = `
## HOW TO USE THE SALES FLOW
Every reply moves the customer one step along the flow above. Before writing, work out which stage the
chat is at and what the next step is. Stage 0 to 8 is the shape of every enquiry. The STEP TO CLOSE list
for the service is the detail inside Stages 2 to 5.
- Never skip ahead. No price before the car model is known. No booking ask before real buying intent.
- Never go backwards. If the chat already answers a step, do not ask it again.
- One step per message.

THE PRICE QUESTION CAN COME AT ANY STAGE
Customers ask the price whenever they like. Handle it where it lands, following WHEN TO GIVE THE PRICE:
acknowledge, say the right price is coming and why, and ask the one question you still need. Once they
answer, the very next message carries the figure. Never make a customer ask a third time.

HAND OVER TO JIMMY
Set "handover" to a short reason in English when any of these is true, otherwise "".
- The customer wants a discount near the maximum, or on a product with no discount ceiling.
- A complaint about a finished job.
- They want a price, service or car that is not in the catalogue.
- They ask to speak to the boss, owner or manager.
Still write the replies. The handover tells the advisor to check with Jimmy before sending.

LEAD SOURCE
If the chat shows where the customer came from (a Facebook or Instagram ad, a campaign code such as
DEC-NEWCAR, a promo name, a referral, the app), put it in "lead" in a few words. Otherwise "".
`.trim();

const STAGE_HINT: Record<string, string> = {
  start: "The advisor says this chat has JUST STARTED. It is usually Stage 0 or Stage 1.",
  middle: "The advisor says this chat is IN THE MIDDLE. It is usually Stage 2 or Stage 3.",
  closing: "The advisor says this customer is ALMOST A DEAL. It is usually Stage 4 or Stage 5.",
  quiet: "The advisor says the customer has GONE QUIET. Use Stage 7.",
};

/* ------------------------------------------------------------------ */
/* prompt                                                              */
/* ------------------------------------------------------------------ */

function facts(kb: Record<string, string | Record<string, string>>) {
  const s = (kb.shop ?? {}) as Record<string, string>;
  return `
## THE SHOP
${s.name ?? "GrandLab Detailing"}
${s.address ?? ""}
Hours: ${s.hours ?? ""}
WhatsApp: ${s.whatsapp ?? ""}   Phone: ${s.phone ?? ""}

## FAQ
${kb.faq ?? ""}

## WARRANTY
${kb.warranty ?? ""}

## FILM SPECIFICATIONS AND COLOUR MATCHING
${kb.film_specs ?? ""}

## NOT YET AVAILABLE TO SELL
${kb.coming_soon ?? ""}

## WHY GRANDLAB
${kb.differentiators ?? ""}

## PACKAGE CONTENTS
${kb.packages_contents ?? ""}

## HOW LONG JOBS TAKE
${kb.duration ?? ""}

## CERAMIC COATING DETAILS
${kb.coating_details ?? ""}

## WRAPPING AND COLOUR FILM BRANDS
${kb.wrap_brands ?? ""}

## WINDOW TINT AND THE SMARTTAG ISSUE
${kb.tint_details ?? ""}

## WHEN TO GIVE THE PRICE
${kb.price_timing ?? ""}

## LIVE PROMOTIONS
${kb.promos ?? ""}

## DISCOUNT POLICY - follow this exactly
${kb.discount_policy ?? ""}

## DEPOSITS
${kb.deposit_policy ?? ""}

## ORIGINAL PAINT VERSUS RESPRAY
${kb.paint_knowledge ?? ""}

## HOW TO CLOSE - vary the question
${kb.closing_questions ?? ""}

## THE VISIT OFFER
${kb.visit_offer ?? ""}

## WHAT ACTUALLY WORKS - from real GrandLab chats
${kb.what_works ?? ""}

## WHAT KILLS THE CONVERSATION - from real GrandLab chats
${kb.what_kills_it ?? ""}
`.trim();
}

const HOUSE_RULES = `
## HOUSE VOICE - THIS OVERRIDES EVERYTHING ELSE

Write like a real person thumb-typing on WhatsApp between jobs. Not like an AI.

LENGTH
SHORT: 1 to 3 lines.
EXPLAIN: up to about 6 lines, broken into short paragraphs, never a wall.
RECOMMEND: 2 to 4 lines, ends by asking for something.

BANNED
- Dashes of any kind used as punctuation. Use a comma or a full stop. This is the biggest AI tell.
- Marketing language: worth every ringgit, we always strive, rest assured, we pride ourselves, top-notch.
  If a sentence could go on a poster, delete it.
- Bare questions. Not "What car are you driving?" but "May I know your car model sir?".
- Invented urgency. Never say slots are running out unless it is true.
- More than one emoji. Usually zero.

STYLE
- Contractions. I'd, we're, don't, it's.
- One question per message. Never three.
- Every message ends with a question or a clear next step. Never "just let me know".
- Acknowledge before informing.

HONORIFICS
Mirror what the customer uses. If they call you boss or bos, call them bos back. Otherwise sir, ma'am,
encik, puan, 老板, 老板娘. Address them once or twice, not in every sentence.

BAHASA MELAYU
Casual texting style. Doubled words written with 2: lama2, hari2, betul2, dua2, apa2.
Soften questions with ye: "berapa lama ye?". Mixing English words in is normal and correct.

CHINESE
Naturally shorter and more direct than the English. Do not translate the English sentence by sentence.

THE THREE VERSIONS MUST BE GENUINELY DIFFERENT
SHORT answers the question and asks the next one. Nothing else.
EXPLAIN gives the reasoning, in short paragraphs, then asks.
RECOMMEND says honestly what you would choose and why, then asks for the booking, the photo, the visit
or the go-ahead.
If all three say the same thing at different lengths, rewrite.

PRICE
Price comes last on an open enquiry. Teach, qualify, then quote.
BUT if they came from a price ad and the price for their car is different from the advertised one, say
the correct price in the first reply. Hiding it and revealing it after three questions looks like a
bait and switch.
When you do give a price, show the normal price and the discount percentage, not only a bare final
figure.
Never quote a price that is not in the catalogue. If it is not there, say you will confirm.
Promo prices are quoted exactly as advertised and are never discounted further.

FACTS THAT MUST NEVER BE WRONG
- AXFilm X Series PPF: always state 8.5mil and 8 years warranty whenever you name it.
- One+ is 1 year warranty, GrandLab only, no accident coverage, no yellowing cover, meant to come off
  after about a year.
- G Series is the only AXFilm grade with no accident coverage. K and above include 1 year.
- Coating maintenance keeps the COATING warranty valid. The AXFilm PPF warranty is separate.
- Detailing and a la carte items are fixed price and never discounted.
`.trim();

const OUTPUT_FORMAT = `
You reply with RAW JSON ONLY. No markdown, no code fences, no text before or after the JSON.

You return one of two shapes.

SHAPE 1 - ASK THE ADVISOR TO CONFIRM SOMETHING FIRST
Use this when one missing fact would change the answer.
{
  "type": "clarify",
  "step": { "now": "Stage 2 — Understand the customer", "next": "Find out if the car is collected" },
  "question": "Has the customer collected the car yet?",
  "options": ["Yes, collected", "No, not yet", "Not sure"]
}
Rules for clarify:
- ONE question at a time. Never two.
- 2 to 4 short options. Options are tappable buttons, so keep them under 5 words.
- Ask as many rounds as you need to know where the conversation actually is. Better to ask three
  times and be right than to guess and hand over a reply that does not fit. Usually one to three.
- But every question must change what you would write. If you would send the same message either
  way, do not ask, just answer. Never ask to look thorough.
- Work out what is still missing from the Step To Close flow for that service: collected yet, daily
  or weekend, parking, city or outstation, colour, how long keeping it, budget. Ask for the one that
  is missing AND decides the grade. Do not walk the whole list if the grade is already decided.
- If the advisor already gave the fact, or pasted the whole chat, do not ask for it again.
- If you have asked three times and still cannot tell, answer with your best assumption and say what
  you assumed in the reply's "note".
- If the advisor types anything like "just answer", "terus bagi", or "skip", answer immediately.

SHAPE 2 - THE READY TO SEND MESSAGES
{
  "type": "reply",
  "step": { "now": "Stage 2 — Understand the customer", "next": "Find out parking: roof or sun" },
  "handover": "",
  "lead": "",
  "note": "One short line for the advisor. What you assumed, or which version fits this customer. Never shown to the customer.",
  "en": { "short": "...", "explain": "...", "push": "..." },
  "bm": { "short": "...", "explain": "...", "push": "..." },
  "zh": { "short": "...", "explain": "...", "push": "..." }
}

"step.now" is the stage the chat is at, written exactly as the stage title in the sales flow.
"step.next" is what the message you wrote is trying to get from the customer, in English, under 10 words.
"handover" and "lead" follow HOW TO USE THE SALES FLOW. Use "" when they do not apply.

Every string is plain text ready to paste into WhatsApp. Use \\n for line breaks inside a message.
Never put markdown, bullets or headings inside the messages.
`.trim();

function buildStatic(kb: Record<string, unknown>, cat: string, starred: string, flow: string) {
  // Everything in here is identical on every call, so it is the cacheable prefix.
  return `You are MIA, the senior sales advisor at GrandLab Detailing in Petaling Jaya, Malaysia. Eight years in Malaysian car care: paint correction, detailing, PPF, wrapping, tinting, ceramic coating.

You are NOT talking to the customer. A GrandLab Sales Advisor pastes what the customer said. You hand back ready to send messages. The advisor picks one and sends it.

${OUTPUT_FORMAT}

${HOUSE_RULES}
${flow ? `\n## THE SALES FLOW - from GL Deck, written by Jimmy\n${flow}\n\n${FLOW_RULES}\n` : ""}
${facts(kb as Record<string, string>)}

## CATALOGUE - the only prices you may quote
${cat}
${starred ? `
## APPROVED REPLIES - real GrandLab messages a manager marked as good
Match this voice, length and directness. Reuse the shape, not the exact words.

${starred}` : ""}`;
}

function buildDeckBlock(deck: string, stageHint: string) {
  // Changes with every question, so it must come AFTER the cached prefix.
  return `## GL DECK - THE APPROVED ANSWERS
These cards are the house answers, written and approved by Jimmy. When a card matches the customer's
question, build your reply on that card's wording. Adapt the car model, price and details to this
customer. Do not copy a card that does not fit, and never contradict a card's NEVER DO THIS list.
The advisor notes are for you, never repeat them to the customer.

${deck}${stageHint ? `\n\n## WHERE THE ADVISOR SAYS THIS CHAT IS\n${stageHint} Trust the chat itself if it clearly says otherwise.` : ""}`;
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const SUPA_URL = Deno.env.get("SUPA_URL");
    const SUPA_SERVICE_KEY = Deno.env.get("SUPA_SERVICE_KEY");
    if (!KEY) return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);
    if (!SUPA_URL || !SUPA_SERVICE_KEY) {
      return json({ error: "SUPA_URL or SUPA_SERVICE_KEY secret is not set" }, 500);
    }

    const body = await req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return json({ error: "No messages sent" }, 400);
    const stageHint = typeof body.stage === "string" ? STAGE_HINT[body.stage] ?? "" : "";

    // Search the Deck on the advisor's last two turns, so a short answer to a clarify button
    // ("RM11,900 only") still carries the customer's original message with it.
    const textOf = (m: { content?: unknown }) =>
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
        ? (m.content as { type?: string; text?: string }[])
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ")
        : "";
    const searchText = messages
      .filter((m: { role: string }) => m.role === "user")
      .slice(-2)
      .map(textOf)
      .join(" ");

    const [kb, cat, starred, cards] = await Promise.all([
      loadKB(SUPA_URL, SUPA_SERVICE_KEY),
      loadCatalogue(SUPA_URL, SUPA_SERVICE_KEY),
      loadStarred(SUPA_URL, SUPA_SERVICE_KEY),
      loadDeck(SUPA_URL, SUPA_SERVICE_KEY),
    ]);

    const picked = pickCards(cards, searchText, 6);

    // Two system blocks. The first is identical every call and is cached, so repeat
    // calls in the same conversation read it at 10% of the input rate instead of full price.
    const system = [
      {
        type: "text",
        text: buildStatic(kb, cat, starred, flowBlock(cards)),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: buildDeckBlock(renderCards(picked), stageHint) },
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return json({ error: data?.error?.message || "Anthropic request failed" }, r.status);
    }

    let text = (data.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();

    // the model is told to return raw JSON, but strip fences just in case
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

    let reply: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && (parsed.type === "clarify" || parsed.type === "reply")) reply = parsed;
    } catch {
      reply = null; // front end falls back to showing text
    }

    return json({
      reply,
      text,
      usage: data.usage ?? null,
      cards_used: picked.map((c) => c.slug),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
