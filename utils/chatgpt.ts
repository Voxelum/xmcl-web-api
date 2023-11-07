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
export interface ChatGPTError {
  error: {
    code: string;
    message: string;
    type: string;
  };
}
export interface ModrinthResponseBody {
  id: string;
  description: string;
  body: string;
  slug: string;
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
        "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo-1106",
        messages,
      }),
    },
  )
    .then((resp) => resp.json())
    .then((s) => s as ChatGPTChatBody | ChatGPTError);
