import type { FrameBootOptions, FrameBootResult } from "./engineBoot";
import { captureIframe, pushLog } from "./debugLog";
import { PROXY_BASE, discoverAssetDomains, proxyUrl, rewriteAllCdnUrls } from "./proxy";
import { adaptStoryPlayerEntry, prepareModule, storyPlayerStaticAssets, validateStoryPlayer } from "./storyPlayerAdapter";

interface PlayerContext { script: string[]; scriptText: string; linkMap: Record<string, unknown> }
interface StoryPlayerWindow extends Window {
  __arkstageAPI?: { loadContext: (script: string) => Promise<PlayerContext>; collectManifest: (context: PlayerContext) => { urls: string[] } };
  __arkstageMount?: () => void;
  __arkstageApp?: { getPlayer: () => { getState: () => string; destroy: () => void } | null };
  __arkstageVueApp?: { unmount: () => void };
  __arkstageDispose?: () => void;
  mw?: unknown;
}

/** Pixi and HTML audio can assign src directly instead of calling fetch. */
function installMediaTransport(win: StoryPlayerWindow, domains: string[]): void {
  const realm = win as unknown as typeof globalThis;
  for (const proto of [realm.HTMLImageElement.prototype, realm.HTMLMediaElement.prototype, realm.HTMLSourceElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, "src");
    if (desc?.set) Object.defineProperty(proto, "src", { ...desc, set(value: string) { desc.set!.call(this, proxyUrl(String(value), domains)); } });
  }
  const setAttribute = realm.Element.prototype.setAttribute;
  realm.Element.prototype.setAttribute = function(name, value) {
    return setAttribute.call(this, name, name.toLowerCase() === "src" ? proxyUrl(String(value), domains) : value);
  };
  realm.Audio = new Proxy(realm.Audio, { construct(target, args) {
    return Reflect.construct(target, args.length ? [proxyUrl(String(args[0]), domains)] : []);
  } });
}

export function disposeEngineFrame(iframe: HTMLIFrameElement): void {
  const win = iframe.contentWindow as StoryPlayerWindow | null;
  win?.__arkstageDispose?.();
  iframe.contentDocument?.querySelectorAll("audio,video").forEach((el) => (el as HTMLMediaElement).pause());
}

