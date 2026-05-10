import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await esbuild.build({
  plugins: [
    ...denoPlugins({
    }),
  ],
  // Both must be external so the Azure Functions host resolves them from
  // node_modules at runtime; the host injects @azure/functions-core into
  // the worker, and @azure/functions has to be the npm-installed copy
  // (not a second bundled copy) for v4-model app.get(...) registrations
  // to actually reach the host. node_modules is populated by the
  // 'Install Azure Functions runtime deps' step in CI.
  external: ['@azure/functions-core', '@azure/functions'],
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
  for (const file of Deno.readDirSync('node_modules/geoip-country/data')) {
    Deno.link(`node_modules/geoip-country/data/${file.name}`, `data/${file.name}`).catch(() => {})
  }
} catch {
}

esbuild.stop();
