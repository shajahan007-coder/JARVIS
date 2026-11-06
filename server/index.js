require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const { spawn } = require('child_process');
const { createExtraTools, EXTRA_PROMPT } = require("./extraTools");

const app = express();
const applySecurity = require("./security");
applySecurity(app);

const { router: authRouter, requireAuth } = require('./auth');
app.use('/auth', authRouter);
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(requireAuth); // every route registered below this line needs a valid login


const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, MONGO_URI } = process.env;

// ---------- Models ----------
const MessageSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true }
}, { timestamps: true });
MessageSchema.index({ sessionId: 1, createdAt: -1 });

const FactSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    text: { type: String, required: true, maxlength: 200 }
}, { timestamps: true });

const TodoSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, index: true },
    text: { type: String, required: true, maxlength: 200 },
    done: { type: Boolean, default: false }
}, { timestamps: true });

const ReminderSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    text: { type: String, required: true, maxlength: 200 },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'fired', 'cancelled'], default: 'pending' }
}, { timestamps: true });
ReminderSchema.index({ sessionId: 1, status: 1, dueAt: 1 });

const Message = mongoose.model('Message', MessageSchema);
const Fact = mongoose.model('Fact', FactSchema);
const Todo = mongoose.model('Todo', TodoSchema);
const Reminder = mongoose.model('Reminder', ReminderSchema);

const HISTORY_LIMIT = 8;    // messages sent to the LLM (kept small to stay under Groq's tokens-per-minute limit)
const MAX_FACTS = 50;
const MAX_TODOS = 100;
const MAX_REMINDERS = 50;
const MIN_REMINDER_MINUTES = 0.25;        // 15 seconds
const MAX_REMINDER_MINUTES = 7 * 24 * 60; // 7 days
const IST_OFFSET_MS = 330 * 60 * 1000;    // India has no daylight saving
const LLM_MAX_RETRIES = 3;                // retries when the provider answers 429 (rate limit)

const isValidSession = (id) => typeof id === 'string' && id.length >= 10 && id.length <= 100;

// ---------- Allowed PC apps (Windows). Add entries here to allow more. ----------
// Format: name -> [executable, args]. Only these can ever be launched.
const APPS = {
    notepad: ['notepad.exe', []],
    calculator: ['calc.exe', []],
    paint: ['mspaint.exe', []],
    'file explorer': ['explorer.exe', []],
    'task manager': ['taskmgr.exe', []],
    'vs code': ['cmd.exe', ['/c', 'code']],
    chrome: ['cmd.exe', ['/c', 'start', '', 'chrome']],
    edge: ['cmd.exe', ['/c', 'start', '', 'msedge']]
};
const APP_NAMES = Object.keys(APPS);

// ---------- Languages ----------
const LANGUAGES = ['en', 'ta', 'tanglish'];
const LANGUAGE_PROMPTS = {
    en: '',
    ta: `
LANGUAGE: The user wants Tamil. Reply ONLY in Tamil script (தமிழ்), in simple spoken Tamil, 1-3 short sentences. Address the user as "சார்" occasionally.
Keep code, identifiers, URLs, numbers and technical terms in English. For tool arguments, write city names, app names and URLs in English letters; keep to-do and reminder text in the language the user used.
The user's speech is transcribed from Tamil audio, so English words may appear in Tamil letters (for example "வெதர்" means weather, "டைம்" means time, "ரிமைண்டர்" means reminder). Interpret them accordingly.`,
    tanglish: `
LANGUAGE: The user speaks Tanglish (Tamil mixed with English). Reply in Tanglish: casual spoken Tamil written in English letters with common English words mixed in, for example "Seri sir, reminder set pannitten." Never use Tamil script. Keep it to 1-3 short sentences.
Keep code, identifiers, URLs and technical terms in English. For tool arguments, write city names, app names and URLs in English letters.
The user's speech may be transcribed in Tamil letters, so English words may appear transliterated (for example "வெதர்" means weather). Interpret them accordingly.`
};

