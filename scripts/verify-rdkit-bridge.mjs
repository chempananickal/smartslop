import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const tmpDir = path.join(rootDir, ".tmp");
const cargoTargetDir = path.join(rootDir, "target", "wasm-pack");
mkdirSync(tmpDir, { recursive: true });
mkdirSync(cargoTargetDir, { recursive: true });

execFileSync(
  "wasm-pack",
  ["build", "--target", "nodejs", "--dev", "--out-dir", "pkg-node"],
  {
    cwd: rootDir,
    env: {
      ...process.env,
      TMPDIR: process.env.TMPDIR ?? tmpDir,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? cargoTargetDir
    },
    stdio: "inherit"
  }
);

const pkgDir = path.join(rootDir, "pkg-node");
const wasmModule = await import(pathToFileURL(path.join(pkgDir, "smartslop_wasm.js")).href);
const { rdkitTemplateAdapter } = await import(pathToFileURL(path.join(rootDir, "js", "rdkit-bridge.mjs")).href);

const sampleRequest = {
  reactants: [
    {
      format: "smiles",
      value: "CCBr",
      label: "bromoethane"
    },
    {
      format: "smiles",
      value: "O",
      label: "water"
    }
  ],
  products: [
    {
      format: "smiles",
      value: "CCO",
      label: "ethanol"
    }
  ],
  reaction_smarts: "[CH3:1][CH2:2][Br:3].[OH2:4]>>[CH3:1][CH2:2][OH:4]",
  include_stereochemistry: true,
  template_name: "verification-template"
};

const result = await wasmModule.run_rdkit_bridge(sampleRequest, rdkitTemplateAdapter);

if (result.status !== "rdkit_ready") {
  throw new Error(`Unexpected bridge status: ${result.status}`);
}

if (!result.rdkitVersion) {
  throw new Error("RDKit version was not returned by the adapter.");
}

if (result.reactants.length !== 2 || result.products.length !== 1) {
  throw new Error("RDKit bridge did not preserve the reaction sides.");
}

if (result.analysisType !== "reaction_template_execution") {
  throw new Error(`Unexpected analysis type: ${result.analysisType}`);
}

if (result.products[0].canonicalSmiles !== "CCO") {
  throw new Error(`Unexpected canonical product SMILES: ${result.products[0].canonicalSmiles}`);
}

if (result.reactionCheck.verdict !== "template_exact_match") {
  throw new Error(`Unexpected reaction verdict: ${result.reactionCheck.verdict}`);
}

if (!result.reactionTemplate?.svg?.includes("<svg")) {
  throw new Error("Expected a rendered reaction SVG from RDKit.");
}

if (!result.bestOutcome || result.bestOutcome.products.length !== 1) {
  throw new Error(`Expected a single best generated product set, got: ${JSON.stringify(result.bestOutcome)}`);
}

if (!result.reactionCheck.possible || !result.reactionCheck.comparison?.exact) {
  throw new Error(`Expected an exact template match, got: ${JSON.stringify(result.reactionCheck)}`);
}

const offTargetRequest = {
  reactants: [
    {
      format: "smiles",
      value: "CCBr",
      label: "bromoethane"
    },
    {
      format: "smiles",
      value: "O",
      label: "water"
    }
  ],
  products: [
    {
      format: "smiles",
      value: "C=C",
      label: "ethene"
    }
  ],
  reaction_smarts: "[CH3:1][CH2:2][Br:3].[OH2:4]>>[CH3:1][CH2:2][OH:4]",
  include_stereochemistry: false,
  template_name: "off-target-verification"
};

const offTargetResult = await wasmModule.run_rdkit_bridge(offTargetRequest, rdkitTemplateAdapter);

if (offTargetResult.reactionCheck.verdict !== "template_generated_other_products") {
  throw new Error(`Expected off-target verdict, got: ${offTargetResult.reactionCheck.verdict}`);
}

if (offTargetResult.reactionCheck.comparison?.unexpectedProducts[0] !== "CCO") {
  throw new Error(`Expected generated ethanol to be reported as unexpected, got: ${JSON.stringify(offTargetResult.reactionCheck.comparison)}`);
}

console.log("RDKit bridge verified.");
console.log(JSON.stringify(result, null, 2));