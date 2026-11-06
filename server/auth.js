const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "JWT_SECRET is missing or shorter than 32 characters. Add a long random value to server/.env",
  );
  process.exit(1);
}

const UserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS); // keeps login timing similar for unknown emails

const signToken = (user) =>
  jwt.sign({ sub: String(user._id) }, JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "7d",
  });

const parseCredentials = (body) => {
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  return { email, password };
};

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password } = parseCredentials(req.body);

    if (!EMAIL_REGEX.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    if (password.length < 8 || Buffer.byteLength(password) > 72) {
      return res
        .status(400)
        .json({ error: "Password must be 8 to 72 characters" });
    }
    if (await User.exists({ email })) {
      return res
        .status(409)
        .json({ error: "That email is already registered" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({ email, passwordHash });
    res
      .status(201)
      .json({ token: signToken(user), user: { email: user.email } });
  } catch (err) {
    if (err?.code === 11000)
      return res
        .status(409)
        .json({ error: "That email is already registered" });
    console.error("Register Error:", err.message);
    res.status(500).json({ error: "Could not create account" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = parseCredentials(req.body);
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email });
    const ok = await bcrypt.compare(
      password,
      user ? user.passwordHash : DUMMY_HASH,
    );
    if (!user || !ok)
      return res.status(401).json({ error: "Invalid email or password" });

    res.json({ token: signToken(user), user: { email: user.email } });
  } catch (err) {
    console.error("Login Error:", err.message);
    res.status(500).json({ error: "Could not log in" });
  }
});

// Protects everything registered after it. The logged-in user's ID replaces any client-sent
// sessionId, so all existing routes automatically work on the right user's data.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Please log in" });

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    const id = String(payload.sub);
    req.userId = id;

    // defineProperty works on Express 4 and 5 (req.query is read-only in Express 5)
    Object.defineProperty(req, "query", {
      value: { ...req.query, sessionId: id },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    if (req.body && typeof req.body === "object")
      req.body = { ...req.body, sessionId: id };

    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

module.exports = { router, requireAuth };