// ---------- Prompt ----------
const buildSystemPrompt = (
  facts,
  language = "en",
) => `You are J.A.R.V.I.S., a witty, highly capable AI assistant.You are Created By Shajahan with help of cluade.
Address the user as "sir" occasionally. For casual chat and commands, keep replies short (1-3 sentences) because they will be spoken aloud.
Be dry and clever, never rude. If you don't know something, say so.
You have tools: get_current_time, get_weather, open_website, search_web, remember_fact, forget_fact, add_todo, list_todos, complete_todo, remove_todo, open_app, set_reminder, list_reminders, cancel_reminder.
Use them whenever the user asks for the time, weather, to open a site, to search, to remember/forget something, to manage their to-do list, to open a PC app, or to set/list/cancel reminders and timers. Never guess these.
Use as few tool calls as possible: normally exactly one per request, then reply. Never call list or remove tools before an add unless the user asks for it.
Use remember_fact when the user says "remember..." or shares a lasting personal detail (name, preferences, goals).
Use the to-do tools for tasks and lists ("add X to my list", "what's on my list", "mark X done", "remove X"). For "add X", call add_todo directly once. When listing, read items naturally in one or two sentences.
open_app only works for the listed apps; if the user asks for another app, say you are not permitted to open it.
REMINDERS AND TIMERS: use set_reminder. For relative times ("in 10 minutes", "in 2 hours", "in 30 seconds") convert to minutes and pass in_minutes (30 seconds = 0.5). For clock times ("at 5 pm", "at 17:30") pass at_time as 24-hour HH:MM in IST. Keep the reminder text short and without the time (e.g. "drink water"). For a plain timer, use text like "Your 10 minute timer is done". Confirm briefly, e.g. "Reminder set for 5 PM, sir."
After using a tool, confirm briefly in one sentence (e.g. "Opening YouTube, sir.").
The user is in India (IST) unless they say otherwise.
Speech recognition may write "weather" as "whether"; interpret it from context. If the user asks about weather without a city, use Madurai.
STUDY MODE: When the user asks you to explain a programming or computer science concept, write code, or debug code (Java, Python, data structures, algorithms, web dev), give a clear step-by-step answer in under 200 words of explanation.
Put ALL code inside fenced markdown blocks with a language tag (for example \`\`\`java or \`\`\`python). Use numbered steps, not markdown tables.
Start with one plain sentence that directly answers or summarizes, because that sentence will be spoken aloud.
${EXTRA_PROMPT}
${LANGUAGE_PROMPTS[language] || ""}
${facts.length ? `\nKnown facts about the user:\n${facts.map((f) => `- ${f.text}`).join("\n")}` : ""}`;

