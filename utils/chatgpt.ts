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

export interface ChatOptions {
  messages: Message[];
  api?: string;
  model?: string;
  key?: string;
  [key: string]: any; // Additional parameters
}

export const chat = ({ messages, api, model, key, ...rest }: ChatOptions) => {
  // console.log('APIKey:' + key?.substring(0, 5) + '...' + key?.substring(key.length - 5))
  return fetch(
    api ?? 'https://api.deepseek.com/chat/completions',
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key ?? Deno.env.get("OPENAI_API_KEY")!}`,
      },
      body: JSON.stringify(Object.assign({
        model: model ?? "deepseek-chat",
        messages,
      }, rest)),
    },
  )
    .then((resp) => resp.json())
    .then((s) => s as ChatGPTChatBody | ChatGPTError);
}