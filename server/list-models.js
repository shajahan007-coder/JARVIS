require("dotenv").config({ override: true });

(async () => {
  const res = await fetch(`${process.env.LLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` },
  });
  const data = await res.json();

  if (!res.ok) return console.error("Error:", res.status, JSON.stringify(data));

  data.data.forEach((m) => console.log(m.id));
})();
