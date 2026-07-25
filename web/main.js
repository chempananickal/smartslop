import init, {
  run_rdkit_bridge,
  validate_template_request
} from "../pkg-web/smartslop_wasm.js";
import {
  loadBrowserRdkit,
  rdkitTemplateAdapterBrowser,
  previewReactionInBrowser
} from "./rdkit-browser.mjs";

const el = (id) => document.getElementById(id);

const HOVER_ATTR = "data-smarts-map";
const HOVER_CLASS = "is-map-hover";

function currentHoverTargets(mapNo) {
  return document.querySelectorAll(`[${HOVER_ATTR}="${mapNo}"]`);
}

function setMapHover(mapNo, on) {
  currentHoverTargets(mapNo).forEach((node) => node.classList.toggle(HOVER_CLASS, on));
}

function clearAllMapHover() {
  document.querySelectorAll(`.${HOVER_CLASS}`).forEach((n) => n.classList.remove(HOVER_CLASS));
}

function wireAtomHover(container, atomMapToIdx) {
  if (!container || !atomMapToIdx) return;
  const idxToMap = new Map();
  for (const [mapNo, idx] of Object.entries(atomMapToIdx)) idxToMap.set(Number(idx), Number(mapNo));
  if (!idxToMap.size) return;
  container.querySelectorAll('ellipse[class*="atom-"]').forEach((node) => {
    const cls = node.getAttribute("class") || "";
    const match = /(?:^|\s)atom-(\d+)(?:\s|$)/.exec(cls);
    if (!match) return;
    const idx = Number(match[1]);
    if (!idxToMap.has(idx)) return;
    const mapNo = idxToMap.get(idx);
    node.setAttribute(HOVER_ATTR, String(mapNo));
    node.setAttribute("pointer-events", "all");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "title");
    label.textContent = `atom map :${mapNo}`;
    node.append(label);
    node.addEventListener("mouseenter", () => setMapHover(mapNo, true));
    node.addEventListener("mouseleave", () => setMapHover(mapNo, false));
  });
}

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

function parseMoleculeLines(rawValue) {
  return rawValue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)(?:\s+(.+))?$/);
      if (!match) return { value: line, label: null };
      return { value: match[1], label: match[2] ? match[2].trim() : null };
    });
}

