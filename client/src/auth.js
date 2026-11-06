export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const TOKEN_KEY = 'jarvis_token';
const EMAIL_KEY = 'jarvis_email';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getEmail = () => localStorage.getItem(EMAIL_KEY) || '';

export const saveAuth = (token, email) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, email);
};

export const clearAuth = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
};

// fetch() that adds the login token. A 401 sends the user back to the login screen.
export async function authFetch(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${getToken()}` }
    });
    if (res.status === 401) {
        clearAuth();
        window.dispatchEvent(new Event('jarvis-logout'));
    }
    return res;
}