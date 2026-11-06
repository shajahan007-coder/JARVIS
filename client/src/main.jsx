import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import LoginScreen from "./LoginScreen.jsx";
import { getToken, getEmail, clearAuth } from "./auth.js";

function Root() {
  const [authed, setAuthed] = useState(!!getToken());

  // authFetch fires this when the server answers 401 (expired or invalid token)
  useEffect(() => {
    const onLogout = () => setAuthed(false);
    window.addEventListener("jarvis-logout", onLogout);
    return () => window.removeEventListener("jarvis-logout", onLogout);
  }, []);

  const logout = () => {
    clearAuth();
    setAuthed(false);
  };

  if (!authed) return <LoginScreen onAuthed={() => setAuthed(true)} />;

  return (
    <>
      <button
        onClick={logout}
        title={getEmail()}
        style={{
          position: "fixed",
          top: "1px",
          right: "8px",
          zIndex: 30,
          background: "none",
          border: "none",
          color: "#475569",
          fontSize: "10px",
          cursor: "pointer",
          padding: "1px 6px",
        }}
      >
        Logout
      </button>
      <App />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
