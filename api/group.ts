import { defineApi } from "../type.ts"
import { nanoid } from "https://deno.land/x/nanoid@v3.0.0/mod.ts"

export default defineApi((req, url) => {
    if (req.headers.get('upgrade') !== 'websocket') {
        return new Response('Not supported', { status: 405 })
    }

    // const authorization = req.headers.get('Authorization')
    // if (!authorization) {
        // return new Response('Unauthenticated', { status: 401 })
    // }

    const group = url.searchParams.get('id') || nanoid()
    const channel = new BroadcastChannel(group);

    const { response, socket } = Deno.upgradeWebSocket(req)
    console.log(`Get join group request ${group}!`)

    socket.onopen = () => {
        console.log(`Websocket created ${group}!`)
        channel.addEventListener('message', ({ data }) => {
            console.log(`Get message from broadcast channel ${group}`)
            console.log(data)
            socket.send(data)
        });
        socket.send('{ "created": true }')
    }

    socket.onmessage = (ev) => {
        const data = ev.data
        console.log(`Get message from client side & send to channel ${group}`)
        console.log(data)
        channel.postMessage(data)
    }

    socket.onclose = () => {
        console.log(`Websocket closed ${group}!`)
        channel.close()
    }

    return response
})