// ---------- Tool definitions ----------
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_current_time',
            description: 'Get the current date and time.',
            parameters: {
                type: 'object',
                properties: {
                    timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Kolkata. Defaults to Asia/Kolkata.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get the current weather for a city.',
            parameters: {
                type: 'object',
                properties: { city: { type: 'string', description: 'City name in English letters, e.g. Madurai' } },
                required: ['city']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'open_website',
            description: 'Open a website in a new browser tab.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', description: 'Full URL, e.g. https://www.youtube.com' } },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Search Google in a new browser tab.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'The search query' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remember_fact',
            description: 'Save a lasting fact about the user so it is remembered in future conversations.',
            parameters: {
                type: 'object',
                properties: { fact: { type: 'string', description: 'Short fact, e.g. "User\'s name is Shaha"' } },
                required: ['fact']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'forget_fact',
            description: 'Delete a saved fact about the user.',
            parameters: {
                type: 'object',
                properties: { fact: { type: 'string', description: 'Keywords or text of the fact to forget' } },
                required: ['fact']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'add_todo',
            description: 'Add an item to the user\'s to-do list.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'The task, e.g. "Buy milk"' } },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_todos',
            description: 'List the user\'s pending and completed to-do items.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'complete_todo',
            description: 'Mark a to-do item as done.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Keywords from the task to complete' } },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remove_todo',
            description: 'Delete a to-do item.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Keywords from the task to delete' } },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'open_app',
            description: 'Open an application on the user\'s PC.',
            parameters: {
                type: 'object',
                properties: { name: { type: 'string', enum: APP_NAMES, description: 'Which app to open' } },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_reminder',
            description: 'Set a reminder or timer. Provide EITHER in_minutes (relative) OR at_time (clock time in IST).',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'What to remind the user about, e.g. "drink water"' },
                    in_minutes: { type: 'number', description: 'Minutes from now (0.25 to 10080). 30 seconds = 0.5, 2 hours = 120.' },
                    at_time: { type: 'string', description: '24-hour clock time in IST, format HH:MM, e.g. "17:30". Next occurrence is used.' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_reminders',
            description: 'List the user\'s upcoming (pending) reminders and timers.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancel_reminder',
            description: 'Cancel an upcoming reminder or timer.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Keywords from the reminder to cancel' } },
                required: ['text']
            }
        }
    }
];

// ---------- Helpers ----------
const WEATHER_CODES = {
    0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail'
};