export async function bootStoryPlayer(opts: FrameBootOptions): Promise<FrameBootResult> {
  const snapshot = opts.bundle.story_player!;
  const problems = validateStoryPlayer(snapshot);
  if (problems.length) throw new Error(problems.join("；"));
  const doc = opts.iframe.contentDocument;
  const win = opts.iframe.contentWindow as StoryPlayerWindow | null;
  if (!doc || !win) throw new Error("StoryPlayer iframe unavailable");
  const domains = discoverAssetDomains(...Object.values(snapshot.modules), ...Object.values(snapshot.styles));
  const cancelled = () => opts.isCancelled?.() || !opts.iframe.isConnected;
  const blobUrls: string[] = [];
  let disposed = false;
  win.__arkstageDispose = () => {
    if (disposed) return;
    disposed = true;
    // Vue's unmount hook owns player.destroy(); do not destroy it twice.
    if (win.__arkstageVueApp) win.__arkstageVueApp.unmount();
    else win.__arkstageApp?.getPlayer()?.destroy();
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
  };
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><pre id="datas_txt" hidden></pre></body></html>');
  doc.close();
  doc.title = opts.title;
  doc.getElementById("datas_txt")!.textContent = opts.script;
  win.mw = { config: { get: (key: string) => key === "wgUserName" ? localStorage.getItem("prts-nickname") : null } };
  captureIframe(win);
  if (opts.mode === "play") installMediaTransport(win, domains);

  // Sidecars come from this verified snapshot; all other fetches use the same
  // cache-through transport as media. Never let mutable JSON bypass the snapshot.
  const nativeFetch = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    // URL/Request instances can belong to the iframe's realm.
    const raw = typeof input === "string" ? input : "href" in input ? input.href : input.url;
    const key = Object.keys(snapshot.data).find((url) => url === raw || proxyUrl(url, domains) === raw);
    const value = key ? snapshot.data[key] : undefined;
    if (value) return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    return nativeFetch(typeof input === "string" || "href" in input ? proxyUrl(raw, domains) : new Request(proxyUrl(raw, domains), input), init);
  };

  try {
    const imports: Record<string, string> = {};
    for (const [url, original] of Object.entries(snapshot.modules)) {
      let source = url === snapshot.entry ? adaptStoryPlayerEntry(original) : original;
      source = await prepareModule(source, url, snapshot.modules);
      // Keep URLs in the manifest canonical. Playback source routes image/audio,
      // FontFace and Pixi loaders through the local media protocol.
      if (opts.mode === "play") {
        source = rewriteAllCdnUrls(source, domains);
        // StoryPlayer also builds URLs from a bare TORAPPU_ORIGIN constant.
        // Rewrite that constant before Pixi sends a URL to its image worker;
        // the worker has its own fetch realm and cannot inherit our fetch shim.
        for (const domain of domains) for (const quote of ['"', "'", "`"])
          source = source.replaceAll(`https://${domain}${quote}`, `${PROXY_BASE}/${domain}${quote}`);
      }
      const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      imports[opts.mode === "play" ? proxyUrl(url, domains) : url] = blob;
      blobUrls.push(blob);
    }
    if (cancelled()) { win.__arkstageDispose(); return {}; }
    const map = doc.createElement("script");
    map.type = "importmap";
    // The iframe inherits Tauri's CSP, where hashes/nonces disable unsafe-inline.
    // Read .nonce: browsers hide the attribute value from getAttribute().
    map.nonce = opts.iframe.ownerDocument.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? "";
    map.textContent = JSON.stringify({ imports });
    doc.head.appendChild(map);
    if (opts.mode === "play") {
      for (const [url, source] of Object.entries(snapshot.styles)) {
        const style = doc.createElement("style");
        style.textContent = rewriteAllCdnUrls(source.replace(/url\(\s*(["']?)([^\s)"']+)\1\s*\)/g,
          (_all, _quote, path: string) => `url(${JSON.stringify(new URL(path, url).href)})`), domains);
        doc.head.appendChild(style);
      }
      // Keep the canvas and its click targets together in a fitted 16:9 frame.
      const layout = doc.createElement("style");
      layout.textContent = `html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
        .story-player{height:100dvh!important;padding:0!important;gap:0!important}
        .story-player>section{flex:1;min-height:0;max-width:none!important;aspect-ratio:auto!important;container-type:size;display:flex;align-items:center;justify-content:center}
        .story-player>section>.bg-black{position:relative;inset:auto;width:min(100cqw,calc(100cqh * 16 / 9));height:min(100cqh,calc(100cqw * 9 / 16))}
        .story-player>.n-card{flex:none;max-width:none!important;max-height:40dvh;overflow:auto;border-radius:0}
        body:not(.arkstage-controls-open) .story-player>.n-card{display:none}
        .story-player .n-card__content{padding:6px 10px!important}
        .arkstage-controls-toggle{position:fixed;top:6px;right:max(6px,env(safe-area-inset-right));z-index:20;min-height:44px;padding:6px 10px;border:1px solid #ffffff38;border-radius:6px;background:#0009;color:#fff;font:14px sans-serif;cursor:pointer}`;
      doc.head.appendChild(layout);
    }
    for (const entry of [...(snapshot.prelude ?? []), snapshot.entry]) await new Promise<void>((resolve, reject) => {
      const script = doc.createElement("script");
      script.type = "module";
      script.src = imports[opts.mode === "play" ? proxyUrl(entry, domains) : entry];
      const timer = setTimeout(() => reject(new Error("StoryPlayer 模块启动超时")), 30_000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); reject(new Error("StoryPlayer 模块执行失败")); };
      doc.body.appendChild(script);
    });
    if (cancelled()) { win.__arkstageDispose(); return {}; }
    if (!win.__arkstageAPI || !win.__arkstageMount) throw new Error("StoryPlayer 接口未初始化");
    // Playback modules return proxy URLs; sidecar lookup must recognize them too.
    const api = win.__arkstageAPI;
    const context = await api.loadContext(opts.script);
    if (Object.keys(context.linkMap).length < 100) throw new Error("StoryPlayer 角色数据未初始化");
    const manifest = [...new Set([...api.collectManifest(context).urls, ...storyPlayerStaticAssets(snapshot)])];
    const health = { globals: ["StoryPlayer", "loadContext", "collectManifest", "mount"], engineScriptCount: Object.keys(snapshot.modules).length, assetDomains: domains };
    if (opts.mode === "manifest") return { manifest, health };
    win.__arkstageMount();
    const controlsToggle = doc.createElement("button");
    controlsToggle.className = "arkstage-controls-toggle";
    controlsToggle.textContent = "显示控制";
    controlsToggle.setAttribute("aria-expanded", "false");
    controlsToggle.onclick = () => {
      const expanded = doc.body.classList.toggle("arkstage-controls-open");
      controlsToggle.textContent = expanded ? "隐藏控制" : "显示控制";
      controlsToggle.setAttribute("aria-expanded", String(expanded));
    };
    // Stay inside the upstream fullscreen element so the toggle remains reachable.
    doc.querySelector(".story-player")?.appendChild(controlsToggle);
    // AutoStart creates the renderer before preloading completes. Wait for the
    // runtime to actually start so visible boot errors can trigger rollback.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (cancelled()) { win.__arkstageDispose(); return {}; }
      const state = win.__arkstageApp?.getPlayer()?.getState();
      const alert = doc.querySelector(".story-player > section .n-alert");
      if (alert || state === "error") throw new Error(alert?.textContent || "StoryPlayer 播放初始化失败");
      if (state && state !== "idle") {
        pushLog("info", `[StoryPlayer] ${opts.title}: ${manifest.length} assets, ${health.engineScriptCount} modules`);
        return { health };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("StoryPlayer 资源预加载超时");
  } catch (error) {
    win.__arkstageDispose();
    throw error;
  }
}
