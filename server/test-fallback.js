require("dotenv").config({ override: true });

const { LLM2_API_KEY, LLM2_BASE_URL, LLM2_MODEL } = process.env;

(async () => {
  if (!LLM2_API_KEY || !LLM2_BASE_URL || !LLM2_MODEL) {
    return console.log(
      "Set LLM2_API_KEY, LLM2_BASE_URL and LLM2_MODEL in .env first",
    );
  }

  const res = await fetch(`${LLM2_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM2_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM2_MODEL,
      max_tokens: 500,
      messages: [
        { role: "user", content: "What is the weather in Madurai right now?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    return console.log(
      "FAILED",
      res.status,
      JSON.stringify(data).slice(0, 400),
    );

  const msg = data.choices?.[0]?.message;
  console.log(
    msg?.tool_calls?.length
      ? `OK: tool call -> ${msg.tool_calls[0].function.name} ${msg.tool_calls[0].function.arguments}`
      : `Replied without a tool call: ${msg?.content}`,
  );
})().catch((err) => console.log("FAILED", err.message, err.cause?.code || ""));
