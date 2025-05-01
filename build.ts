import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await esbuild.build({
  plugins: [
    ...denoPlugins({
    }),
  ],
  external: ['@azure/functions-core'],
  platform: "node",
  entryPoints: ["./azure/index.ts"],
  outfile: "azure/index.js",
  bundle: true,
  format: "cjs",
  target: "esnext",
  minify: false,
  sourcemap: true,
  treeShaking: true,
});

try {
  for (const file of Deno.readDirSync('node_modules/geoip-lite/data')) {
    Deno.link(`node_modules/geoip-lite/data/${file.name}`, `data/${file.name}`).catch(() => {})
  }
} catch {
}

esbuild.stop();
