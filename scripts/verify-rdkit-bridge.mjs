import { analyzeReactionRequest } from "../js/reaction-analysis.mjs";
import { validateTemplateRequest } from "../js/validation.mjs";
import { rdkitTemplateAdapter } from "../js/rdkit-bridge.mjs";
import initRDKitModule from "@rdkit/rdkit";

const RDKitModule = await initRDKitModule();

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

async function analyze(request) {
  // Exercise both the shared adapter (as the browser would use it via
  // rdkitTemplateAdapterBrowser) and the direct analyze path.
  const viaAdapter = await rdkitTemplateAdapter(request);
  const direct = analyzeReactionRequest(RDKitModule, request);
  assert(viaAdapter.verdict === direct.verdict, "adapter and direct analyze disagree on verdict");
  return direct;
}

// 1. Exact match, canonical ordering.
{
  const result = await analyze(baseRequest());
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
  const result = await analyze(baseRequest({
    products: [
      { value: "CCO", label: "ethanol" },
      { value: "Br", label: "hydrogen bromide" }
    ]
  }));
  assert(result.warnings.length === 0, `expected no warnings, got: ${JSON.stringify(result.warnings)}`);
}

// 2. Reactants supplied in the "wrong" order still find the match via
//    permutation-aware execution.
{
  const result = await analyze(baseRequest({
    reactants: [
      { value: "O", label: "water" },
      { value: "CCBr", label: "bromoethane" }
    ]
  }));
  assert(result.verdict === "exact_match", `permutation execution failed, verdict: ${result.verdict}`);
}

// 3. Off-target: SMARTS runs cleanly but produces something other than the
//    requested product.
{
  const result = await analyze(baseRequest({
    products: [{ value: "C=C", label: "ethene" }],
    template_name: "off-target"
  }));
  assert(result.verdict === "no_match", `expected no_match, got: ${result.verdict}`);
  const best = result.outcomes[result.bestOutcomeIndex];
  assert(best.comparison.unexpectedProducts[0] === "CCO", `expected ethanol as unexpected, got: ${JSON.stringify(best.comparison)}`);
}

// 4. Heavy-atom balance warning: request only ethanol from bromoethane
//    (no water reactant supplied), so O is short on the reactant side.
{
  const result = await analyze(baseRequest({
    reactants: [{ value: "CCBr", label: "bromoethane" }]
  }));
  assert(
    result.warnings.some((message) => message.includes("Heavy-atom imbalance")),
    `expected heavy-atom warning, got: ${JSON.stringify(result.warnings)}`
  );
}

// 5. JS-side validation surfaces atom-mapping warnings without blocking.
{
  const validation = validateTemplateRequest(baseRequest({ reaction_smarts: "CCBr.O>>CCO" }));
  assert(validation.ok, "unmapped SMARTS should still be ok=true");
  assert(
    validation.messages.some((m) => m.level === "warning" && m.message.includes("no atom maps")),
    `expected atom-map warning, got: ${JSON.stringify(validation.messages)}`
  );
}

// 6. JS-side validation blocks structurally invalid SMARTS.
{
  const validation = validateTemplateRequest(baseRequest({ reaction_smarts: "CCBr.O>CCO" }));
  assert(!validation.ok, "malformed SMARTS should not validate");
}

console.log("RDKit bridge verified.");