function buildRequest() {
  return {
    reactants: parseMoleculeLines(reactantInput.value).map((entry, index) => ({
      value: entry.value,
      label: entry.label ?? `reactant ${index + 1}`
    })),
    products: parseMoleculeLines(productInput.value).map((entry, index) => ({
      value: entry.value,
      label: entry.label ?? `expected product ${index + 1}`
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
  const svg = record.highlightedSvg ?? record.svg;
  if (svg) {
    body.innerHTML = svg;
    wireAtomHover(body, record.atomMapToIdx);
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

function renderDiagram(result) {
  clearAllMapHover();
  reactionDiagram.replaceChildren();
  const reactants = result.reactants ?? [];
  const targets = result.targets ?? [];
  const reactantHighlight = reactants.some((r) => r.highlightedSvg);
  const productHighlight = targets.some((t) => t.highlightedSvg);
  const anyHighlight = reactantHighlight || productHighlight;

  if (!reactants.length && !targets.length) {
    if (result.reactionSvg) {
      reactionDiagram.innerHTML = result.reactionSvg;
    } else {
      reactionDiagram.append(message("RDKit did not return a reaction SVG.", "warning"));
    }
    return;
  }

  const montage = document.createElement("div");
  montage.className = "reaction-montage";

  reactants.forEach((record, index) => {
    if (index > 0) montage.append(makeConnector("+"));
    montage.append(makeReactionCell(record, record.highlightedSvg ?? record.svg, "reactant"));
  });

  montage.append(makeConnector("\u2192", result.reactionSmarts));

  targets.forEach((record, index) => {
    if (index > 0) montage.append(makeConnector("+"));
    montage.append(makeReactionCell(record, record.highlightedSvg ?? record.svg, "product"));
  });

  reactionDiagram.append(montage);

  const legend = document.createElement("p");
  legend.className = "reaction-legend";
  legend.textContent = anyHighlight
    ? "Highlighted atoms and bonds match the SMARTS template. Hover a mapped atom to trace it across the reaction."
    : "SMARTS template did not bind to any molecule; showing structures without highlights.";
  reactionDiagram.append(legend);
}

function makeReactionCell(record, svg, role) {
  const cell = document.createElement("figure");
  cell.className = `reaction-cell reaction-cell--${role}`;
  if (record.error) cell.classList.add("reaction-cell--invalid");
  const body = document.createElement("div");
  body.className = "reaction-cell-body";
  if (svg) {
    body.innerHTML = svg;
    wireAtomHover(body, record.atomMapToIdx);
  } else if (record.error) {
    body.textContent = record.sourceSmiles ? record.sourceSmiles : "(empty)";
    body.classList.add("reaction-cell-body--placeholder");
  } else {
    body.textContent = record.canonicalSmiles ?? record.label ?? "?";
  }
  const caption = document.createElement("figcaption");
  caption.textContent = record.error
    ? `${record.label} - invalid SMILES`
    : record.label ?? record.canonicalSmiles ?? "";
  cell.append(body, caption);
  return cell;
}

function makeConnector(symbol, title) {
  const node = document.createElement("span");
  node.className = symbol === "\u2192" ? "reaction-arrow" : "reaction-plus";
  node.textContent = symbol;
  if (title) node.title = title;
  return node;
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

  renderDiagram(result);
  renderGallery(targetGallery, result.targets, "No expected products provided.");
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
  renderGallery(targetGallery, [], "No expected products provided.");
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
  rdkitReady = true;
}

let rdkitReady = false;
let previewTimer = null;
let runIsStale = false;

function schedulePreview() {
  if (!rdkitReady) return;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 180);
}

async function runPreview() {
  if (!rdkitReady) return;
  try {
    const preview = await previewReactionInBrowser(buildRequest());
    renderDiagram(preview);
    reactantFormula.textContent = preview.reactantFormula ?? "-";
    targetFormula.textContent = preview.targetFormula ?? "-";
    renderGallery(targetGallery, preview.targets ?? [], "No expected products provided.");
    markRunStale();
  } catch (_error) {
    // Ignore preview errors while the user is mid-typing.
  }
}

function markRunStale() {
  if (runIsStale) return;
  runIsStale = true;
  reactionVerdict.textContent = "preview";
  reactionVerdict.dataset.state = "stale";
  reactionSummary.textContent = "Live preview - click Evaluate reaction to score outcomes.";
  reactionWarnings.replaceChildren();
  outcomeCount.textContent = "-";
  matchScore.textContent = "-";
  generatedFormula.textContent = "-";
  bestSignature.textContent = "-";
  renderGallery(generatedGallery, [], "Click Evaluate reaction to generate outcomes.");
  renderOutcomeTable([], null);
}

function clearRunStale() {
  runIsStale = false;
}

async function submitRequest(event) {
  event?.preventDefault();

  // A debounced preview scheduled just before the user hit Evaluate would
  // otherwise fire after the async evaluation completes and blow the results
  // away by re-marking the run as stale.
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }

  const request = buildRequest();
  const validation = validate_template_request(request);
  renderValidation(validation);

  if (!validation.ok) {
    bridgeStatus.textContent = "validation failed";
    reactionVerdict.textContent = "invalid input";
    reactionVerdict.dataset.state = "error";
    reactionSummary.textContent = "Fix the validation errors before evaluating the reaction.";
    resetResultView();
    return;
  }

  try {
    bridgeStatus.textContent = "evaluating";
    const result = await run_rdkit_bridge(request, rdkitTemplateAdapterBrowser);
    renderResult(result);
    clearRunStale();
    bridgeStatus.textContent = "evaluation complete";
  } catch (error) {
    reactionSummary.textContent = String(error);
    reactionVerdict.textContent = "evaluation failed";
    reactionVerdict.dataset.state = "error";
    bridgeStatus.textContent = "evaluation failed";
    resetResultView();
  }
}

for (const input of [reactantInput, productInput, reactionSmartsInput]) {
  input.addEventListener("input", schedulePreview);
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
