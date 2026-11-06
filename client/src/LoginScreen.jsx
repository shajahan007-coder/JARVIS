import { useState } from "react";
import { API_URL, saveAuth } from "./auth.js";

export default function LoginScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'register'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError("");

    if (mode === "register" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token)
        throw new Error(data.error || "Something went wrong");

      saveAuth(data.token, data.user?.email || email);
      onAuthed();
    } catch (err) {
      setError(
        err.message === "Failed to fetch"
          ? "Cannot reach the server. Is it running?"
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const input = {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #1e3a5f",
    background: "#0f1b33",
    color: "white",
    fontSize: "16px",
    outline: "none",
    marginBottom: "12px",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b1120",
        fontFamily: "system-ui, sans-serif",
        color: "#e2e8f0",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "340px",
          maxWidth: "90vw",
          padding: "28px",
          border: "1px solid #1e3a5f",
          borderRadius: "12px",
          background: "rgba(17,34,64,0.85)",
        }}
      >
        <h1
          style={{
            margin: "0 0 4px",
            textAlign: "center",
            fontSize: "22px",
            letterSpacing: "6px",
            color: "#38bdf8",
          }}
        >
          J.A.R.V.I.S.
        </h1>
        <p
          style={{
            margin: "0 0 20px",
            textAlign: "center",
            color: "#64748b",
            fontSize: "13px",
          }}
        >
          {mode === "login"
            ? "Welcome back, sir. Identify yourself."
            : "Create your account."}
        </p>

        <input
          style={input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          style={input}
          type="password"
          placeholder={
            mode === "register" ? "Password (min 8 characters)" : "Password"
          }
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={
            mode === "register" ? "new-password" : "current-password"
          }
        />

        {error && (
          <div
            style={{
              background: "#450a0a",
              color: "#fca5a5",
              padding: "8px 12px",
              borderRadius: "8px",
              fontSize: "14px",
              marginBottom: "12px",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: "8px",
            border: "none",
            background: busy ? "#1e3a5f" : "#38bdf8",
            color: "#0b1120",
            fontWeight: 700,
            fontSize: "16px",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy
            ? "Please wait..."
            : mode === "login"
              ? "Log in"
              : "Create account"}
        </button>

        <p
          style={{
            margin: "16px 0 0",
            textAlign: "center",
            fontSize: "13px",
            color: "#94a3b8",
          }}
        >
          {mode === "login" ? "No account yet? " : "Already registered? "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            style={{
              background: "none",
              border: "none",
              color: "#38bdf8",
              cursor: "pointer",
              fontSize: "13px",
              padding: 0,
            }}
          >
            {mode === "login" ? "Register" : "Log in"}
          </button>
        </p>
      </form>
    </div>
  );
}
