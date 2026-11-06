require("dotenv").config({ override: true });

(async () => {
  const res = await fetch(`${process.env.LLM2_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.LLM2_API_KEY}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    return console.log("Error", res.status, JSON.stringify(data).slice(0, 300));

  (data.data || [])
    .map((m) => m.id.replace(/^models\//, ""))
    .filter(
      (id) =>
        /flash/i.test(id) &&
        !/image|tts|live|embed|audio|robotics|thinking/i.test(id),
    )
    .forEach((id) => console.log(id));
})().catch((err) => console.log("FAILED", err.message, err.cause?.code || ""));
