import { analyzeReactionRequest } from "../js/reaction-analysis.mjs";

let rdkitScriptPromise;
let rdkitModulePromise;

function rdkitBaseUrl() {
  return new URL("../vendor/rdkit/", import.meta.url);
}

function ensureRdkitScript() {
  if (window.initRDKitModule) {
    return Promise.resolve();
  }

  if (!rdkitScriptPromise) {
    rdkitScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("RDKit_minimal.js", rdkitBaseUrl()).href;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load RDKit browser bundle."));
      document.head.append(script);
    });
  }

  return rdkitScriptPromise;
}

export async function loadBrowserRdkit() {
  await ensureRdkitScript();

  if (!rdkitModulePromise) {
    rdkitModulePromise = window.initRDKitModule({
      locateFile: (file) => new URL(file, rdkitBaseUrl()).href
    });
  }

  return rdkitModulePromise;
}

export async function rdkitTemplateAdapterBrowser(request) {
  const RDKitModule = await loadBrowserRdkit();
  return analyzeReactionRequest(RDKitModule, request);
}