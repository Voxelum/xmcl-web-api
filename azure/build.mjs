// Bundles azure/index.ts (the Azure Functions v4 Node entry) into
// azure/index.js. Replaces the previous build.ts (Deno+esbuild) so the
// CI runs entirely on the standard Node toolchain -- no Deno install
// required, and the resulting bundle plays nicely with the v4 worker
// indexing model.
//
// @azure/functions and @azure/functions-core are kept external so the
// host loads the npm-installed copies and the worker indexer can attach
// to its host-side @azure/functions-core injection.
import { build } from 'esbuild'
import { existsSync, readdirSync, copyFileSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'azure/index.ts')],
  outfile: join(root, 'azure/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [
    '@azure/functions-core',
    '@azure/functions',
    // geoip-country reads its data files relative to its own package
    // location at runtime; bundling it loses that path resolution and
    // causes ENOENT for geoip-city.dat on require. Keep it external so
    // the npm-installed copy with its bundled data/*.dat is used.
    'geoip-country',
  ],
  sourcemap: true,
  treeShaking: true,
  // Allow imports written as `from "npm:foo"` (Deno style) to also
  // resolve from node_modules. Lets us share source files with the Deno
  // entry point without a second copy.
  plugins: [
    {
      name: 'strip-npm-prefix',
      setup(b) {
        b.onResolve({ filter: /^npm:/ }, async args => {
          const path = args.path.replace(/^npm:/, '').replace(/@\^?\d.*$/, '')
          return b.resolve(path, {
            kind: args.kind,
            resolveDir: args.resolveDir,
          })
        })
      },
    },
  ],
})

// geoip-country is external (see build.mjs); it reads its bundled
// data/*.dat at runtime relative to node_modules/geoip-country, so the
// previous step that copied the data files into ./data/ is no longer
// needed. Left here as a comment in case we ever inline the package
// again.
//
// const dataSrc = join(root, 'node_modules/geoip-country/data')
// const dataDst = join(root, 'data')
// if (existsSync(dataSrc)) {
//   mkdirSync(dataDst, { recursive: true })
//   for (const file of readdirSync(dataSrc)) {
//     copyFileSync(join(dataSrc, file), join(dataDst, file))
//   }
// }
