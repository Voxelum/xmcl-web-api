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

export const chat = (messages: Message[]) => {
  const key = Deno.env.get("OPENAI_API_KEY")!
  // console.log('APIKey:' + key?.substring(0, 5) + '...' + key?.substring(key.length - 5))
  return fetch(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
      }),
    },
  )
    .then((resp) => resp.json())
    .then((s) => s as ChatGPTChatBody | ChatGPTError);
}