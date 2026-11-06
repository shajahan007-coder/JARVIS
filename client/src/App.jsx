import { useState, useRef, useEffect } from "react";
import { authFetch, API_URL } from "./auth.js";
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

// Speech recognition language for Tanglish. 'ta-IN' works best when you speak mostly Tamil;
// switch to 'en-IN' if your sentences are mostly English words.
const TANGLISH_RECOGNITION = "ta-IN";

const LANGS = {
  en: {
    label: "EN",
    recog: "en-IN",
    speechLang: "en-GB",
    placeholder: "Ask JARVIS...",
    handsFreePlaceholder: "Hands-free on, or type here...",
    hint: 'At your service, sir. Try: "Remind me in 2 minutes to stretch", "Add buy milk to my list", "Explain recursion in Python".',
    codeOnScreen: "The code is on screen, sir.",
    answerOnScreen: "The full answer is on screen, sir.",
    reminderChat: (t) => `⏰ Reminder: ${t}`,
    reminderSpoken: (t) => `Reminder, sir: ${t}.`,
  },
  ta: {
    label: "தமிழ்",
    recog: "ta-IN",
    speechLang: "ta-IN",
    placeholder: "JARVIS-இடம் கேளுங்கள்...",
    handsFreePlaceholder:
      "ஹேண்ட்ஸ்-ஃப்ரீ இயக்கத்தில் உள்ளது, அல்லது இங்கே தட்டச்சு செய்யுங்கள்...",
    hint: 'வணக்கம் சார். முயற்சி செய்யுங்கள்: "மதுரை வானிலை என்ன?", "2 நிமிடத்தில் தண்ணீர் குடிக்க நினைவூட்டு".',
    codeOnScreen: "கோடு திரையில் இருக்கிறது சார்.",
    answerOnScreen: "முழு பதில் திரையில் இருக்கிறது சார்.",
    reminderChat: (t) => `⏰ நினைவூட்டல்: ${t}`,
    reminderSpoken: (t) => `நினைவூட்டல்: ${t}.`,
  },
  tanglish: {
    label: "Tanglish",
    recog: TANGLISH_RECOGNITION,
    speechLang: "en-IN",
    placeholder: "JARVIS kitta kelunga...",
    handsFreePlaceholder: "Hands-free on, illa inga type pannunga...",
    hint: 'Vanakkam sir. Try: "Madurai weather enna?", "2 minute la remind pannu", "Recursion explain pannu".',
    codeOnScreen: "Code screen-la irukku sir.",
    answerOnScreen: "Full answer screen-la irukku sir.",
    reminderChat: (t) => `⏰ Reminder: ${t}`,
    reminderSpoken: (t) => `Reminder sir: ${t}.`,
  },
};

// Words the recognizer may produce for "Jarvis", in Latin and Tamil script. Add more if it mishears you.
const WAKE_WORDS = [
  "jarvis",
  "jervis",
  "jarvice",
  "ஜார்விஸ்",
  "ஜார்வீஸ்",
  "ஜார்விஸ",
  "ஜார்வஸ்",
  "ஜெர்விஸ்",
];
// \b does not work with Tamil script, so letter boundaries are checked with Unicode properties
const WAKE_REGEX = new RegExp(
  `(?:^|[^\\p{L}\\p{M}])(?:${WAKE_WORDS.join("|")})(?![\\p{L}\\p{M}])`,
  "iu",
);
const CAPTURE_TIMEOUT_MS = 8000;
const REMINDER_POLL_MS = 5000;

const getSessionId = () => {
  let id = localStorage.getItem("jarvis_session");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("jarvis_session", id);
  }
  return id;
};
const SESSION_ID = getSessionId();

const getSavedLanguage = () => {
  const saved = localStorage.getItem("jarvis_lang");
  return saved && LANGS[saved] ? saved : "en";
};

