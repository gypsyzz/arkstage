// CHROME_BIN=/path/to/chrome node scripts/test-storyplayer-csp.mjs
// Offline regression for the packaged Tauri CSP; no Rust or PRTS snapshot needed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

assert.ok(process.env.CHROME_BIN, "Set CHROME_BIN to a Chromium/Chrome executable");
const nonce = randomBytes(16).toString("base64");
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
// Tauri adds hashes/nonces at packaging time, which overrides 'unsafe-inline'.
const csp = config.app.security.csp.replace("script-src ", `script-src 'nonce-${nonce}' `);
const index = await readFile("frontend/index.html", "utf8");
const meta = index.match(/<meta\b[^>]*\bnonce="__TAURI_SCRIPT_NONCE__"[^>]*>/)?.[0] ?? "";
const base = "https://static.prts.wiki/widgets/production/";
const snapshot = {
  entry: base + "StoryPlayer.test.js",
  prelude: [base + "polyfills.test.js"],
  modules: {
    [base + "polyfills.test.js"]: "window.preludeLoaded = true;",
    [base + "StoryPlayer.test.js"]: `
import { shared } from './common.test.js';
export function entryValue() { return 42; }
async function loadContext(script) {
  const lazy = await import('./lazy.test.js');
  if (!window.preludeLoaded || lazy.shared !== shared || shared.value() !== 42) throw Error('module graph broken');
  return { scriptText: script, audioVariables: {}, backgroundPpuMap: {}, linkMap: Object.fromEntries(Array.from({length:100}, (_,i) => [i, {}])) };
}
function collectManifest(context) { const ignored = context.charMap; return { faceAssets: [], urls: ['https://static.prts.wiki/scene.png'] }; }
function createApp(component, props) { return { unmount() {}, mount() { return { getPlayer: () => ({ getState: () => 'playing' }) }; } }; }
const Component = {}, script = 'test', root = document.getElementById('root');
createApp(Component, {script}).mount(root);`,
    [base + "common.test.js"]: "import { entryValue } from './StoryPlayer.test.js'; export const shared = { value: entryValue };",
    [base + "lazy.test.js"]: "export { shared } from './common.test.js';",
  },
  styles: { [base + "style.test.css"]: "body { margin: 0 }" },
  data: Object.fromEntries([
    "https://torappu.prts.wiki/assets/avg/character.json",
    "https://torappu.prts.wiki/assets/avg/background.json",
    "https://torappu.prts.wiki/gamedata/latest/story/story_variables.json",
  ].map(url => [url, Object.fromEntries(Array.from({length:10}, (_,i) => [i, {}]))])),
};
const html = `<!doctype html><html><head>${meta.replaceAll("__TAURI_SCRIPT_NONCE__", nonce)}</head><body><pre id="result">RUNNING</pre>
<script type="module" nonce="${nonce}">
import { bootStoryPlayer, disposeEngineFrame } from '/src/lib/storyPlayerBoot.ts';
const violations = [];
try {
  for (const mode of ['manifest', 'play', 'manifest']) {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
      const boot = bootStoryPlayer({ iframe, bundle: { story_player: ${JSON.stringify(snapshot)} }, script: 'test', title: 'CSP regression', mode });
      iframe.contentWindow.addEventListener('securitypolicyviolation', event => violations.push(event.blockedURI));
      const result = await boot;
      if (result.health.engineScriptCount !== 4) throw Error('incomplete module graph');
      if (mode === 'manifest' && !result.manifest.includes('https://static.prts.wiki/scene.png')) throw Error('invalid manifest');
      if (violations.length) throw Error('CSP violations: ' + violations.join(', '));
    } finally {
      disposeEngineFrame(iframe);
      iframe.remove();
    }
  }
  const unauthorized = document.createElement('script');
  unauthorized.textContent = 'window.unexpectedInlineScript = true';
  document.head.appendChild(unauthorized);
  if (window.unexpectedInlineScript) throw Error('unsigned inline scripts must remain blocked');
  document.querySelector('#result').textContent = 'PASS';
} catch (error) {
  document.querySelector('#result').textContent = 'FAIL: ' + error.message + '; CSP: ' + violations.join(', ');
}
</script></body></html>`;
const server = await createServer({
  root: path.resolve("frontend"), configFile: false,
  server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [process.cwd()] } },
  plugins: [{ name: "storyplayer-csp-test", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/__csp-test") return next();
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Security-Policy", csp);
      res.end(html);
    });
  } }],
});
const profile = await mkdtemp(path.join(os.tmpdir(), "arkstage-csp-"));
try {
  await server.listen();
  const { port } = server.httpServer.address();
  const { stdout } = await promisify(execFile)(process.env.CHROME_BIN, [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking",
    `--user-data-dir=${profile}`, "--dump-dom", "--virtual-time-budget=10000",
    `http://127.0.0.1:${port}/__csp-test`,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const result = stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
  assert.equal(result, "PASS");
  console.log("PASS: packaged CSP, manifest/play/reopen, cyclic/lazy/shared imports");
} finally {
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
