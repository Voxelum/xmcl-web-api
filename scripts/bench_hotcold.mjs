import zlib from 'node:zlib'
import fs from 'node:fs'

const Z = zlib.constants
const GROUP = 4

function readBlobs(name) {
  const buf = fs.readFileSync(`/tmp/hc_${name}.blobs`)
  const blobs = []
  let o = 0
  while (o < buf.length) { const len = buf.readUInt32LE(o); o += 4; blobs.push(buf.subarray(o, o + len)); o += len }
  return blobs
}
function blockSize(blobs, encode) {
  let size = 0
  for (let i = 0; i < blobs.length; i += GROUP) {
    const chunk = blobs.slice(i, i + GROUP)
    const joined = Buffer.concat(chunk.flatMap((b, k) => (k ? [Buffer.from([0]), b] : [b])))
    size += encode(joined).length
  }
  return size
}
const zstdEnc = (d) => (b) => zlib.zstdCompressSync(b, { dictionary: d, params: { [Z.ZSTD_c_compressionLevel]: 19 } })
const brEnc = (d) => (b) => zlib.brotliCompressSync(b, { dictionary: d, params: { [Z.BROTLI_PARAM_QUALITY]: 11 } })

const which = process.argv.slice(2)
const splits = which.length ? which : ['zh-TW_hot', 'zh-TW_cold', 'ru_hot', 'ru_cold']
console.log('split'.padEnd(16), '| records | zstd+dict | brotli+dict | (+dict+idx)')
for (const name of splits) {
  if (!fs.existsSync(`/tmp/hc_${name}.blobs`)) { console.log(name, 'missing'); continue }
  const blobs = readBlobs(name)
  const dict = fs.readFileSync(`/tmp/hc_${name}.dict`)
  const zs = blockSize(blobs, zstdEnc(dict))
  const br = blockSize(blobs, brEnc(dict))
  const idx = blobs.length * (4 + 8) + Math.ceil(blobs.length / GROUP + 1) * 4
  const over = (dict.length + idx) / 1e6
  console.log(name.padEnd(16), '|', String(blobs.length).padStart(7), '|',
    (zs / 1e6).toFixed(2).padStart(7), 'MB|', (br / 1e6).toFixed(2).padStart(7), 'MB| +', over.toFixed(2), 'MB')
}
