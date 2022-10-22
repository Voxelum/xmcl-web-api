import { defineApi } from "../type.ts"
import { nanoid } from "https://deno.land/x/nanoid@v3.0.0/mod.ts"

export default defineApi(async (req, url) => {
    if (req.method === 'GET') {
        const group = url.searchParams.get('id') || nanoid()
        const channel = new BroadcastChannel(group);

        console.log(`Get join group request ${group}!`)
        const stream = new ReadableStream({
            start: (controller) => {
                channel.addEventListener('message', ({ data }) => {
                    console.log(`Get broadcast message from channel ${group}`)
                    console.log(data)
                    controller.enqueue({ data });
                });
            },
            cancel() {
                channel.close();
            },
        });

        return new Response(stream.pipeThrough(new TextEncoderStream()), {
            headers: { "content-type": "text/event-stream" },
        });
    }
    if (req.method === 'PUT') {
        const group = url.searchParams.get('id')

        if (!group) {
            return new Response('Bad Request', { status: 400 })
        }

        const channel = new BroadcastChannel(group);
        
        const data = await req.json()
        console.log(`broadcast message to group ${group}`)
        console.log(data)
        channel.postMessage(data)
        channel.close()

        return new Response("OK");
    }
    return new Response('Not supported', { status: 405 })
})