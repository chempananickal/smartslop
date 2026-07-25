import init, {
  run_rdkit_bridge,
  validate_template_request
} from "../pkg-web/smartslop_wasm.js";
import {
  loadBrowserRdkit,
  rdkitTemplateAdapterBrowser
} from "./rdkit-browser.mjs";

const el = (id) => document.getElementById(id);

const form = el("template-form");
const reactantInput = el("reactant-input");
const productInput = el("product-input");
const reactionSmartsInput = el("reaction-smarts-input");
const bridgeStatus = el("bridge-status");
const rdkitStatus = el("rdkit-status");
const reactionSummary = el("reaction-summary");
const reactionVerdict = el("reaction-verdict");
const reactionDiagram = el("reaction-diagram");
const reactionWarnings = el("reaction-warnings");
const outcomeCount = el("outcome-count");
const matchScore = el("match-score");
const reactantFormula = el("reactant-formula");
const targetFormula = el("target-formula");
const generatedFormula = el("generated-formula");
const bestSignature = el("best-signature");
const targetGallery = el("target-gallery");
const generatedGallery = el("generated-gallery");
const outcomeTableBody = el("outcome-table-body");
const validationOutput = el("validation-output");

function splitSmilesField(rawValue) {
  return rawValue
    .split(/\r?\n/)
    .flatMap((line) => line.split("."))
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildRequest() {
  return {
    reactants: splitSmilesField(reactantInput.value).map((value, index) => ({
      value,
      label: `reactant ${index + 1}`
    })),
    products: splitSmilesField(productInput.value).map((value, index) => ({
      value,
      label: `target ${index + 1}`
    })),
    reaction_smarts: reactionSmartsInput.value,
    template_name: "browser"
  };
}

function formatVerdict(verdict) {
  return verdict.replace(/_/g, " ");
}

function message(text, level = "info") {
  const node = document.createElement("p");
  node.className = `message message--${level}`;
  node.textContent = text;
  return node;
}

function renderValidation(report) {
  validationOutput.replaceChildren();

  if (!report.messages.length) {
    validationOutput.append(message("Request is valid.", "success"));
    return;
  }

  for (const entry of report.messages) {
    validationOutput.append(message(`${entry.field}: ${entry.message}`, entry.level));
  }
}

function renderWarnings(warnings) {
  reactionWarnings.replaceChildren();
  for (const warning of warnings ?? []) {
    reactionWarnings.append(message(warning, "warning"));
  }
}

function moleculeCard(record) {
  const card = document.createElement("article");
  card.className = "molecule-card";

  const header = document.createElement("header");
  header.innerHTML = `<strong>${record.label}</strong><span>${record.formula ?? "?"}</span>`;

  const body = document.createElement("div");
  body.className = "body";
  if (record.svg) {
    body.innerHTML = record.svg;
  } else {
    body.textContent = record.formula ?? "unavailable";
  }

  const footer = document.createElement("footer");
  footer.textContent = record.canonicalSmiles ?? "no SMILES";

  card.append(header, body, footer);
  return card;
}

function renderGallery(target, records, emptyLabel) {
  target.replaceChildren();
  if (!records?.length) {
    const empty = document.createElement("p");
    empty.className = "empty-gallery";
    empty.textContent = emptyLabel;
    target.append(empty);
    return;
  }
  for (const record of records) target.append(moleculeCard(record));
}

function renderDiagram(svg) {
  reactionDiagram.replaceChildren();
  if (svg) {
    reactionDiagram.innerHTML = svg;
  } else {
    reactionDiagram.append(message("RDKit did not return a reaction SVG.", "warning"));
  }
}

function renderOutcomeTable(outcomes, bestIndex) {
  outcomeTableBody.replaceChildren();
  if (!outcomes.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4" class="empty-row">No outcome sets generated.</td>`;
    outcomeTableBody.append(row);
    return;
  }
  for (const outcome of outcomes) {
    const row = document.createElement("tr");
    if (outcome.index === bestIndex) row.className = "is-best";
    row.innerHTML = `
      <td>${outcome.index + 1}</td>
      <td>${formatVerdict(outcome.comparison.verdict)}</td>
      <td>${outcome.label}</td>
      <td>${Math.round(outcome.comparison.score * 100)}%</td>
    `;
    outcomeTableBody.append(row);
  }
}

function renderResult(result) {
  reactionSummary.textContent = result.summary;
  reactionVerdict.textContent = formatVerdict(result.verdict);
  reactionVerdict.dataset.state = result.verdict;

  renderWarnings(result.warnings);

  outcomeCount.textContent = String(result.outcomes.length);
  const best = result.bestOutcomeIndex !== null ? result.outcomes[result.bestOutcomeIndex] : null;
  matchScore.textContent = best ? `${Math.round(best.comparison.score * 100)}%` : "0%";
  reactantFormula.textContent = result.reactantFormula;
  targetFormula.textContent = result.targetFormula;
  generatedFormula.textContent = result.generatedFormula ?? "-";
  bestSignature.textContent = result.bestLabel ?? "-";

  renderDiagram(result.reactionSvg);
  renderGallery(targetGallery, result.targets, "No target products provided.");
  renderGallery(generatedGallery, best?.products ?? [], "No generated products for the best outcome.");
  renderOutcomeTable(result.outcomes, result.bestOutcomeIndex);
}

function resetResultView() {
  outcomeCount.textContent = "-";
  matchScore.textContent = "-";
  reactantFormula.textContent = "-";
  targetFormula.textContent = "-";
  generatedFormula.textContent = "-";
  bestSignature.textContent = "-";
  reactionDiagram.replaceChildren();
  reactionWarnings.replaceChildren();
  renderGallery(targetGallery, [], "No target products provided.");
  renderGallery(generatedGallery, [], "No generated products for the best outcome.");
  renderOutcomeTable([], null);
}

async function warmBoot() {
  bridgeStatus.textContent = "initializing wasm";
  await init();
  bridgeStatus.textContent = "wasm ready";
  rdkitStatus.textContent = "warming RDKit";
  const RDKitModule = await loadBrowserRdkit();
  rdkitStatus.textContent = `ready (${RDKitModule.version()})`;
}

async function submitRequest(event) {
  event?.preventDefault();

  const request = buildRequest();
  const validation = validate_template_request(request);
  renderValidation(validation);

  if (!validation.ok) {
    bridgeStatus.textContent = "validation failed";
    reactionVerdict.textContent = "invalid input";
    reactionVerdict.dataset.state = "error";
    reactionSummary.textContent = "Fix the validation errors before running the template.";
    resetResultView();
    return;
  }

  try {
    bridgeStatus.textContent = "running template";
    const result = await run_rdkit_bridge(request, rdkitTemplateAdapterBrowser);
    renderResult(result);
    bridgeStatus.textContent = "template complete";
  } catch (error) {
    reactionSummary.textContent = String(error);
    reactionVerdict.textContent = "execution failed";
    reactionVerdict.dataset.state = "error";
    bridgeStatus.textContent = "execution failed";
    resetResultView();
  }
}

form.addEventListener("submit", submitRequest);

warmBoot()
  .then(() => submitRequest())
  .catch((error) => {
    bridgeStatus.textContent = "boot failed";
    rdkitStatus.textContent = "unavailable";
    reactionSummary.textContent = String(error);
    reactionVerdict.textContent = "boot failed";
    reactionVerdict.dataset.state = "error";
    resetResultView();
  });
