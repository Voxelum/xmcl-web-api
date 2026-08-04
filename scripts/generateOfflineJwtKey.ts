const keyId = Deno.args[0] ||
  `xmcl-offline-${new Date().toISOString().slice(0, 10)}`;
const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;
const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

console.log(JSON.stringify(
  {
    keyId,
    privateJwk: { ...privateJwk, kid: keyId, alg: "RS256", use: "sig" },
    publicJwks: {
      keys: [{
        ...publicJwk,
        kid: keyId,
        alg: "RS256",
        use: "sig",
        key_ops: ["verify"],
      }],
    },
  },
  null,
  2,
));