const pickVoice = (lang) => {
  const voices = synth.getVoices();

  if (lang === "ta") {
    return (
      voices.find(
        (v) =>
          v.lang.toLowerCase().startsWith("ta") &&
          /tamil|தமிழ்|pallavi|பல்லவி|valluvar|வள்ளுவர்/i.test(v.name),
      ) ||
      voices.find((v) => v.lang.toLowerCase().startsWith("ta")) ||
      null
    );
  }

  if (lang === "tanglish") {
    const indian =
      voices.find(
        (v) => v.lang === "en-IN" && /neerja|prabhat|ravi|heera/i.test(v.name),
      ) || voices.find((v) => v.lang === "en-IN");
    if (indian) return indian;
    // fall through to the English choice
  }

  const preferred = [
    "Microsoft Ryan",
    "Microsoft Thomas",
    "Google UK English Male",
    "Microsoft George",
    "Daniel",
  ];
  for (const name of preferred) {
    const match = voices.find((v) => v.name.includes(name));
    if (match) return match;
  }
  return (
    voices.find((v) => v.lang === "en-GB") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null
  );
};

const cleanForSpeech = (text) =>
  text
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[*_#`>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Speak only a short summary when the reply contains code or is long
const prepareSpeech = (text, lang) => {
  const cfg = LANGS[lang];
  const hasCode = text.includes("```");
  const prose = cleanForSpeech(
    text.replace(/```[\s\S]*?```/g, " ").replace(/```[\s\S]*$/, " "),
  );

  if (!hasCode && prose.length <= 500) return prose;

  const sentences = prose.match(/[^.!?।]+[.!?।]+/g) || [prose];
  const short = sentences.slice(0, 2).join(" ").trim().slice(0, 300);
  return `${short} ${hasCode ? cfg.codeOnScreen : cfg.answerOnScreen}`.trim();
};

// Short cue so you know JARVIS heard the wake word
const beep = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => ctx.close();
  } catch {
    /* audio cue is optional */
  }
};

const ensureNotifyPermission = () => {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
};

const formatDue = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

// ---------- HUD ----------
const HUD_CSS = `
@keyframes hud-spin { to { transform: rotate(360deg); } }
@keyframes hud-spin-rev { to { transform: rotate(-360deg); } }
@keyframes hud-pulse { 0%, 100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.14); opacity: 1; } }
@keyframes hud-ripple { 0% { transform: scale(0.7); opacity: 0.8; } 100% { transform: scale(2.3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .hud-anim { animation: none !important; } }
`;

const ORB_STATES = {
  idle: {
    color: "#38bdf8",
    spin: 26,
    pulse: 4,
    ripple: false,
    label: "Online",
  },
  standby: {
    color: "#34d399",
    spin: 18,
    pulse: 3,
    ripple: false,
    label: 'Say "Hey Jarvis"',
  },
  listening: {
    color: "#f87171",
    spin: 9,
    pulse: 1,
    ripple: true,
    label: "Listening",
  },
  thinking: {
    color: "#fbbf24",
    spin: 1.8,
    pulse: 1.2,
    ripple: false,
    label: "Thinking",
  },
  speaking: {
    color: "#38bdf8",
    spin: 10,
    pulse: 0.6,
    ripple: true,
    label: "Speaking",
  },
};

const svgOrigin = { transformBox: "view-box", transformOrigin: "50% 50%" };

function Orb({ state, size = 120 }) {
  const s = ORB_STATES[state];
  const c = s.color;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      style={{
        filter: `drop-shadow(0 0 12px ${c}88)`,
        transition: "filter 0.4s",
      }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="hud-core">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" stopColor={c} />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </radialGradient>
      </defs>

      {s.ripple &&
        [0, 0.5].map((d) => (
          <circle
            key={d}
            className="hud-anim"
            cx="100"
            cy="100"
            r="40"
            fill="none"
            stroke={c}
            strokeWidth="2"
            style={{
              ...svgOrigin,
              animation: `hud-ripple ${s.pulse * 1.6}s ease-out ${d * s.pulse * 1.6}s infinite`,
            }}
          />
        ))}

      <circle
        className="hud-anim"
        cx="100"
        cy="100"
        r="92"
        fill="none"
        stroke={c}
        strokeWidth="2"
        strokeDasharray="8 6 40 6"
        opacity="0.8"
        style={{
          ...svgOrigin,
          animation: `hud-spin ${s.spin}s linear infinite`,
        }}
      />
      <circle
        className="hud-anim"
        cx="100"
        cy="100"
        r="78"
        fill="none"
        stroke={c}
        strokeWidth="1.5"
        strokeDasharray="2 8"
        opacity="0.7"
        style={{
          ...svgOrigin,
          animation: `hud-spin-rev ${s.spin * 1.4}s linear infinite`,
        }}
      />
      <circle
        className="hud-anim"
        cx="100"
        cy="100"
        r="64"
        fill="none"
        stroke={c}
        strokeWidth="6"
        strokeDasharray="100 34"
        opacity="0.55"
        style={{
          ...svgOrigin,
          animation: `hud-spin ${s.spin * 0.7}s linear infinite`,
        }}
      />
      <circle
        cx="100"
        cy="100"
        r="48"
        fill="none"
        stroke={c}
        strokeWidth="1"
        opacity="0.5"
      />

      <circle
        className="hud-anim"
        cx="100"
        cy="100"
        r="34"
        fill="url(#hud-core)"
        style={{
          ...svgOrigin,
          animation: `hud-pulse ${s.pulse}s ease-in-out infinite`,
        }}
      />
      <circle
        className="hud-anim"
        cx="100"
        cy="100"
        r="9"
        fill="#ffffff"
        opacity="0.9"
        style={{
          ...svgOrigin,
          animation: `hud-pulse ${s.pulse}s ease-in-out infinite`,
        }}
      />
    </svg>
  );
}

// Own state so the clock ticking doesn't re-render the whole app
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span>
      {now.toLocaleTimeString("en-IN", {
        hour12: false,
        timeZone: "Asia/Kolkata",
      })}{" "}
      IST
    </span>
  );
}

// ---------- Side panel (to-dos + reminders) ----------
function Panel({
  todos,
  reminders,
  onToggleTodo,
  onDeleteTodo,
  onDeleteReminder,
  onClose,
}) {
  const sectionTitle = {
    fontSize: "11px",
    letterSpacing: "3px",
    color: "#38bdf8",
    margin: "18px 0 8px",
  };
  const rowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    background: "#0f1b33",
    border: "1px solid #1e3a5f",
    borderRadius: "8px",
    marginBottom: "6px",
    fontSize: "14px",
  };
  const xBtn = {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "14px",
    padding: "2px 4px",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "300px",
        maxWidth: "90vw",
        background: "rgba(10,22,40,0.97)",
        borderLeft: "1px solid #1e3a5f",
        boxShadow: "-8px 0 24px rgba(0,0,0,0.5)",
        zIndex: 20,
        padding: "16px",
        overflowY: "auto",
        boxSizing: "border-box",
        color: "#e2e8f0",
        fontFamily: 'system-ui, "Nirmala UI", sans-serif',
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ letterSpacing: "3px", color: "#38bdf8" }}>
          MISSION LOG
        </strong>
        <button
          onClick={onClose}
          style={{ ...xBtn, fontSize: "18px" }}
          title="Close"
        >
          ✕
        </button>
      </div>

      <div style={sectionTitle}>TO-DO</div>
      {todos.length === 0 && (
        <div style={{ color: "#64748b", fontSize: "13px" }}>
          Nothing yet. Say "Add buy milk to my list".
        </div>
      )}
      {todos.map((t) => (
        <div key={t.id} style={rowStyle}>
          <button
            onClick={() => onToggleTodo(t)}
            title={t.done ? "Mark as not done" : "Mark as done"}
            style={{
              ...xBtn,
              color: t.done ? "#34d399" : "#64748b",
              fontSize: "16px",
            }}
          >
            {t.done ? "☑" : "☐"}
          </button>
          <span
            style={{
              flex: 1,
              textDecoration: t.done ? "line-through" : "none",
              color: t.done ? "#64748b" : "#e2e8f0",
              wordBreak: "break-word",
            }}
          >
            {t.text}
          </span>
          <button onClick={() => onDeleteTodo(t)} style={xBtn} title="Delete">
            ✕
          </button>
        </div>
      ))}

      <div style={sectionTitle}>REMINDERS</div>
      {reminders.length === 0 && (
        <div style={{ color: "#64748b", fontSize: "13px" }}>
          None. Say "Remind me in 10 minutes to stretch".
        </div>
      )}
      {reminders.map((r) => (
        <div key={r.id} style={rowStyle}>
          <span style={{ fontSize: "16px" }}>⏰</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ wordBreak: "break-word" }}>{r.text}</div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>
              {formatDue(r.dueAt)}
            </div>
          </div>
          <button
            onClick={() => onDeleteReminder(r)}
            style={xBtn}
            title="Cancel reminder"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- Message rendering ----------
function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
  };

  return (
    <div
      style={{
        margin: "8px 0",
        borderRadius: "8px",
        overflow: "hidden",
        border: "1px solid #1e3a5f",
        background: "#0a1628",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 10px",
          background: "#0f1b33",
          fontSize: "12px",
          color: "#64748b",
        }}
      >
        <span>{lang || "code"}</span>
        <button
          onClick={copy}
          style={{
            background: "none",
            border: "1px solid #1e3a5f",
            color: copied ? "#34d399" : "#94a3b8",
            borderRadius: "6px",
            padding: "2px 8px",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "12px",
          overflowX: "auto",
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: "13px",
          lineHeight: 1.5,
          color: "#e2e8f0",
          whiteSpace: "pre",
        }}
      >
        <code>{code.replace(/\n$/, "")}</code>
      </pre>
    </div>
  );
}

// **bold** and `inline code`
const renderInline = (text) =>
  text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((p, i) => {
    if (p.length > 4 && p.startsWith("**") && p.endsWith("**"))
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.length > 2 && p.startsWith("`") && p.endsWith("`")) {
      return (
        <code
          key={i}
          style={{
            background: "#0a1628",
            padding: "1px 5px",
            borderRadius: "4px",
            fontFamily: "Consolas, monospace",
            fontSize: "0.9em",
          }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return p;
  });

// Splits text into prose and fenced code blocks
const renderContent = (text) => {
  const parts = text.split(/```([\w+#-]*)\n?([\s\S]*?)```/g); // [prose, lang, code, prose, lang, code, ...]
  const out = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i];
    if (prose && prose.trim()) {
      out.push(
        <div key={`t${i}`} style={{ whiteSpace: "pre-wrap" }}>
          {renderInline(prose.trim())}
        </div>,
      );
    }
    if (i + 2 < parts.length) {
      out.push(
        <CodeBlock key={`c${i}`} lang={parts[i + 1]} code={parts[i + 2]} />,
      );
    }
  }
  return out;
};

function App() {
  const [messages, setMessages] = useState([]); // [{ role, content, links? }]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [listening, setListening] = useState(false); // manual mic
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [handsFree, setHandsFree] = useState(false); // wake-word mode on/off
  const [wakeState, setWakeState] = useState("waiting"); // 'waiting' | 'capturing'
  const [error, setError] = useState("");

  const [language, setLanguage] = useState(getSavedLanguage); // 'en' | 'ta' | 'tanglish'
  const [voicesVersion, setVoicesVersion] = useState(0);
  const [voiceNotice, setVoiceNotice] = useState("");

  const [panelOpen, setPanelOpen] = useState(false);
  const [todos, setTodos] = useState([]);
  const [reminders, setReminders] = useState([]);

  const bottomRef = useRef(null);
  const recognitionRef = useRef(null); // manual mic
  const mutedRef = useRef(false);
  const languageRef = useRef(language);
  languageRef.current = language;

  // Hands-free refs (read inside long-lived recognition callbacks)
  const hfRecognitionRef = useRef(null);
  const handsFreeRef = useRef(false);
  const wakeStateRef = useRef("waiting");
  const captureTimerRef = useRef(null);
  const busyRef = useRef(false); // true while JARVIS is thinking or speaking
  const sendTextRef = useRef(null); // always points to the latest sendText

  // Reminder delivery refs
  const dueQueueRef = useRef([]);
  const deliverQueuedRef = useRef(null);
  const refreshPanelRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    busyRef.current = loading || speaking;
  }, [loading, speaking]);

  // When JARVIS becomes free, deliver any reminders that were waiting
  useEffect(() => {
    if (!loading && !speaking) deliverQueuedRef.current?.();
  }, [loading, speaking]);

  useEffect(() => {
    mutedRef.current = muted;
    if (muted) {
      synth.cancel();
      setSpeaking(false);
    }
  }, [muted]);

  // Voices load asynchronously in Chrome
  useEffect(() => {
    const onVoices = () => setVoicesVersion((v) => v + 1);
    synth.addEventListener("voiceschanged", onVoices);
    synth.getVoices();
    onVoices();
    return () => {
      synth.removeEventListener("voiceschanged", onVoices);
      synth.cancel();
    };
  }, []);

  // Warn when Tamil is selected but the browser has no Tamil voice
  useEffect(() => {
    if (language === "ta" && !pickVoice("ta")) {
      setVoiceNotice(
        "No Tamil voice found in this browser, so replies will be text only.",
      );
    } else {
      setVoiceNotice("");
    }
  }, [language, voicesVersion]);

  // Load saved conversation and panel data on startup
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const res = await authFetch(`${API_URL}/history?sessionId=${SESSION_ID}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load history");
        setMessages(data.messages || []);
      } catch (err) {
        setError(err.message || "Could not load history");
      } finally {
        setHistoryLoading(false);
      }
    };
    loadHistory();
    refreshPanelRef.current?.();
  }, []);

  // Poll for due reminders
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await authFetch(
          `${API_URL}/reminders/due?sessionId=${SESSION_ID}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.reminders?.length) {
          dueQueueRef.current.push(...data.reminders);
          deliverQueuedRef.current?.();
          refreshPanelRef.current?.();
        }
      } catch {
        /* server briefly unreachable; try again next tick */
      }
    }, REMINDER_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // Stop everything when the component unmounts
  useEffect(() => {
    return () => {
      handsFreeRef.current = false;
      clearTimeout(captureTimerRef.current);
      hfRecognitionRef.current?.abort();
    };
  }, []);

  // ---------- Panel actions ----------
  const refreshPanel = async () => {
    try {
      const res = await authFetch(`${API_URL}/panel?sessionId=${SESSION_ID}`);
      if (!res.ok) return;
      const data = await res.json();
      setTodos(data.todos || []);
      setReminders(data.reminders || []);
    } catch {
      /* panel is non-critical */
    }
  };
  refreshPanelRef.current = refreshPanel;

  const panelRequest = async (path, options) => {
    try {
      const res = await authFetch(
        `${API_URL}${path}${path.includes("?") ? "&" : "?"}sessionId=${SESSION_ID}`,
        options,
      );
      if (!res.ok) throw new Error("Request failed");
      await refreshPanel();
    } catch (err) {
      setError(err.message || "Could not update panel");
    }
  };

  const toggleTodo = (t) =>
    panelRequest(`/todos/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !t.done }),
    });
  const deleteTodo = (t) =>
    panelRequest(`/todos/${t.id}`, { method: "DELETE" });
  const deleteReminder = (r) =>
    panelRequest(`/reminders/${r.id}`, { method: "DELETE" });

  const togglePanel = () => {
    if (!panelOpen) refreshPanel();
    setPanelOpen(!panelOpen);
  };

  // ---------- Language ----------
  const changeLanguage = (code) => {
    if (code === language || !LANGS[code]) return;
    synth.cancel();
    setSpeaking(false);
    localStorage.setItem("jarvis_lang", code);
    languageRef.current = code;
    setLanguage(code);
    setError("");
    recognitionRef.current?.abort(); // manual mic restarts on next tap with the new language
    hfRecognitionRef.current?.abort(); // hands-free restarts itself (onend) with the new language
  };

  // ---------- Speech ----------
  // `text` must already be prepared for speech (see prepareSpeech)
  const speak = (text) => {
    if (mutedRef.current || !synth || !text) return;

    const lang = languageRef.current;
    const voice = pickVoice(lang);
    if (lang === "ta" && !voice) return; // an English voice would read Tamil as gibberish

    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || LANGS[lang].speechLang;
    utterance.rate = 1;
    utterance.pitch = lang === "en" ? 0.9 : 1;

    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    synth.speak(utterance);
  };

  const stopSpeaking = () => {
    synth.cancel();
    setSpeaking(false);
  };

  // Shows due reminders in chat, speaks them, and sends a desktop notification
  const deliverQueued = () => {
    if (busyRef.current || dueQueueRef.current.length === 0) return;

    const cfg = LANGS[languageRef.current];
    const due = dueQueueRef.current.splice(0);
    setMessages((prev) => [
      ...prev,
      ...due.map((r) => ({
        role: "assistant",
        content: cfg.reminderChat(r.text),
      })),
    ]);
    speak(due.map((r) => cfg.reminderSpoken(r.text)).join(" "));

    if ("Notification" in window && Notification.permission === "granted") {
      due.forEach((r) => new Notification("JARVIS reminder", { body: r.text }));
    }
  };
  deliverQueuedRef.current = deliverQueued;

  // ---------- Chat ----------
  const sendText = async (text) => {
    const clean = text.trim();
    if (!clean || loading || historyLoading) return;

    stopSpeaking();

    setMessages((prev) => [...prev, { role: "user", content: clean }]);
    setInput("");
    setError("");
    setLoading(true);

    try {
      const res = await authFetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          message: clean,
          language,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.reply) {
        throw new Error(data.error || "Empty reply");
      }

      const actions = data.actions || [];
      actions.forEach((a) => {
        if (a.type === "open_url") window.open(a.url, "_blank", "noopener");
      });

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply,
          links: actions.filter((a) => a.type === "open_url"),
        },
      ]);
      speak(prepareSpeech(data.reply, language));
      refreshPanel(); // tools may have changed to-dos or reminders
    } catch (err) {
      setError(err.message || "Could not reach JARVIS");
    } finally {
      setLoading(false);
    }
  };
  sendTextRef.current = sendText; // refresh on every render so callbacks never go stale

  const clearChat = async () => {
    if (
      !window.confirm(
        "Clear this conversation? Saved facts, to-dos and reminders are kept.",
      )
    )
      return;
    try {
      const res = await authFetch(`${API_URL}/history?sessionId=${SESSION_ID}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not clear chat");
      stopSpeaking();
      setMessages([]);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    ensureNotifyPermission();
    sendText(input);
  };

  // ---------- Manual mic (tap to talk) ----------
  const toggleListening = () => {
    if (!SpeechRecognition) {
      setError("Voice input is not supported in this browser. Use Chrome.");
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    ensureNotifyPermission();
    stopSpeaking();

    const recognition = new SpeechRecognition();
    recognition.lang = LANGS[languageRef.current].recog;
    recognition.interimResults = true;
    recognition.continuous = false;

    let finalTranscript = "";

    recognition.onstart = () => {
      setError("");
      setListening(true);
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += t;
        else interim += t;
      }
      setInput(finalTranscript || interim);
    };

    recognition.onerror = (event) => {
      const messagesByError = {
        "not-allowed":
          "Microphone permission denied. Allow it in the address bar.",
        "no-speech": "I did not hear anything. Try again.",
        "audio-capture": "No microphone found.",
        network: "Speech service needs an internet connection.",
        "language-not-supported":
          "This browser cannot recognize that language. Switch to EN or type instead.",
      };
      setError(messagesByError[event.error] || `Voice error: ${event.error}`);
    };

    recognition.onend = () => {
      setListening(false);
      if (finalTranscript.trim()) sendTextRef.current(finalTranscript);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  // ---------- Hands-free (wake word) ----------
  const setWake = (state) => {
    wakeStateRef.current = state;
    setWakeState(state);
  };

  const handleWakeResult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (!event.results[i].isFinal) continue;

      const text = event.results[i][0].transcript.trim();
      if (!text || busyRef.current) continue; // ignore while JARVIS is busy

      // Phase 2: wake word already heard, this sentence is the command
      if (wakeStateRef.current === "capturing") {
        clearTimeout(captureTimerRef.current);
        setWake("waiting");
        sendTextRef.current(text);
        continue;
      }

      // Phase 1: look for the wake word
      const match = WAKE_REGEX.exec(text);
      if (!match) continue;

      const command = text
        .slice(match.index + match[0].length)
        .replace(/^[\s,.:;!?-]+/, "");

      if (command) {
        sendTextRef.current(command); // "Jarvis what time is it" in one go
      } else {
        beep();
        setWake("capturing");
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = setTimeout(
          () => setWake("waiting"),
          CAPTURE_TIMEOUT_MS,
        );
      }
    }
  };

  const runHandsFreeRecognition = () => {
    if (!handsFreeRef.current) return;

    const recognition = new SpeechRecognition();
    recognition.lang = LANGS[languageRef.current].recog; // read fresh on every restart
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = handleWakeResult;

    recognition.onerror = (event) => {
      if (["not-allowed", "service-not-allowed"].includes(event.error)) {
        setError("Microphone permission denied. Allow it in the address bar.");
        stopHandsFree();
      } else if (event.error === "audio-capture") {
        setError("No microphone found.");
        stopHandsFree();
      } else if (event.error === "network") {
        setError("Speech service needs an internet connection.");
        stopHandsFree();
      } else if (event.error === "language-not-supported") {
        setError("This browser cannot recognize that language. Switch to EN.");
        stopHandsFree();
      }
      // 'no-speech' and 'aborted' are normal; onend restarts the session
    };

    // Chrome ends continuous sessions every so often; restart while the mode is on
    recognition.onend = () => {
      if (handsFreeRef.current) setTimeout(runHandsFreeRecognition, 300);
    };

    hfRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      /* already started; ignore */
    }
  };

  const startHandsFree = () => {
    if (!SpeechRecognition) {
      setError("Voice input is not supported in this browser. Use Chrome.");
      return;
    }
    ensureNotifyPermission();
    recognitionRef.current?.abort(); // stop manual mic if active
    stopSpeaking();
    setError("");
    handsFreeRef.current = true;
    setHandsFree(true);
    setWake("waiting");
    runHandsFreeRecognition();
  };

  const stopHandsFree = () => {
    handsFreeRef.current = false;
    setHandsFree(false);
    setWake("waiting");
    clearTimeout(captureTimerRef.current);
    hfRecognitionRef.current?.abort();
  };

  const toggleHandsFree = () =>
    handsFree ? stopHandsFree() : startHandsFree();

  // ---------- UI ----------
  const cfg = LANGS[language];

  let orbState = "idle";
  if (listening || (handsFree && wakeState === "capturing"))
    orbState = "listening";
  else if (loading) orbState = "thinking";
  else if (speaking) orbState = "speaking";
  else if (handsFree) orbState = "standby";

  const orb = ORB_STATES[orbState];
  const statusText =
    handsFree && wakeState === "capturing" ? "Yes, sir?" : orb.label;
  const panelCount = todos.filter((t) => !t.done).length + reminders.length;

  const headerBtn = {
    background: "#112240",
    border: "1px solid #1e3a5f",
    color: "white",
    borderRadius: "8px",
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: "16px",
    position: "absolute",
    top: "16px",
  };

  return (
    <div
      style={{
        height: "100vh",
        backgroundImage:
          "linear-gradient(rgba(56,189,248,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.04) 1px, transparent 1px)",
        backgroundSize: "32px 32px",
      }}
    >
      <style>{HUD_CSS}</style>

      {panelOpen && (
        <Panel
          todos={todos}
          reminders={reminders}
          onToggleTodo={toggleTodo}
          onDeleteTodo={deleteTodo}
          onDeleteReminder={deleteReminder}
          onClose={() => setPanelOpen(false)}
        />
      )}

      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          fontFamily: 'system-ui, "Nirmala UI", sans-serif',
          color: "#e2e8f0",
        }}
      >
        {/* HUD header */}
        <div
          style={{
            padding: "12px 20px 10px",
            borderBottom: "1px solid #1e3a5f",
            textAlign: "center",
            position: "relative",
          }}
        >
          <button
            onClick={clearChat}
            title="Clear chat"
            style={{ ...headerBtn, left: "16px" }}
          >
            🗑
          </button>

          <h1
            style={{
              margin: 0,
              fontSize: "20px",
              letterSpacing: "6px",
              color: "#38bdf8",
            }}
          >
            J.A.R.V.I.S.
          </h1>
          <div
            style={{
              fontSize: "11px",
              color: "#475569",
              letterSpacing: "2px",
              marginTop: "2px",
            }}
          >
            <Clock />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              margin: "4px 0 2px",
            }}
          >
            <Orb state={orbState} size={104} />
          </div>
          <div
            style={{
              fontSize: "12px",
              letterSpacing: "3px",
              textTransform: "uppercase",
              color: orb.color,
              transition: "color 0.4s",
            }}
          >
            {statusText}
          </div>

          {/* Language switch */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "6px",
              marginTop: "8px",
            }}
          >
            {Object.entries(LANGS).map(([code, l]) => (
              <button
                key={code}
                onClick={() => changeLanguage(code)}
                style={{
                  padding: "3px 12px",
                  borderRadius: "14px",
                  fontSize: "12px",
                  cursor: "pointer",
                  border: `1px solid ${language === code ? "#38bdf8" : "#1e3a5f"}`,
                  background:
                    language === code ? "rgba(56,189,248,0.18)" : "#0f1b33",
                  color: language === code ? "#38bdf8" : "#94a3b8",
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
          {voiceNotice && (
            <div
              style={{ marginTop: "6px", fontSize: "11px", color: "#fbbf24" }}
            >
              {voiceNotice}
            </div>
          )}

          <button
            onClick={togglePanel}
            title="To-dos and reminders"
            style={{
              ...headerBtn,
              right: "68px",
              background: panelOpen ? "#1e3a5f" : "#112240",
            }}
          >
            📋
            {panelCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: "-6px",
                  right: "-6px",
                  background: "#38bdf8",
                  color: "#0b1120",
                  borderRadius: "10px",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "1px 6px",
                }}
              >
                {panelCount}
              </span>
            )}
          </button>

          <button
            onClick={() => (speaking ? stopSpeaking() : setMuted(!muted))}
            title={
              speaking
                ? "Stop speaking"
                : muted
                  ? "Unmute JARVIS"
                  : "Mute JARVIS"
            }
            style={{ ...headerBtn, right: "16px" }}
          >
            {speaking ? "⏹" : muted ? "🔇" : "🔊"}
          </button>
        </div>

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {historyLoading && (
            <p
              style={{
                textAlign: "center",
                color: "#64748b",
                marginTop: "40px",
              }}
            >
              Loading memory...
            </p>
          )}

          {!historyLoading && messages.length === 0 && (
            <p
              style={{
                textAlign: "center",
                color: "#64748b",
                marginTop: "20px",
              }}
            >
              {cfg.hint}
            </p>
          )}

          {messages.map((m, i) => {
            const isUser = m.role === "user";
            const hasCode = !isUser && m.content.includes("```");

            return (
              <div
                key={i}
                style={{
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  maxWidth: hasCode ? "95%" : "80%",
                  minWidth: 0,
                  padding: "10px 14px",
                  borderRadius: "12px",
                  background: isUser ? "#2563eb" : "rgba(17,34,64,0.85)",
                  border: isUser ? "none" : "1px solid #1e3a5f",
                  borderLeft: isUser ? "none" : "3px solid #38bdf8",
                  lineHeight: 1.5,
                }}
              >
                {isUser ? (
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                ) : (
                  renderContent(m.content)
                )}

                {m.links?.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      marginTop: "8px",
                    }}
                  >
                    {m.links.map((l, j) => (
                      <a
                        key={j}
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: "12px",
                          color: "#38bdf8",
                          border: "1px solid #1e3a5f",
                          borderRadius: "6px",
                          padding: "3px 8px",
                          textDecoration: "none",
                        }}
                      >
                        ↗ {l.label}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {error && (
            <div
              style={{
                alignSelf: "center",
                background: "#450a0a",
                color: "#fca5a5",
                padding: "8px 14px",
                borderRadius: "8px",
                fontSize: "14px",
              }}
            >
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            gap: "10px",
            padding: "16px",
            borderTop: "1px solid #1e3a5f",
          }}
        >
          <button
            type="button"
            onClick={toggleHandsFree}
            disabled={historyLoading}
            title={
              handsFree
                ? "Turn off hands-free"
                : 'Turn on hands-free ("Hey Jarvis")'
            }
            style={{
              width: "48px",
              borderRadius: "50%",
              border: "none",
              fontSize: "20px",
              cursor: "pointer",
              background: handsFree ? "#059669" : "#112240",
              color: "white",
              boxShadow: handsFree ? "0 0 0 6px rgba(5,150,105,0.3)" : "none",
            }}
          >
            🎧
          </button>
          <button
            type="button"
            onClick={toggleListening}
            disabled={loading || historyLoading || handsFree}
            title={
              handsFree
                ? "Disabled in hands-free mode"
                : listening
                  ? "Stop listening"
                  : "Speak"
            }
            style={{
              width: "48px",
              borderRadius: "50%",
              border: "none",
              fontSize: "20px",
              cursor: loading || handsFree ? "not-allowed" : "pointer",
              opacity: handsFree ? 0.4 : 1,
              background: listening ? "#ef4444" : "#112240",
              color: "white",
              boxShadow: listening ? "0 0 0 6px rgba(239,68,68,0.3)" : "none",
            }}
          >
            🎤
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={handsFree ? cfg.handsFreePlaceholder : cfg.placeholder}
            disabled={loading || historyLoading}
            style={{
              flex: 1,
              padding: "12px",
              borderRadius: "8px",
              border: "1px solid #1e3a5f",
              background: "#0f1b33",
              color: "white",
              fontSize: "16px",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={loading || historyLoading || !input.trim()}
            style={{
              padding: "12px 20px",
              borderRadius: "8px",
              border: "none",
              background: loading || !input.trim() ? "#1e3a5f" : "#38bdf8",
              color: "#0b1120",
              fontWeight: 700,
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