// IPv4-only HTTPS GET with timeout and one retry (fixes "fetch failed" on some networks)
function fetchJson(url, retries = 1) {
    const attempt = () =>
        new Promise((resolve, reject) => {
            const req = https.get(url, { family: 4, timeout: 8000 }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        });

    return (async () => {
        for (let i = 0; i <= retries; i++) {
            try {
                return await attempt();
            } catch (err) {
                console.error(`fetchJson attempt ${i + 1} failed:`, err.message, err.code || '');
                if (i === retries) throw err;
            }
        }
    })();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanText = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const matchItems = (items, needle) => items.filter((i) => i.text.toLowerCase().includes(needle.toLowerCase()));

const formatIst = (date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(date);

// Next time the given HH:MM occurs in IST (today if still ahead, otherwise tomorrow)
const nextIstOccurrence = (hours, minutes) => {
    const now = Date.now();
    const ist = new Date(now + IST_OFFSET_MS);
    let target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hours, minutes) - IST_OFFSET_MS;
    if (target <= now + 15000) target += 24 * 60 * 60 * 1000;
    return new Date(target);
};

// ---------- Tool implementations ----------
async function getTime({ timezone }) {
    const tz = timezone || 'Asia/Kolkata';
    try {
        const text = new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
        return { result: { timezone: tz, now: text } };
    } catch {
        return { result: { error: `Invalid timezone: ${tz}` } };
    }
}

async function getWeather({ city }) {
    const query = cleanText(city) || 'Madurai';
    const candidates = [...new Set([query, query.split(',')[0].trim(), query.split(/\s+/)[0]])].filter(Boolean);

    let place = null;
    try {
        for (const name of candidates) {
            const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`);
            place = geo.results?.[0];
            if (place) break;
        }
    } catch {
        return { result: { error: 'Weather service unreachable' } };
    }
    if (!place) return { result: { error: `Could not find city: ${query}` } };

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code`;
        const w = await fetchJson(url);
        const c = w.current;
        if (!c) return { result: { error: 'Weather data unavailable' } };

        return {
            result: {
                location: `${place.name}, ${place.country}`,
                temperature_c: c.temperature_2m,
                feels_like_c: c.apparent_temperature,
                humidity_percent: c.relative_humidity_2m,
                wind_kmh: c.wind_speed_10m,
                condition: WEATHER_CODES[c.weather_code] || 'unknown'
            }
        };
    } catch {
        return { result: { error: 'Weather service unreachable' } };
    }
}

async function openWebsite({ url }) {
    try {
        const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
        return { result: { ok: true, opened: parsed.hostname }, action: { type: 'open_url', url: parsed.href, label: parsed.hostname } };
    } catch {
        return { result: { error: 'Invalid URL' } };
    }
}

async function searchWeb({ query }) {
    if (!query) return { result: { error: 'Query required' } };
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return { result: { ok: true, searched: query }, action: { type: 'open_url', url, label: `Search: ${query}` } };
}

async function rememberFact({ fact }, { sessionId }) {
    const text = cleanText(fact);
    if (!text) return { result: { error: 'Fact required' } };

    const existing = await Fact.find({ sessionId }).lean();
    if (existing.some((f) => f.text.toLowerCase() === text.toLowerCase())) {
        return { result: { ok: true, note: 'Already remembered' } };
    }
    if (existing.length >= MAX_FACTS) {
        return { result: { error: `Memory full (${MAX_FACTS} facts). Ask the user to forget something.` } };
    }

    await Fact.create({ sessionId, text });
    return { result: { ok: true, saved: text } };
}

async function forgetFact({ fact }, { sessionId }) {
    const needle = cleanText(fact);
    if (!needle) return { result: { error: 'Fact required' } };

    const facts = await Fact.find({ sessionId }).lean();
    const ids = matchItems(facts, needle).map((f) => f._id);
    if (!ids.length) return { result: { ok: false, note: 'No matching fact found' } };

    await Fact.deleteMany({ _id: { $in: ids } });
    return { result: { ok: true, forgotten: ids.length } };
}

async function addTodo({ text }, { sessionId }) {
    const task = cleanText(text);
    if (!task) return { result: { error: 'Task text required' } };

    const items = await Todo.find({ sessionId }).lean();
    if (items.length >= MAX_TODOS) {
        return { result: { error: `List is full (${MAX_TODOS} items). Remove some first.` } };
    }
    if (items.some((i) => !i.done && i.text.toLowerCase() === task.toLowerCase())) {
        return { result: { ok: true, note: 'Already on the list' } };
    }

    await Todo.create({ sessionId, text: task });
    return { result: { ok: true, added: task } };
}

async function listTodos(_args, { sessionId }) {
    const items = await Todo.find({ sessionId }).sort({ createdAt: 1 }).lean();
    return {
        result: {
            pending: items.filter((i) => !i.done).map((i) => i.text),
            completed: items.filter((i) => i.done).map((i) => i.text)
        }
    };
}

async function completeTodo({ text }, { sessionId }) {
    const needle = cleanText(text);
    if (!needle) return { result: { error: 'Task text required' } };

    const pending = await Todo.find({ sessionId, done: false }).lean();
    const matches = matchItems(pending, needle);
    if (!matches.length) return { result: { ok: false, note: 'No matching pending task' } };
    if (matches.length > 1) {
        return { result: { ok: false, note: 'Multiple matches, ask which one', matches: matches.map((m) => m.text) } };
    }

    await Todo.updateOne({ _id: matches[0]._id }, { done: true });
    return { result: { ok: true, completed: matches[0].text } };
}

async function removeTodo({ text }, { sessionId }) {
    const needle = cleanText(text);
    if (!needle) return { result: { error: 'Task text required' } };

    const items = await Todo.find({ sessionId }).lean();
    const matches = matchItems(items, needle);
    if (!matches.length) return { result: { ok: false, note: 'No matching task' } };
    if (matches.length > 1) {
        return { result: { ok: false, note: 'Multiple matches, ask which one', matches: matches.map((m) => m.text) } };
    }

    await Todo.deleteOne({ _id: matches[0]._id });
    return { result: { ok: true, removed: matches[0].text } };
}

async function openApp({ name }) {
    if (process.env.ENABLE_OPEN_APP === "false") {
        return {
            result: { error: "Opening apps is disabled on this server" },
        };
    }
    if (process.platform !== 'win32') {
        return { result: { error: 'Opening apps is only set up for Windows' } };
    }
    const key = cleanText(name, 50).toLowerCase();
    const entry = APPS[key];
    if (!entry) {
        return { result: { error: `Not permitted. Allowed apps: ${APP_NAMES.join(', ')}` } };
    }

    const [file, args] = entry;
    return new Promise((resolve) => {
        try {
            const child = spawn(file, args, { detached: true, stdio: 'ignore' });
            child.once('error', (err) => {
                console.error(`open_app ${key} failed:`, err.message);
                resolve({ result: { error: `Could not open ${key}` } });
            });
            child.once('spawn', () => {
                child.unref();
                resolve({ result: { ok: true, opened: key } });
            });
        } catch (err) {
            console.error(`open_app ${key} failed:`, err.message);
            resolve({ result: { error: `Could not open ${key}` } });
        }
    });
}

async function setReminder({ text, in_minutes, at_time }, { sessionId }) {
    const task = cleanText(text);
    if (!task) return { result: { error: 'Reminder text required' } };

    let dueAt;
    if (in_minutes !== undefined && in_minutes !== null && in_minutes !== '') {
        const minutes = Number(in_minutes);
        if (!Number.isFinite(minutes) || minutes < MIN_REMINDER_MINUTES || minutes > MAX_REMINDER_MINUTES) {
            return { result: { error: `in_minutes must be between ${MIN_REMINDER_MINUTES} and ${MAX_REMINDER_MINUTES}` } };
        }
        dueAt = new Date(Date.now() + minutes * 60 * 1000);
    } else if (typeof at_time === 'string') {
        const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at_time.trim());
        if (!match) return { result: { error: 'at_time must be 24-hour HH:MM, e.g. 17:30' } };
        dueAt = nextIstOccurrence(Number(match[1]), Number(match[2]));
    } else {
        return { result: { error: 'Provide in_minutes or at_time' } };
    }

    const pending = await Reminder.countDocuments({ sessionId, status: 'pending' });
    if (pending >= MAX_REMINDERS) {
        return { result: { error: `Too many pending reminders (${MAX_REMINDERS}). Cancel some first.` } };
    }

    await Reminder.create({ sessionId, text: task, dueAt });
    return {
        result: {
            ok: true,
            reminder: task,
            due_ist: formatIst(dueAt),
            starts_in_minutes: Math.round(((dueAt.getTime() - Date.now()) / 60000) * 10) / 10
        }
    };
}

async function listReminders(_args, { sessionId }) {
    const items = await Reminder.find({ sessionId, status: 'pending' }).sort({ dueAt: 1 }).lean();
    return { result: { upcoming: items.map((r) => ({ text: r.text, due_ist: formatIst(r.dueAt) })) } };
}

async function cancelReminder({ text }, { sessionId }) {
    const needle = cleanText(text);
    if (!needle) return { result: { error: 'Reminder text required' } };

    const pending = await Reminder.find({ sessionId, status: 'pending' }).lean();
    const matches = matchItems(pending, needle);
    if (!matches.length) return { result: { ok: false, note: 'No matching reminder' } };
    if (matches.length > 1) {
        return { result: { ok: false, note: 'Multiple matches, ask which one', matches: matches.map((m) => m.text) } };
    }

    await Reminder.updateOne({ _id: matches[0]._id }, { status: 'cancelled' });
    return { result: { ok: true, cancelled: matches[0].text } };
}

const TOOL_FUNCTIONS = {
    get_current_time: getTime,
    get_weather: getWeather,
    open_website: openWebsite,
    search_web: searchWeb,
    remember_fact: rememberFact,
    forget_fact: forgetFact,
    add_todo: addTodo,
    list_todos: listTodos,
    complete_todo: completeTodo,
    remove_todo: removeTodo,
    open_app: openApp,
    set_reminder: setReminder,
    list_reminders: listReminders,
    cancel_reminder: cancelReminder
};

const extra = createExtraTools({
  getWeather,
  formatIst,
  cleanText,
  Todo,
  Reminder,
});
TOOLS.push(...extra.definitions);
Object.assign(TOOL_FUNCTIONS, extra.functions);
if (process.env.ENABLE_OPEN_APP === "false") {
  const i = TOOLS.findIndex((t) => t.function.name === "open_app");
  if (i !== -1) TOOLS.splice(i, 1);
}

async function runTool(name, args, ctx) {
    const fn = TOOL_FUNCTIONS[name];
    if (!fn) return { result: { error: `Unknown tool: ${name}` } };
    try {
        return await fn(args, ctx);
    } catch (err) {
        console.error(`Tool ${name} failed:`, err.message);
        return { result: { error: 'Tool failed' } };
    }
}

// ---------- LLM call (retries when the provider rate-limits us) ----------
// async function callLLM(convo) {
//     for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
//         const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
//             method: 'POST',
//             headers: {
//                 'Content-Type': 'application/json',
//                 Authorization: `Bearer ${LLM_API_KEY}`
//             },
//             body: JSON.stringify({
//                 model: LLM_MODEL,
//                 max_tokens: 3000,
//                 reasoning_effort: 'low',
//                 messages: convo,
//                 tools: TOOLS,
//                 tool_choice: 'auto'
//             })
//         });

//         if (response.status === 429 && attempt < LLM_MAX_RETRIES) {
//             await response.text(); // drain the body
//             const headerSeconds = Number(response.headers.get('retry-after'));
//             const seconds = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : 3;
//             const waitMs = Math.min(seconds * 1000 + 500, 10000);
//             console.warn(`LLM rate limited (429). Retrying in ${waitMs} ms (attempt ${attempt + 1}/${LLM_MAX_RETRIES})`);
//             await sleep(waitMs);
//             continue;
//         }

//         const data = await response.json();
//         if (!response.ok) {
//             const err = new Error(`LLM ${response.status}: ${JSON.stringify(data)}`);
//             err.status = response.status;
//             throw err;
//         }
//         return data.choices[0].message;
//     }
// }

// ---------- LLM providers (primary + optional fallback) ----------
// Empty string in .env means "do not send reasoning_effort"
const reasoningSetting = (value, fallback) => {
    const v = value === undefined ? fallback : String(value).trim();
    return v || undefined;
};

const providers = [
    {
        name: 'primary',
        apiKey: LLM_API_KEY,
        baseUrl: LLM_BASE_URL,
        model: LLM_MODEL,
        reasoningEffort: reasoningSetting(process.env.LLM_REASONING_EFFORT, 'low'),
        strictTools: false,
        blockedUntil: 0
    }
];

if (process.env.LLM2_API_KEY && process.env.LLM2_BASE_URL && process.env.LLM2_MODEL) {
    providers.push({
        name: 'fallback',
        apiKey: process.env.LLM2_API_KEY,
        baseUrl: process.env.LLM2_BASE_URL,
        model: process.env.LLM2_MODEL,
        reasoningEffort: reasoningSetting(process.env.LLM2_REASONING_EFFORT, ''),
        strictTools: true, // some providers (e.g. Gemini) reject empty tool schemas
        blockedUntil: 0
    });
}
console.log(`LLM providers: ${providers.map((p) => `${p.name}=${p.model}`).join(', ')}`);

// Tool list without empty "properties" / "required" so stricter providers accept it
const toolsForRequest = () =>
    TOOLS.map((tool) => {
        const { parameters, ...fn } = tool.function;
        const properties = parameters?.properties || {};
        if (!Object.keys(properties).length) return { ...tool, function: fn };

        const cleaned = { ...parameters };
        if (!cleaned.required?.length) delete cleaned.required;
        return { ...tool, function: { ...fn, parameters: cleaned } };
    });

async function callProvider(p, convo, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const body = {
            model: p.model,
            max_tokens: 3000,
            messages: convo,
            tools: p.strictTools ? toolsForRequest() : TOOLS,
            tool_choice: 'auto'
        };
        if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;

        const response = await fetch(`${p.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000)
        });

        if (response.status === 429) {
            const headerSeconds = Number(response.headers.get('retry-after'));
            const seconds = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : 3;
            p.blockedUntil = Date.now() + Math.min(seconds * 1000, 60000);

            if (attempt < retries) {
                await response.text(); // drain the body
                const waitMs = Math.min(seconds * 1000 + 500, 10000);
                console.warn(`LLM "${p.name}" rate limited (429). Retrying in ${waitMs} ms (attempt ${attempt + 1}/${retries})`);
                await sleep(waitMs);
                continue;
            }
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                p.blockedUntil = Date.now() + 5 * 60 * 1000; // bad key: stop hammering it
                console.error(`LLM "${p.name}" rejected the API key. Check it in server/.env`);
            }
            const err = new Error(`LLM ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
            err.status = response.status;
            throw err;
        }

        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('LLM returned no message');
        return message;
    }
}

// Tries providers in order; providers that are cooling down are used only as a last resort
async function callLLM(convo) {
    const now = Date.now();
    const ready = providers.filter((p) => p.blockedUntil <= now);
    const cooling = providers.filter((p) => p.blockedUntil > now).sort((a, b) => a.blockedUntil - b.blockedUntil);
    const queue = [...ready, ...cooling];

    let lastErr;
    for (let i = 0; i < queue.length; i++) {
        const p = queue[i];
        const isLast = i === queue.length - 1;
        try {
            const message = await callProvider(p, convo, isLast ? LLM_MAX_RETRIES : 0);
            if (p !== providers[0]) console.log(`Answered by ${p.name} provider (${p.model})`);
            return message;
        } catch (err) {
            lastErr = err;
            console.warn(`LLM provider "${p.name}" failed: ${String(err.message).slice(0, 200)}`);
        }
    }
    throw lastErr;
}

// ---------- Routes ----------
app.get('/history', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });

        const rows = await Message.find({ sessionId }).sort({ createdAt: -1 }).limit(50).lean();
        res.json({ messages: rows.reverse().map(({ role, content }) => ({ role, content })) });
    } catch (err) {
        console.error('History Error:', err.message);
        res.status(500).json({ error: 'Could not load history' });
    }
});

