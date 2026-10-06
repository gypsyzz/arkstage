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
function buildManifest(context, lines) { const ignored = context.charMap; const urls = []; for (const line of lines) urls.push(line.url); return { faceAssets: [], urls: urls }; }
function parseContextScript(context) { return context.scriptText.split('\\n').map(() => ({ url: 'https://static.prts.wiki/scene.png' })); }
function collectManifest(context) { return buildManifest(context, parseContextScript(context)); }
function createApp(component, props) { return { unmount() {}, mount(root) {
  root.innerHTML = '<main class="story-player"><section><div class="bg-black"><div class="host"><canvas width="1280" height="720"></canvas></div></div></section><div class="n-card" aria-label="播放控制"><button>自动</button></div></main>';
  return { getPlayer: () => ({ getState: () => 'playing' }) };
} }; }
const Component = {}, script = 'test', root = document.getElementById('root');
createApp(Component, {script}).mount(root);`,
    [base + "common.test.js"]: "import { entryValue } from './StoryPlayer.test.js'; export const shared = { value: entryValue };",
    [base + "lazy.test.js"]: "export { shared } from './common.test.js';",
  },
  styles: { [base + "style.test.css"]: `
    .story-player{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;width:100%;min-height:100%;padding:24px;gap:14px}
    .story-player>section{position:relative;width:100%;overflow:hidden;aspect-ratio:16/9;max-width:1280px}
    .story-player>section>.bg-black{position:absolute;inset:0}
    .host,canvas{width:100%;height:100%}canvas{display:block}
    .n-card{width:100%;height:148px;background:#fff}
  ` },
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
      if (mode === 'play') {
        const toggle = iframe.contentDocument.querySelector('.arkstage-controls-toggle');
        const controls = iframe.contentDocument.querySelector('.story-player>.n-card');
        if (!toggle || toggle.getAttribute('aria-expanded') !== 'false') throw Error('controls should start collapsed');
        for (const [width, height] of [[1280,579], [1280,720], [800,1000]]) {
          iframe.style.cssText = 'border:0;width:' + width + 'px;height:' + height + 'px';
          for (const expanded of [false, true, false]) {
            if (toggle.getAttribute('aria-expanded') !== String(expanded)) toggle.click();
            const visible = iframe.contentWindow.getComputedStyle(controls).display !== 'none';
            if (visible !== expanded || toggle.getAttribute('aria-expanded') !== String(expanded)) throw Error('controls toggle failed');
            const rect = iframe.contentDocument.querySelector('canvas').getBoundingClientRect();
            if (!rect.height || Math.abs(rect.width / rect.height - 16 / 9) > 0.002) throw Error('distorted picture at ' + width + 'x' + height);
            if (rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1) throw Error('cropped picture');
            const available = height - (visible ? controls.getBoundingClientRect().height : 0);
            if (Math.abs(rect.height - Math.min(available, width * 9 / 16)) > 1) throw Error('picture does not fill available space');
          }
        }
      }
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
  console.log("PASS: packaged CSP, manifest/play/reopen, cyclic/lazy/shared imports, 16:9 layout and controls toggle");
} finally {
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
