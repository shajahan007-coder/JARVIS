const https = require("https");
const { create, all } = require("mathjs");

// ---------- Sandboxed math (mathjs with dangerous functions disabled) ----------
const math = create(all);
const evaluateExpression = math.evaluate;
const disabled = () => {
  throw new Error("Function is disabled");
};
math.import(
  {
    import: disabled,
    createUnit: disabled,
    evaluate: disabled,
    parse: disabled,
    simplify: disabled,
    derivative: disabled,
    resolve: disabled,
  },
  { override: true },
);

const SAFE_EXPRESSION = /^[A-Za-z0-9_\s+\-*/^%().,]+$/;
const BLOCKED_NAMES =
  /\b(factorial|gamma|lgamma|permutations|combinations|zeros|ones|identity|range|matrix)\b/i;

// ---------- HTTP helper (IPv4, timeout, size cap, User-Agent) ----------
function httpJson(
  url,
  { method = "GET", headers = {}, body, timeout = 10000 } = {},
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      url,
      {
        method,
        family: 4,
        timeout,
        headers: {
          "User-Agent": "JarvisAssistant/1.0 (student project)",
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 1000000)
            req.destroy(new Error("Response too large"));
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withRetry(fn, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.error(
        `Request attempt ${i + 1} failed:`,
        err.message,
        err.code || "",
      );
      if (i === retries) throw err;
    }
  }
}

const clip = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// ---------- Prompt addition ----------
const EXTRA_PROMPT = `EXTRA TOOLS: use search_knowledge for current events, news, sports results, prices, or any fact you are unsure of; write the query in English, and summarize the result in 1-3 short sentences without reading URLs aloud. Use daily_briefing for "good morning" or "brief me" and summarize the date, weather, pending to-dos and next reminders in 3-4 short sentences. Use play_youtube for "play X". Use calculate for math and unit conversions (convert percentages to decimals first, e.g. 18% of 2450 becomes 0.18 * 2450). Use convert_currency for money conversion with ISO codes (INR, USD, EUR).`;

