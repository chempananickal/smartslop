import init, {
  run_rdkit_bridge,
  validate_template_request
} from "../pkg-web/smartslop_wasm.js";
import {
  loadBrowserRdkit,
  rdkitTemplateAdapterBrowser
} from "./rdkit-browser.mjs";

const form = document.querySelector("#template-form");
const reactantInput = document.querySelector("#reactant-input");
const productInput = document.querySelector("#product-input");
const reactionSmartsInput = document.querySelector("#reaction-smarts-input");
const stereoInput = document.querySelector("#stereo-input");
const bridgeStatus = document.querySelector("#bridge-status");
const rdkitStatus = document.querySelector("#rdkit-status");
const reactionSummary = document.querySelector("#reaction-summary");
const reactionVerdict = document.querySelector("#reaction-verdict");
const reactionDiagram = document.querySelector("#reaction-diagram");
const outcomeCount = document.querySelector("#outcome-count");
const matchScore = document.querySelector("#match-score");
const reactantFormula = document.querySelector("#reactant-formula");
const targetFormula = document.querySelector("#target-formula");
const generatedFormula = document.querySelector("#generated-formula");
const bestSignature = document.querySelector("#best-signature");
const targetGallery = document.querySelector("#target-gallery");
const generatedGallery = document.querySelector("#generated-gallery");
const outcomeTableBody = document.querySelector("#outcome-table-body");
const validationOutput = document.querySelector("#validation-output");

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
      format: "smiles",
      value,
      label: `reactant ${index + 1}`
    })),
    products: splitSmilesField(productInput.value).map((value, index) => ({
      format: "smiles",
      value,
      label: `target ${index + 1}`
    })),
    reaction_smarts: reactionSmartsInput.value,
    include_stereochemistry: stereoInput.checked,
    template_name: "browser-demo"
  };
}

function formatVerdict(verdict) {
  return verdict
    .split("_")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function createMessage(text, level = "info") {
  const message = document.createElement("p");
  message.className = `message message--${level}`;
  message.textContent = text;
  return message;
}

function renderValidation(report) {
  validationOutput.replaceChildren();

  if (!report.messages.length) {
    validationOutput.append(
      createMessage("Request is structurally valid and ready for RDKit execution.", "success")
    );
    return;
  }

  for (const entry of report.messages) {
    validationOutput.append(createMessage(`${entry.field}: ${entry.message}`, entry.level));
  }
}

function createMoleculeCard(record) {
  const card = document.createElement("article");
  card.className = "molecule-card";

  const heading = document.createElement("header");
  heading.className = "molecule-card-header";
  heading.innerHTML = `<strong>${record.label}</strong><span>${record.formula ?? "Unknown"}</span>`;

  const body = document.createElement("div");
  body.className = "molecule-card-body";

  if (record.svg) {
    body.innerHTML = record.svg;
  } else {
    body.append(createMessage(record.formula ?? "Unavailable", "warning"));
  }

  const footer = document.createElement("footer");
  footer.className = "molecule-card-footer";
  footer.innerHTML = `
    <span>${record.canonicalSmiles ?? "No resolved SMILES"}</span>
  `;

  card.append(heading, body, footer);
  return card;
}

function renderGallery(target, records, emptyLabel) {
  target.replaceChildren();

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty-gallery";
    empty.textContent = emptyLabel;
    target.append(empty);
    return;
  }

  for (const record of records) {
    target.append(createMoleculeCard(record));
  }
}

function renderReactionDiagram(result) {
  reactionDiagram.replaceChildren();

  if (result.reactionTemplate?.svg) {
    reactionDiagram.innerHTML = result.reactionTemplate.svg;
    return;
  }

  reactionDiagram.append(createMessage("RDKit did not return a reaction SVG for this template.", "warning"));
}

function renderOutcomeTable(result) {
  outcomeTableBody.replaceChildren();

  if (!result.generatedOutcomes.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4" class="empty-row">No outcome sets generated.</td>`;
    outcomeTableBody.append(row);
    return;
  }

  for (const outcome of result.generatedOutcomes) {
    const row = document.createElement("tr");
    if (outcome.index === result.reactionCheck.bestOutcomeIndex) {
      row.className = "is-best";
    }

    row.innerHTML = `
      <td>${outcome.index + 1}</td>
      <td>${formatVerdict(outcome.comparison.verdict)}</td>
      <td>${outcome.signature}</td>
      <td>${Math.round(outcome.comparison.score * 100)}%</td>
    `;
    outcomeTableBody.append(row);
  }
}

function renderResult(result) {
  reactionSummary.textContent = result.reactionCheck.summary;
  reactionVerdict.textContent = formatVerdict(result.reactionCheck.verdict);
  reactionVerdict.dataset.state = result.reactionCheck.verdict;
  outcomeCount.textContent = String(result.reactionCheck.outcomeCount);
  matchScore.textContent = result.reactionCheck.comparison
    ? `${Math.round(result.reactionCheck.comparison.score * 100)}%`
    : "0%";
  reactantFormula.textContent = result.reactionCheck.reactantFormula;
  targetFormula.textContent = result.reactionCheck.targetFormula;
  generatedFormula.textContent = result.reactionCheck.generatedFormula ?? "No products";
  bestSignature.textContent = result.bestOutcome?.signature ?? "No products";

  renderReactionDiagram(result);
  renderGallery(targetGallery, result.products, "No target products provided.");
  renderGallery(generatedGallery, result.bestOutcome?.products ?? [], "No generated products for the best outcome.");
  renderOutcomeTable(result);
}

function resetResultView() {
  outcomeCount.textContent = "-";
  matchScore.textContent = "-";
  reactantFormula.textContent = "-";
  targetFormula.textContent = "-";
  generatedFormula.textContent = "-";
  bestSignature.textContent = "-";
  reactionDiagram.replaceChildren();
  renderGallery(targetGallery, [], "No target products provided.");
  renderGallery(generatedGallery, [], "No generated products for the best outcome.");
  renderOutcomeTable({ generatedOutcomes: [], reactionCheck: { bestOutcomeIndex: null } });
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
    reactionVerdict.textContent = "Invalid Input";
    reactionVerdict.dataset.state = "invalid_reaction_smarts";
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
    reactionVerdict.textContent = "Execution Failed";
    reactionVerdict.dataset.state = "template_execution_failed";
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
    reactionVerdict.textContent = "Boot Failed";
    reactionVerdict.dataset.state = "template_execution_failed";
    resetResultView();
  });