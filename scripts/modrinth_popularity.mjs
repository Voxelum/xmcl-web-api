// Fetch Modrinth project popularity (downloads) to study the distribution shape.
// Saves raw data to modrinth_popularity.json and renders an SVG chart.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.join(OUT_DIR, 'modrinth_popularity.json')
const SVG_FILE = path.join(OUT_DIR, 'modrinth_popularity.svg')

const UA = 'Voxelum/xmcl-web-api (popularity-research)'
const PAGES = 100 // 100 * 100 = top 10,000 by downloads

async function fetchData() {
  const downloads = []
  const follows = []
  const projects = []
  let total_hits = 0
  for (let p = 0; p < PAGES; p++) {
    const offset = p * 100
    const url = `https://api.modrinth.com/v2/search?index=downloads&limit=100&offset=${offset}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) { console.error('HTTP', res.status, 'at offset', offset); break }
    const j = await res.json()
    for (const h of j.hits) { downloads.push(h.downloads); follows.push(h.follows); projects.push({ id: h.project_id, slug: h.slug, downloads: h.downloads }) }
    total_hits = j.total_hits
    if (p % 10 === 0) console.error('fetched', downloads.length)
    await new Promise(r => setTimeout(r, 120))
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify({ total_hits, downloads, follows, projects }))
  console.error('saved', DATA_FILE)
  return { total_hits, downloads, follows, projects }
}

function stats({ total_hits, downloads }) {
  const N = downloads.length
  const total = downloads.reduce((a, b) => a + b, 0)
  console.log('total_hits (all Modrinth projects):', total_hits)
  console.log('fetched top', N, 'by downloads; their downloads sum =', (total / 1e9).toFixed(2), 'B')
  const marks = [1, 10, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000]
  let cum = 0, mi = 0
  console.log('\nrank | downloads@rank | cum% of top10k')
  for (let i = 0; i < N; i++) {
    cum += downloads[i]
    const r = i + 1
    if (marks[mi] === r) {
      console.log(String(r).padStart(6), '|', String(downloads[i]).padStart(12), '|', (cum / total * 100).toFixed(1) + '%')
      mi++
    }
  }
  console.log('\nratios: r1/r100 =', (downloads[0] / downloads[99]).toFixed(1),
    ' r100/r1000 =', (downloads[99] / downloads[999]).toFixed(1),
    ' r1000/r10000 =', (downloads[999] / downloads[N - 1]).toFixed(1))
}

function renderSVG({ downloads }) {
  const N = downloads.length
  const total = downloads.reduce((a, b) => a + b, 0)
  const W = 900, H = 360, padL = 70, padR = 20, padT = 30, padB = 45
  const pw = W - padL - padR, ph = H - padT - padB
  const maxDl = downloads[0], minDl = Math.max(1, downloads[N - 1])
  const lx = (rank) => padL + (Math.log10(rank) / Math.log10(N)) * pw
  const ly = (dl) => padT + (1 - (Math.log10(Math.max(1, dl)) - Math.log10(minDl)) / (Math.log10(maxDl) - Math.log10(minDl))) * ph
  let pathA = ''
  for (let i = 0; i < N; i++) pathA += (i ? 'L' : 'M') + lx(i + 1).toFixed(1) + ',' + ly(downloads[i]).toFixed(1) + ' '

  const cum = new Array(N)
  let c = 0
  for (let i = 0; i < N; i++) { c += downloads[i]; cum[i] = c / total * 100 }
  const cx = (rank) => padL + (Math.log10(rank) / Math.log10(N)) * pw
  const cy = (pct) => padT + (1 - pct / 100) * ph
  let pathB = ''
  for (let i = 0; i < N; i++) pathB += (i ? 'L' : 'M') + cx(i + 1).toFixed(1) + ',' + cy(cum[i]).toFixed(1) + ' '

  const axisLog = (xfn) => [1, 10, 100, 1000, 10000].map(r => {
    const x = xfn(r)
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + ph}" stroke="#eee"/><text x="${x}" y="${padT + ph + 16}" font-size="11" text-anchor="middle" fill="#666">${r}</text>`
  }).join('')

  const panelA = `<text x="${W/2}" y="18" font-size="14" text-anchor="middle" font-weight="bold">Modrinth downloads vs rank (log-log, top ${N})</text>
  ${axisLog(lx)}
  ${[0,1,2,3,4,5,6,7,8].map(e=>{const y=ly(Math.pow(10,e)); if(y<padT||y>padT+ph)return ''; return `<line x1="${padL}" y1="${y}" x2="${padL+pw}" y2="${y}" stroke="#f3f3f3"/><text x="${padL-6}" y="${y+4}" font-size="10" text-anchor="end" fill="#666">1e${e}</text>`}).join('')}
  <path d="${pathA}" fill="none" stroke="#2563eb" stroke-width="1.5"/>
  <text x="${padL+pw/2}" y="${H-6}" font-size="11" text-anchor="middle" fill="#666">rank (log)</text>`

  const panelB = `<text x="${W/2}" y="18" font-size="14" text-anchor="middle" font-weight="bold">Cumulative % of top-${N} downloads vs rank</text>
  ${axisLog(cx)}
  ${[0,20,40,60,80,100].map(p=>{const y=cy(p);return `<line x1="${padL}" y1="${y}" x2="${padL+pw}" y2="${y}" stroke="#f3f3f3"/><text x="${padL-6}" y="${y+4}" font-size="10" text-anchor="end" fill="#666">${p}%</text>`}).join('')}
  <path d="${pathB}" fill="none" stroke="#dc2626" stroke-width="1.5"/>
  ${[100,500,1000,3000].map(r=>{const x=cx(r),y=cy(cum[r-1]);return `<circle cx="${x}" cy="${y}" r="3" fill="#dc2626"/><text x="${x+4}" y="${y-4}" font-size="10" fill="#dc2626">r${r}:${cum[r-1].toFixed(0)}%</text>`}).join('')}
  <text x="${padL+pw/2}" y="${H-6}" font-size="11" text-anchor="middle" fill="#666">rank (log)</text>`

  const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H*2}">
  <rect width="${W}" height="${H*2}" fill="white"/>
  <g>${panelA}</g>
  <g transform="translate(0,${H})">${panelB}</g>
</svg>`
  fs.writeFileSync(SVG_FILE, combined)
  console.error('wrote', SVG_FILE)
}

const useCache = process.argv.includes('--cache') && fs.existsSync(DATA_FILE)
const data = useCache ? JSON.parse(fs.readFileSync(DATA_FILE)) : await fetchData()
stats(data)
renderSVG(data)
