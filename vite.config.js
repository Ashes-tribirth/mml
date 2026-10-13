import { defineConfig } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  base: "/mml/",
  plugins: [{
    name: "copy-onnx-runtime-assets",
    closeBundle() {
      const destination = resolve("dist/ort");
      mkdirSync(destination, { recursive: true });
      for (const filename of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
        copyFileSync(resolve("node_modules/onnxruntime-web/dist", filename), resolve(destination, filename));
      }
    },
  }],
});