app.delete('/history', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });

        await Message.deleteMany({ sessionId }); // facts, to-dos and reminders are kept on purpose
        res.json({ ok: true });
    } catch (err) {
        console.error('Clear Error:', err.message);
        res.status(500).json({ error: 'Could not clear history' });
    }
});

// Side panel data: to-dos + upcoming reminders
app.get('/panel', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });

        const [todos, reminders] = await Promise.all([
            Todo.find({ sessionId }).sort({ createdAt: 1 }).lean(),
            Reminder.find({ sessionId, status: 'pending' }).sort({ dueAt: 1 }).lean()
        ]);

        res.json({
            todos: todos.map((t) => ({ id: t._id, text: t.text, done: t.done })),
            reminders: reminders.map((r) => ({ id: r._id, text: r.text, dueAt: r.dueAt }))
        });
    } catch (err) {
        console.error('Panel Error:', err.message);
        res.status(500).json({ error: 'Could not load panel' });
    }
});

app.patch('/todos/:id', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const { done } = req.body || {};
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
        if (typeof done !== 'boolean') return res.status(400).json({ error: 'done must be true or false' });

        const todo = await Todo.findOneAndUpdate({ _id: req.params.id, sessionId }, { done }, { returnDocument: 'after' });
        if (!todo) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Todo Update Error:', err.message);
        res.status(500).json({ error: 'Could not update to-do' });
    }
});

