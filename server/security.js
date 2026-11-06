const cors = require("cors");
const helmet = require("helmet");
const express = require("express");
const { rateLimit } = require("express-rate-limit");

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const limiter = (limit, message) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: message },
  });

// Registers security middleware. Call once, before any routes.
function applySecurity(app) {
      if (process.env.TRUST_PROXY)
        app.set("trust proxy", Number(process.env.TRUST_PROXY));
  // Comma-separated list in .env, e.g. ALLOWED_ORIGINS=https://my-jarvis.vercel.app,http://localhost:5173
  const fromEnv = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = fromEnv.length ? fromEnv : DEFAULT_ORIGINS;

  app.use(helmet());
  app.use(
    cors({
      origin: allowedOrigins,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  );
  app.use(express.json({ limit: "10kb" }));

  app.use(limiter(300, "Too many requests. Slow down a little."));
  app.use("/chat", limiter(20, "Too many messages, sir. Give me a moment."));
      app.use(
        "/auth",
        limiter(10, "Too many attempts. Try again in a minute."),
      );
}

// Register after all routes: turns body-parser and unexpected errors into JSON
applySecurity.errorHandler = (err, _req, res, _next) => {
  if (err?.type === "entity.too.large")
    return res.status(413).json({ error: "Request too large" });
  if (err instanceof SyntaxError)
    return res.status(400).json({ error: "Invalid JSON" });
  console.error("Unhandled error:", err?.message);
  res.status(500).json({ error: "Server error" });
};

module.exports = applySecurity;
