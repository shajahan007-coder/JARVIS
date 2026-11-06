# J.A.R.V.I.S. — Voice AI Assistant

A voice-controlled AI assistant inspired by Iron Man's JARVIS, built with the MERN stack and an OpenAI-compatible LLM (Groq free tier).

**Live demo:** _add your Vercel URL here after deploying_

## Features

| Area | What it does |
|---|---|
| Voice | Wake word ("Hey Jarvis"), tap-to-talk, spoken replies (Web Speech API) |
| Languages | English, Tamil, and Tanglish modes |
| Tools | Time, weather, web search, news, calculator, currency, YouTube, open websites |
| Productivity | To-do list, reminders and timers with spoken alerts, daily briefing, side panel |
| Memory | Chat history and remembered facts stored in MongoDB |
| Study helper | Step-by-step Java/Python explanations with copyable code blocks |
| Accounts | Email and password login with JWT |
| Reliability | Automatic fallback to a second LLM provider when the first is rate limited |
| UI | Animated HUD orb that reacts to listening, thinking and speaking |

## Tech stack

React (Vite) · Node.js · Express · MongoDB (Mongoose) · Groq API (OpenAI-compatible) · Web Speech API

## Architecture

```
Browser (React)  ──►  Express API  ──►  LLM provider (tool calling, with fallback)
   voice in/out          │
                         ├──►  MongoDB (users, history, facts, to-dos, reminders)
                         └──►  Web APIs (weather, search, currency)
```

## Setup

Requirements: Node.js 20.19 or newer, a MongoDB database, and a Groq API key (free).

```bash
git clone <your-repo-url>
cd jarvis

# Server
cd server
npm install
copy .env.example .env     # then fill in your values
node index.js

# Client (new terminal)
cd client
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173) in **Chrome**.

## Environment variables (`server/.env`)

| Variable | Purpose |
|---|---|
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Primary LLM provider |
| `LLM2_API_KEY`, `LLM2_BASE_URL`, `LLM2_MODEL` | Optional fallback provider |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Long random string for signing login tokens |
| `TAVILY_API_KEY` | Optional, enables live web search |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins (the deployed frontend URL) |
| `TRUST_PROXY` | Set to `1` when deployed behind a proxy |
| `ENABLE_OPEN_APP` | Set to `false` to disable launching PC apps |

Client (`client/.env`, optional locally): `VITE_API_URL` — the backend URL.

## Example commands

- "Hey Jarvis, what's the weather in Madurai?"
- "Remind me in 10 minutes to drink water"
- "Add buy milk to my list"
- "Good morning" (daily briefing)
- "Explain recursion in Python"

## Known limitations

- Voice recognition needs Chrome and an internet connection.
- Tamil speech output needs a Tamil voice installed in the browser; Tanglish mode works with an English-India voice.
- "Open app" works only on a local Windows machine and is disabled on the hosted server.
- The free LLM tier has a tokens-per-minute limit; the server retries and falls back automatically.

## Security notes

Secrets live in `server/.env` and are never committed. The server uses security headers, rate limiting, request size limits, hashed passwords (bcrypt), signed tokens, and an allowlist for launching apps.