app.delete('/todos/:id', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });

        const result = await Todo.deleteOne({ _id: req.params.id, sessionId });
        if (!result.deletedCount) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Todo Delete Error:', err.message);
        res.status(500).json({ error: 'Could not delete to-do' });
    }
});

app.delete('/reminders/:id', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });
        if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });

        const result = await Reminder.updateOne({ _id: req.params.id, sessionId, status: 'pending' }, { status: 'cancelled' });
        if (!result.matchedCount) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('Reminder Cancel Error:', err.message);
        res.status(500).json({ error: 'Could not cancel reminder' });
    }
});

// Delivers due reminders. Each is marked "fired" atomically so it can only be delivered once.
app.get('/reminders/due', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!isValidSession(sessionId)) return res.status(400).json({ error: 'Valid sessionId required' });

        const due = [];
        for (let i = 0; i < 10; i++) {
            const r = await Reminder.findOneAndUpdate(
                { sessionId, status: 'pending', dueAt: { $lte: new Date() } },
                { status: 'fired' },
                { sort: { dueAt: 1 }, returnDocument: 'after' }
            ).lean();
            if (!r) break;
            due.push({ id: r._id, text: r.text, dueAt: r.dueAt });
        }

        res.json({ reminders: due });
    } catch (err) {
        console.error('Due Error:', err.message);
        res.status(500).json({ error: 'Could not check reminders' });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { sessionId, message, language = 'en' } = req.body || {};

        if (!isValidSession(sessionId)) {
            return res.status(400).json({ error: 'Valid sessionId required' });
        }
        if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
            return res.status(400).json({ error: 'message must be a non-empty string (max 2000 chars)' });
        }
        if (!LANGUAGES.includes(language)) {
            return res.status(400).json({ error: 'Unsupported language' });
        }

        const userText = message.trim();

        const [recent, facts] = await Promise.all([
            Message.find({ sessionId }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).lean(),
            Fact.find({ sessionId }).sort({ createdAt: 1 }).lean()
        ]);

        const history = recent.reverse().map(({ role, content }) => ({ role, content }));
        while (history.length && history[0].role !== 'user') history.shift(); // must start with a user turn

        const convo = [
            { role: 'system', content: buildSystemPrompt(facts, language) },
            ...history,
            { role: 'user', content: userText }
        ];
        const actions = [];
        const ctx = { sessionId };

        for (let i = 0; i < 4; i++) {
            const msg = await callLLM(convo);

            if (!msg.tool_calls?.length) {
                const reply = msg.content?.trim() || '';
                if (!reply) return res.status(502).json({ error: 'Empty reply' });

                await Message.create({ sessionId, role: 'user', content: userText });
                await Message.create({ sessionId, role: 'assistant', content: reply });
                return res.json({ reply, actions });
            }

            convo.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

            for (const call of msg.tool_calls) {
                let args = {};
                try {
                    args = JSON.parse(call.function.arguments || '{}');
                } catch {
                    args = {};
                }

                console.log('Tool call:', call.function.name, args);
                const out = await runTool(call.function.name, args, ctx);
                if (out.action) actions.push(out.action);

                convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
            }
        }

        const fallback = 'I seem to be going in circles, sir. Could you rephrase that?';
        await Message.create({ sessionId, role: 'user', content: userText });
        await Message.create({ sessionId, role: 'assistant', content: fallback });
        res.json({ reply: fallback, actions });
    } catch (err) {
        console.error('Chat Error:', err.message);
        if (err.status === 429) {
            return res.status(429).json({ error: 'JARVIS is rate limited, sir. Try again in a few seconds.' });
        }
        res.status(500).json({ error: 'JARVIS is offline' });
    }
});

app.use(applySecurity.errorHandler);

// ---------- Start ----------
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

console.log('Connecting to MongoDB...');
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
        console.log('MongoDB connected');
        app.listen(process.env.PORT || 5000, () => console.log('JARVIS server online'));
    })
    .catch((err) => {
        console.error('MongoDB connection failed:', err.message);
        process.exit(1);
    });