export interface ChatGPTChatBody {
  id: string;
  object: string;
  model: string;
  choices: {
    message: { content: string };
    index: number;
    finish_reason: string;
  }[];
}
export interface ModrinthResponseBody {
  id: string;
  description: string;
  body: string;
}

export interface Message {
  content: string;
  role: string;
}

export interface ChatGPTBody {
  id: string;
  object: string;
  model: string;
  choices: { text: string; index: number; finish_reason: string }[];
}

export const chat = (messages: Message[]) =>
  fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          "Bearer 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",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
      }),
    },
  )
    .then((resp) => resp.json())
    .then((s) => s as ChatGPTChatBody);