// ---------- Factory (receives helpers and models from index.js) ----------
function createExtraTools({
  getWeather,
  formatIst,
  cleanText,
  Todo,
  Reminder,
}) {
  const definitions = [
    {
      type: "function",
      function: {
        name: "search_knowledge",
        description:
          "Search the internet for current facts or news. Returns a short answer.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query in English" },
            news: { type: "boolean", description: "True for recent news" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "daily_briefing",
        description:
          "Morning briefing: date, weather, pending to-dos and upcoming reminders.",
        parameters: {
          type: "object",
          properties: {
            city: {
              type: "string",
              description: "City in English letters, default Madurai",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "play_youtube",
        description: "Open YouTube search results for a song or video.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: 'What to play, e.g. "Anirudh songs"',
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "calculate",
        description:
          'Evaluate math or unit conversion, e.g. "0.18 * 2450", "sqrt(144)", "5 km to mile", "72 degF to degC".',
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "Expression in mathjs syntax",
            },
          },
          required: ["expression"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "convert_currency",
        description: "Convert money between currencies using live rates.",
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            from: { type: "string", description: "ISO code, e.g. USD" },
            to: { type: "string", description: "ISO code, e.g. INR" },
          },
          required: ["amount", "from", "to"],
        },
      },
    },
  ];

  // --- Web search: Tavily when a key is set, otherwise Wikipedia ---
  async function searchTavily(query, news) {
    const data = await withRetry(() =>
      httpJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: {
          query,
          topic: news ? "news" : "general",
          search_depth: "basic",
          max_results: 3,
          include_answer: true,
        },
      }),
    );
    return {
      source: "web",
      answer: clip(data.answer, 600),
      results: (data.results || [])
        .slice(0, 3)
        .map((r) => ({
          title: clip(r.title, 90),
          snippet: clip(r.content, 250),
        })),
    };
  }

  async function searchWikipedia(query) {
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=1&prop=extracts" +
      `&exintro=1&explaintext=1&exchars=700&format=json&formatversion=2&gsrsearch=${encodeURIComponent(query)}`;
    const data = await withRetry(() => httpJson(url));
    const page = data.query?.pages?.[0];
    if (!page?.extract)
      return { source: "wikipedia", note: "No results found" };
    return {
      source: "wikipedia",
      title: clip(page.title, 90),
      summary: clip(page.extract, 700),
      note: "Wikipedia only, may be out of date for recent events",
    };
  }

  async function searchKnowledge({ query, news }) {
    const q = cleanText(query, 200);
    if (!q) return { result: { error: "Query required" } };

    try {
      if (process.env.TAVILY_API_KEY) {
        try {
          return { result: await searchTavily(q, news === true) };
        } catch (err) {
          console.error(
            "Tavily failed, falling back to Wikipedia:",
            err.message,
          );
        }
      }
      return { result: await searchWikipedia(q) };
    } catch {
      return { result: { error: "Search service unreachable" } };
    }
  }

  // --- Daily briefing ---
  async function dailyBriefing({ city }, { sessionId }) {
    const now = new Date();
    const [weather, todos, reminders] = await Promise.all([
      getWeather({ city: cleanText(city) || "Madurai" })
        .then((r) => r.result)
        .catch(() => ({ error: "Weather unavailable" })),
      Todo.find({ sessionId, done: false })
        .sort({ createdAt: 1 })
        .limit(10)
        .lean(),
      Reminder.find({ sessionId, status: "pending" })
        .sort({ dueAt: 1 })
        .limit(5)
        .lean(),
    ]);

    return {
      result: {
        today: new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "full",
        }).format(now),
        time_ist: new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          timeStyle: "short",
        }).format(now),
        weather,
        pending_todos: todos.map((t) => t.text),
        upcoming_reminders: reminders.map((r) => ({
          text: r.text,
          due_ist: formatIst(r.dueAt),
        })),
      },
    };
  }

  // --- YouTube ---
  async function playYoutube({ query }) {
    const q = cleanText(query, 150);
    if (!q) return { result: { error: "Query required" } };
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    return {
      result: { ok: true, opened: `YouTube results for ${q}` },
      action: { type: "open_url", url, label: `YouTube: ${q}` },
    };
  }

  // --- Calculator and unit conversion ---
  async function calculate({ expression }) {
    const expr = cleanText(expression, 200);
    if (!expr) return { result: { error: "Expression required" } };
    if (!SAFE_EXPRESSION.test(expr) || BLOCKED_NAMES.test(expr)) {
      return { result: { error: "Unsupported expression" } };
    }

    try {
      const value = evaluateExpression(expr);
      if (value === undefined || typeof value === "function") {
        return { result: { error: "Could not evaluate that" } };
      }
      return {
        result: {
          expression: expr,
          answer: math.format(value, { precision: 10 }),
        },
      };
    } catch {
      return { result: { error: "Could not evaluate that" } };
    }
  }

  // --- Currency ---
  async function convertCurrency({ amount, from, to }) {
    const amt = Number(amount);
    const base = String(from || "")
      .trim()
      .toUpperCase();
    const target = String(to || "")
      .trim()
      .toUpperCase();

    if (!Number.isFinite(amt) || amt < 0 || amt > 1e12)
      return { result: { error: "Invalid amount" } };
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(target)) {
      return {
        result: { error: "Use 3-letter currency codes like USD and INR" },
      };
    }
    if (base === target)
      return {
        result: {
          amount: amt,
          from: base,
          to: target,
          converted: amt,
          rate: 1,
        },
      };

    const endpoints = [
      `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${target}`,
      `https://api.frankfurter.app/latest?from=${base}&to=${target}`,
    ];

    for (const url of endpoints) {
      try {
        const data = await httpJson(url, { timeout: 8000 });
        const rate = data.rates?.[target];
        if (typeof rate === "number") {
          return {
            result: {
              amount: amt,
              from: base,
              to: target,
              rate,
              converted: Math.round(amt * rate * 100) / 100,
              as_of: data.date,
            },
          };
        }
      } catch (err) {
        console.error("Currency lookup failed:", err.message);
      }
    }
    return {
      result: {
        error: "Currency service unreachable or currency not supported",
      },
    };
  }

  const functions = {
    search_knowledge: searchKnowledge,
    daily_briefing: dailyBriefing,
    play_youtube: playYoutube,
    calculate,
    convert_currency: convertCurrency,
  };

  return { definitions, functions };
}

module.exports = { createExtraTools, EXTRA_PROMPT };
