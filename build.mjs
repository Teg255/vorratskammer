// Builds the static site into dist/: bundles the code, copies the barcode
// reader (.wasm), icons and config. Run with `npm run build`.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });

await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari15", "chrome100"],
  outfile: "dist/assets/app.js",
  logLevel: "info",
});

cpSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", "dist/assets/zxing_reader.wasm");
cpSync("public", "dist", { recursive: true });
cpSync("index.html", "dist/index.html");
cpSync("config.js", "dist/config.js");

const version = Date.now().toString(36);
writeFileSync("dist/sw.js", readFileSync("dist/sw.js", "utf8").replace("__VERSION__", version));
writeFileSync("dist/.nojekyll", "");
console.log("Build fertig:", version);
