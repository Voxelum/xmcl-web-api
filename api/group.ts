import { defineApi } from "../type.ts"

export default defineApi(async (req, url) => {
    if (req.method === 'GET') {
        const group = url.pathname.substring(url.pathname.lastIndexOf('/'))
        const channel = new BroadcastChannel(group);

        const stream = new ReadableStream({
            start: (controller) => {
                channel.addEventListener('message', ({ data }) => {
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
        const group = url.pathname.substring(url.pathname.lastIndexOf('/'))

        const channel = new BroadcastChannel(group);

        const data = await req.json()
        channel.postMessage(data)
        channel.close()

        return new Response("OK");
    }
    return new Response('Not supported', { status: 405 })
})