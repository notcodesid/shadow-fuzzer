import { defineConfig } from "tsup";

// Bundle the agent's source into the CLI's dist so the published npm
// package is self-contained — pnpm `workspace:*` references don't
// survive `npm publish`. Everything else (web3.js, magicblock SDK,
// anchor, etc.) stays external; npm pulls them in normally on install.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  noExternal: ["@shadow-fuzzer/agent"],
});
