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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseRequest(overrides = {}) {
  return {
    reactants: [
      { value: "CCBr", label: "bromoethane" },
      { value: "O", label: "water" }
    ],
    products: [{ value: "CCO", label: "ethanol" }],
    reaction_smarts: "[CH3:1][CH2:2][Br:3].[OH2:4]>>[CH3:1][CH2:2][OH:4]",
    template_name: "verification-template",
    ...overrides
  };
}

// 1. Exact match, canonical ordering.
{
  const result = await wasmModule.run_rdkit_bridge(baseRequest(), rdkitTemplateAdapter);
  assert(result.status === "rdkit_ready", `unexpected status: ${result.status}`);
  assert(result.rdkitVersion, "missing RDKit version");
  assert(result.reactants.length === 2 && result.targets.length === 1, "reaction sides not preserved");
  assert(result.targets[0].canonicalSmiles === "CCO", `unexpected canonical target: ${result.targets[0].canonicalSmiles}`);
  assert(result.verdict === "exact_match", `unexpected verdict: ${result.verdict}`);
  assert(result.reactionSvg?.includes("<svg"), "expected reaction SVG");
  assert(result.bestOutcomeIndex !== null, "expected a best outcome");
  const best = result.outcomes[result.bestOutcomeIndex];
  assert(best.products.length === 1 && best.products[0].canonicalSmiles === "CCO", `best outcome mismatch: ${JSON.stringify(best)}`);
  // The user-supplied target omits the HBr byproduct implied by the SMARTS,
  // so we expect a heavy-atom imbalance warning on Br.
  assert(
    result.warnings.some((message) => message.includes("Br")),
    `expected Br byproduct warning, got: ${JSON.stringify(result.warnings)}`
  );
}

// 1b. When the target set includes every heavy atom on the reactant side the
//     balance check should stay quiet.
{
  const request = baseRequest({
    products: [
      { value: "CCO", label: "ethanol" },
      { value: "Br", label: "hydrogen bromide" }
    ]
  });
  const result = await wasmModule.run_rdkit_bridge(request, rdkitTemplateAdapter);
  assert(result.warnings.length === 0, `expected no warnings, got: ${JSON.stringify(result.warnings)}`);
}

// 2. Reactants supplied in the "wrong" order still find the match via
//    permutation-aware execution.
{
  const request = baseRequest({
    reactants: [
      { value: "O", label: "water" },
      { value: "CCBr", label: "bromoethane" }
    ]
  });
  const result = await wasmModule.run_rdkit_bridge(request, rdkitTemplateAdapter);
  assert(result.verdict === "exact_match", `permutation execution failed, verdict: ${result.verdict}`);
}

// 3. Off-target: SMARTS runs cleanly but produces something other than the
//    requested product.
{
  const request = baseRequest({
    products: [{ value: "C=C", label: "ethene" }],
    template_name: "off-target"
  });
  const result = await wasmModule.run_rdkit_bridge(request, rdkitTemplateAdapter);
  assert(result.verdict === "no_match", `expected no_match, got: ${result.verdict}`);
  const best = result.outcomes[result.bestOutcomeIndex];
  assert(best.comparison.unexpectedProducts[0] === "CCO", `expected ethanol as unexpected, got: ${JSON.stringify(best.comparison)}`);
}

// 4. Heavy-atom balance warning: request only ethanol from bromoethane
//    (no water reactant supplied), so O is short on the reactant side.
{
  const request = baseRequest({
    reactants: [{ value: "CCBr", label: "bromoethane" }]
  });
  const result = await wasmModule.run_rdkit_bridge(request, rdkitTemplateAdapter);
  assert(
    result.warnings.some((message) => message.includes("Heavy-atom imbalance")),
    `expected heavy-atom warning, got: ${JSON.stringify(result.warnings)}`
  );
}

// 5. Rust-side validation surfaces atom-mapping warnings without blocking.
{
  const validation = wasmModule.validate_template_request(
    baseRequest({ reaction_smarts: "CCBr.O>>CCO" })
  );
  assert(validation.ok, "unmapped SMARTS should still be ok=true");
  assert(
    validation.messages.some((m) => m.level === "warning" && m.message.includes("no atom maps")),
    `expected atom-map warning, got: ${JSON.stringify(validation.messages)}`
  );
}

// 6. Rust-side validation blocks structurally invalid SMARTS before hitting RDKit.
{
  const validation = wasmModule.validate_template_request(
    baseRequest({ reaction_smarts: "CCBr.O>CCO" })
  );
  assert(!validation.ok, "malformed SMARTS should not validate");
}

console.log("RDKit bridge verified.");
