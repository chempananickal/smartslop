import initRDKitModule from "@rdkit/rdkit";
import { analyzeReactionRequest } from "./reaction-analysis.mjs";

let rdkitModulePromise;

async function loadRdkitModule() {
  if (!rdkitModulePromise) {
    rdkitModulePromise = initRDKitModule();
  }

  return rdkitModulePromise;
}

export async function rdkitTemplateAdapter(bridgeRequest) {
  const RDKitModule = await loadRdkitModule();
  return analyzeReactionRequest(RDKitModule, bridgeRequest);
}