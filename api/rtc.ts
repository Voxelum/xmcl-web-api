import { defineApi } from "../type.ts";
import { hmac } from "https://deno.land/x/hmac@v2.0.1/mod.ts";
// import {
//     Bson,
//     MongoClient,
// } from "https://deno.land/x/mongo@v0.31.1/mod.ts";
import { Status } from "https://deno.land/x/oak@v11.1.0/mod.ts";

interface MicrosoftMinecraftProfile {
    id: string
    name: string
}

function getTURNCredentials(name: string, secret: string) {
    const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600

    const username = [unixTimeStamp, name].join(':')
    const password = hmac('sha1', secret, username, 'utf-8', 'base64');

    return {
        username,
        password,
        ttl: 86400,
        uris: [
            'turn:20.239.69.131'
        ]
    };
}

async function getMicrosoftProfile(token: string) {
    const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
        },
    })
    if (response.status !== 200) {
        throw new Error()
    }
    return await response.json() as MicrosoftMinecraftProfile
}

async function checkMicrosoftAuthenticate(authorization: string) {
    const response = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: {
            Authorization: authorization,
        }
    })
    if (response.status === 200) {
        const content = await response.json()
        const { id, userPrincipalName } = content
        return { id: id as string, userPrincipalName: userPrincipalName as string }
    }
    throw ({ statusCode: response.status, error: 'Fail to request microsoft graph to verify user!' })
}

export default defineApi((router) => {
    const secret = Deno.env.get('RTC_SECRET')
    if (secret) {
        router.post('/rtc/official', async (context) => {
            const authorization = context.request.headers.get('authorization')
            if (!authorization || !authorization.startsWith('Bearer ')) {
                return context.throw(Status.BadRequest, 'Require authorization header')
            }

            const accessToken = authorization.substring('Bearer '.length)
            try {
                const profile = await getMicrosoftProfile(accessToken)
                const id = profile.id
                context.response.body = getTURNCredentials(id, secret)
            } catch (e) {
                console.error(e)
                context.throw(Status.Unauthorized)
            }
        })
        router.post('/rtc/microsoft', async (context) => {
            const authorization = context.request.headers.get('authorization')
            if (!authorization || !authorization.startsWith('Bearer ')) {
                return context.throw(Status.BadRequest, 'Require authorization header')
            }
            const accessToken = authorization.substring('Bearer '.length)

            try {
                const { id } = await checkMicrosoftAuthenticate(accessToken)
                context.response.body = getTURNCredentials(id, secret)
            } catch (e) {
                console.error(e)
                context.throw(Status.Unauthorized)
            }
        })
    }
})