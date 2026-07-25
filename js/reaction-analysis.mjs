const ELEMENT_SYMBOLS = {
  1: "H", 3: "Li", 5: "B", 6: "C", 7: "N", 8: "O", 9: "F",
  11: "Na", 12: "Mg", 14: "Si", 15: "P", 16: "S", 17: "Cl",
  19: "K", 20: "Ca", 26: "Fe", 29: "Cu", 30: "Zn", 35: "Br", 53: "I"
};

function addCount(target, symbol, increment = 1) {
  target[symbol] = (target[symbol] ?? 0) + increment;
}

function sortedSymbols(counts) {
  const symbols = Object.keys(counts).filter((s) => counts[s] > 0);
  const rest = symbols.filter((s) => s !== "C" && s !== "H").sort();
  if (symbols.includes("C")) {
    return ["C", ...(symbols.includes("H") ? ["H"] : []), ...rest];
  }
  return symbols.sort();
}

export function formatFormula(counts) {
  const symbols = sortedSymbols(counts);
  if (symbols.length === 0) return "-";
  return symbols
    .map((s) => `${s}${counts[s] > 1 ? counts[s] : ""}`)
    .join("");
}

function countsFromMolJson(jsonString) {
  const payload = JSON.parse(jsonString);
  const counts = {};
  const defaultAtom = payload.defaults?.atom ?? {};
  for (const molecule of payload.molecules ?? []) {
    for (const atom of molecule.atoms ?? []) {
      const z = atom.z ?? defaultAtom.z ?? 6;
      const impHs = atom.impHs ?? defaultAtom.impHs ?? 0;
      const symbol = ELEMENT_SYMBOLS[z] ?? `Z${z}`;
      addCount(counts, symbol, 1);
      if (impHs > 0) addCount(counts, "H", impHs);
    }
  }
  return counts;
}

function aggregateCounts(records) {
  const totals = {};
  for (const record of records) {
    for (const [symbol, count] of Object.entries(record.atomCounts)) {
      addCount(totals, symbol, count);
    }
  }
  return totals;
}

function diffHeavyCounts(left, right) {
  const diff = {};
  const symbols = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const symbol of symbols) {
    if (symbol === "H") continue;
    const value = (left[symbol] ?? 0) - (right[symbol] ?? 0);
    if (value !== 0) diff[symbol] = value;
  }
  return diff;
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const result = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      result.push([items[i], ...tail]);
    }
  }
  return result;
}

function multisetSignature(values) {
  return [...values].sort().join("\u0000");
}

function splitTopLevelDot(smartsChunk) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < smartsChunk.length; i += 1) {
    const c = smartsChunk[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "." && depth === 0) {
      parts.push(smartsChunk.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(smartsChunk.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function splitReactionSmarts(smarts) {
  const chunks = smarts.split(">");
  if (chunks.length < 2) return { reactants: [], products: [] };
  const reactants = splitTopLevelDot(chunks[0] ?? "");
  const products = splitTopLevelDot(chunks[chunks.length - 1] ?? "");
  return { reactants, products };
}

const HIGHLIGHT_COLOR = [1.0, 0.55, 0.24];

function parseMatchJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.atoms) || !parsed.atoms.length) return null;
    return {
      atoms: parsed.atoms,
      bonds: Array.isArray(parsed.bonds) ? parsed.bonds : []
    };
  } catch {
    return null;
  }
}

function renderHighlightedSvg(mol, match) {
  const atomColors = Object.fromEntries(match.atoms.map((idx) => [idx, HIGHLIGHT_COLOR]));
  const bondColors = Object.fromEntries(match.bonds.map((idx) => [idx, HIGHLIGHT_COLOR]));
  const details = {
    atoms: match.atoms,
    bonds: match.bonds,
    highlightAtomColors: atomColors,
    highlightBondColors: bondColors,
    width: 320,
    height: 220,
    bondLineWidth: 2.5
  };
  return mol.get_svg_with_highlights(JSON.stringify(details));
}

function highlightMolecule(RDKitModule, sourceSmiles, qmol) {
  const mol = RDKitModule.get_mol(sourceSmiles);
  if (!mol) return null;
  try {
    const match = parseMatchJson(mol.get_substruct_match(qmol));
    if (!match) return null;
    return { svg: renderHighlightedSvg(mol, match), match };
  } finally {
    mol.delete?.();
  }
}

// Walks a SMARTS fragment and returns the atom-map number (or null) for each
// atom in the order the atoms appear textually. RDKit assigns query-atom
// indices in that same order, which lets us bridge a substructure match's
// atom list back to the SMARTS atom-map namespace.
function collectSmartsAtomMaps(smarts) {
  const maps = [];
  let i = 0;
  const n = smarts.length;
  while (i < n) {
    const c = smarts[i];
    if (c === "[") {
      let end = i + 1;
      while (end < n && smarts[end] !== "]") end += 1;
      const inside = smarts.slice(i + 1, end);
      const m = inside.match(/:(\d+)(?!\d)/);
      maps.push(m ? Number(m[1]) : null);
      i = end + 1;
    } else if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "*") {
      const two = smarts.substr(i, 2);
      if (two === "Cl" || two === "Br") i += 2;
      else i += 1;
      maps.push(null);
    } else {
      i += 1;
    }
  }
  return maps;
}

function buildAtomMapToIdx(smartsFragment, matchAtomIndices) {
  const queryMaps = collectSmartsAtomMaps(smartsFragment);
  const result = {};
  const upto = Math.min(queryMaps.length, matchAtomIndices.length);
  for (let queryIdx = 0; queryIdx < upto; queryIdx += 1) {
    const mapNo = queryMaps[queryIdx];
    if (mapNo == null) continue;
    // First writer wins if the SMARTS has duplicate map numbers (unusual).
    if (!(mapNo in result)) result[mapNo] = matchAtomIndices[queryIdx];
  }
  return result;
}

// Greedy pairing: for each molecule, claim the first unclaimed SMARTS fragment
// that substructure-matches it. Works symmetrically for reactant/LHS and
// product/RHS sides.
function assignSideHighlights(RDKitModule, molecules, smartsFragments) {
  const qmols = smartsFragments.map((smarts) => {
    try {
      const qmol = RDKitModule.get_qmol(smarts);
      return qmol ? { smarts, qmol } : null;
    } catch {
      return null;
    }
  });
  const results = molecules.map(() => null);
  const claimed = new Set();
  try {
    for (let i = 0; i < molecules.length; i += 1) {
      const sourceSmiles = molecules[i]?.sourceSmiles;
      if (!sourceSmiles) continue;
      for (let j = 0; j < qmols.length; j += 1) {
        if (!qmols[j] || claimed.has(j)) continue;
        const highlight = highlightMolecule(RDKitModule, sourceSmiles, qmols[j].qmol);
        if (highlight) {
          results[i] = {
            smartsFragment: qmols[j].smarts,
            highlightedSvg: highlight.svg,
            matchedAtoms: highlight.match.atoms,
            matchedBonds: highlight.match.bonds,
            atomMapToIdx: buildAtomMapToIdx(qmols[j].smarts, highlight.match.atoms)
          };
          claimed.add(j);
          break;
        }
      }
    }
  } finally {
    for (const entry of qmols) entry?.qmol?.delete?.();
  }
  return results;
}

function applyHighlights(molecules, highlights) {
  molecules.forEach((record, index) => {
    const highlight = highlights[index];
    if (!highlight) return;
    record.highlightedSvg = highlight.highlightedSvg;
    record.matchedAtoms = highlight.matchedAtoms;
    record.matchedBonds = highlight.matchedBonds;
    record.smartsFragment = highlight.smartsFragment;
    record.atomMapToIdx = highlight.atomMapToIdx;
  });
}

function buildProductLabel(records) {
  return records.length
    ? records.map((r) => r.canonicalSmiles).sort().join(" + ")
    : "No products";
}

function moleculeRecord(RDKitModule, jsMol, base) {
  const atomCounts = countsFromMolJson(jsMol.get_json());
  return {
    ...base,
    canonicalSmiles: jsMol.get_smiles(),
    svg: jsMol.get_svg(300, 220),
    atomCounts,
    formula: formatFormula(atomCounts)
  };
}

function withMol(RDKitModule, smiles, fn) {
  const mol = RDKitModule.get_mol(smiles);
  if (mol == null) return null;
  try {
    return fn(mol);
  } finally {
    mol.delete?.();
  }
}

function summarizeInputMolecule(RDKitModule, molecule, role, index) {
  const label = molecule.label ?? `${role} ${index + 1}`;
  // Canonicalise first, then re-parse. RDKit's 2D layout follows the atom
  // traversal order of the parsed SMILES, so two chemically identical inputs
  // written differently would otherwise render as visually different sketches.
  // Rebuilding from the canonical string gives a stable, input-independent
  // depiction and makes sourceSmiles line up with canonicalSmiles for every
  // downstream consumer (highlighting, hover, gallery cards).
  const canonical = withMol(RDKitModule, molecule.value, (mol) => mol.get_smiles?.());
  if (!canonical) {
    throw new Error(`RDKit rejected ${role}[${index}] "${molecule.value}" as invalid SMILES.`);
  }
  const record = withMol(RDKitModule, canonical, (mol) =>
    moleculeRecord(RDKitModule, mol, { index, role, label, sourceSmiles: canonical })
  );
  if (!record) {
    throw new Error(`RDKit rejected the canonical form of ${role}[${index}]: "${canonical}".`);
  }
  return record;
}

function sanitizeGeneratedProduct(RDKitModule, jsMol, outcomeIndex, productIndex) {
  // Re-parse the raw product SMILES so canonicalisation matches how RDKit
  // canonicalises the user-supplied targets. This makes the multiset comparison
  // apples-to-apples even when run_reactants leaves the fragment in a state
  // that would otherwise serialise differently.
  const rawSmiles = jsMol.get_smiles?.();
  if (!rawSmiles) return null;
  return withMol(RDKitModule, rawSmiles, (clean) =>
    moleculeRecord(RDKitModule, clean, {
      index: productIndex,
      role: "generated_product",
      label: `outcome ${outcomeIndex + 1}.${productIndex + 1}`,
      sourceSmiles: rawSmiles
    })
  );
}

function compareProducts(target, candidate) {
  const targetSmiles = target.map((r) => r.canonicalSmiles);
  const candidateSmiles = candidate.map((r) => r.canonicalSmiles);
  const targetCounts = {};
  const candidateCounts = {};
  for (const s of targetSmiles) targetCounts[s] = (targetCounts[s] ?? 0) + 1;
  for (const s of candidateSmiles) candidateCounts[s] = (candidateCounts[s] ?? 0) + 1;

  const matched = [];
  const missing = [];
  const unexpected = [];
  const keys = new Set([...Object.keys(targetCounts), ...Object.keys(candidateCounts)]);
  for (const key of keys) {
    const shared = Math.min(targetCounts[key] ?? 0, candidateCounts[key] ?? 0);
    for (let i = 0; i < shared; i += 1) matched.push(key);
    for (let i = 0; i < (targetCounts[key] ?? 0) - shared; i += 1) missing.push(key);
    for (let i = 0; i < (candidateCounts[key] ?? 0) - shared; i += 1) unexpected.push(key);
  }

  const exact = missing.length === 0 && unexpected.length === 0;
  const denominator = Math.max(targetSmiles.length, candidateSmiles.length, 1);
  return {
    verdict: exact ? "exact_match" : matched.length > 0 ? "partial_match" : "no_match",
    exact,
    score: matched.length / denominator,
    matchedProducts: matched.sort(),
    missingProducts: missing.sort(),
    unexpectedProducts: unexpected.sort()
  };
}

function collectOutcomes(RDKitModule, reaction, reactantRecords) {
  const seen = new Set();
  const outcomes = [];
  // RDKit's run_reactants matches reactant molecules positionally against the
  // reactant templates in the SMARTS. If the user provides them in the "wrong"
  // order the run yields nothing, so we try every permutation and dedupe by
  // the multiset of canonical product SMILES.
  for (const permutation of permutations(reactantRecords)) {
    const molList = new RDKitModule.MolList();
    const allocated = [];
    for (const reactant of permutation) {
      const mol = RDKitModule.get_mol(reactant.sourceSmiles);
      if (!mol) {
        for (const other of allocated) other.delete?.();
        molList.delete?.();
        throw new Error(`RDKit could not prepare reactant "${reactant.sourceSmiles}".`);
      }
      allocated.push(mol);
      molList.append(mol);
    }

    let outcomeSets = null;
    try {
      try {
        outcomeSets = reaction.run_reactants(molList);
      } catch {
        // RDKit throws if the reactant count doesn't match the SMARTS arity or
        // if a permutation cannot bind. Treat that permutation as "no outcome"
        // and keep trying the rest.
        outcomeSets = null;
      }
      if (!outcomeSets) continue;
      const total = outcomeSets.size();
      for (let i = 0; i < total; i += 1) {
        const productSet = outcomeSets.get(i);
        const products = [];
        try {
          for (let j = 0; j < productSet.size(); j += 1) {
            const raw = productSet.at(j);
            try {
              const record = sanitizeGeneratedProduct(RDKitModule, raw, outcomes.length, j);
              if (record) products.push(record);
            } finally {
              raw.delete?.();
            }
          }
        } finally {
          productSet.delete?.();
        }
        if (!products.length) continue;
        const signature = multisetSignature(products.map((r) => r.canonicalSmiles));
        if (seen.has(signature)) continue;
        seen.add(signature);
        outcomes.push({
          index: outcomes.length,
          products,
          signature,
          label: buildProductLabel(products),
          formula: formatFormula(aggregateCounts(products))
        });
      }
    } finally {
      outcomeSets?.delete?.();
      for (const mol of allocated) mol.delete?.();
      molList.delete?.();
    }
  }
  return outcomes;
}

function scoreOutcome(outcome) {
  return [
    outcome.comparison.exact ? 1 : 0,
    outcome.comparison.score,
    -outcome.comparison.missingProducts.length,
    -outcome.comparison.unexpectedProducts.length,
    -outcome.index
  ];
}

function pickBestOutcome(outcomes) {
  if (!outcomes.length) return null;
  return outcomes.reduce((best, current) => {
    const a = scoreOutcome(current);
    const b = scoreOutcome(best);
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? current : best;
    }
    return best;
  });
}

function verdictSummary(verdict, outcomes, bestOutcome, targetLabel) {
  const count = outcomes.length;
  const suffix = count === 1 ? "" : "s";
  if (verdict === "exact_match") {
    return `Template reproduced the target (${targetLabel}) in ${count} outcome set${suffix}.`;
  }
  if (verdict === "partial_match") {
    const missing = bestOutcome.comparison.missingProducts.join(", ") || "-";
    const extra = bestOutcome.comparison.unexpectedProducts.join(", ") || "-";
    return `Best of ${count} outcome${suffix} overlaps the target; missing ${missing}; extra ${extra}.`;
  }
  if (verdict === "no_match") {
    return `Template produced ${count} outcome set${suffix} but none match the target (${targetLabel}).`;
  }
  return "Template did not produce any products from the supplied reactants (check reactant/SMARTS alignment).";
}

function balanceWarnings(reactants, targets) {
  const warnings = [];
  const reactantHeavy = aggregateCounts(reactants);
  const targetHeavy = aggregateCounts(targets);
  const diff = diffHeavyCounts(reactantHeavy, targetHeavy);
  const extraOnReactants = [];
  const extraOnProducts = [];
  for (const [symbol, delta] of Object.entries(diff)) {
    if (delta > 0) extraOnReactants.push({ symbol, count: delta });
    else if (delta < 0) extraOnProducts.push({ symbol, count: -delta });
  }
  if (!extraOnReactants.length && !extraOnProducts.length) return warnings;
  const format = (entries) =>
    entries
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map(({ symbol, count }) => `${count}\u00d7${symbol}`)
      .join(", ");
  const parts = [];
  if (extraOnReactants.length) {
    parts.push(`${format(extraOnReactants)} on the reactant side with no matching product atom (missing byproducts?)`);
  }
  if (extraOnProducts.length) {
    parts.push(`${format(extraOnProducts)} on the product side with no matching reactant atom (missing co-reagents?)`);
  }
  warnings.push(`Heavy-atom imbalance - ${parts.join("; ")}.`);
  return warnings;
}

export function analyzeReactionRequest(RDKitModule, request) {
  const reactants = request.reactants.map((molecule, index) =>
    summarizeInputMolecule(RDKitModule, molecule, "reactant", index)
  );
  const targets = request.products.map((molecule, index) =>
    summarizeInputMolecule(RDKitModule, molecule, "product", index)
  );

  const reactionSmarts = request.reaction_smarts.trim();
  const reaction = RDKitModule.get_rxn(reactionSmarts);
  if (reaction == null) {
    throw new Error("RDKit could not parse the reaction SMARTS. Use a valid, ideally atom-mapped, reaction SMARTS.");
  }

  let reactionSvg = null;
  let outcomes = [];
  try {
    reactionSvg = reaction.get_svg?.() ?? null;
    outcomes = collectOutcomes(RDKitModule, reaction, reactants);
  } finally {
    reaction.delete?.();
  }

  const { reactants: reactantSmartsFragments, products: productSmartsFragments } =
    splitReactionSmarts(reactionSmarts);
  applyHighlights(
    reactants,
    assignSideHighlights(RDKitModule, reactants, reactantSmartsFragments)
  );
  applyHighlights(
    targets,
    assignSideHighlights(RDKitModule, targets, productSmartsFragments)
  );
  for (const outcome of outcomes) {
    applyHighlights(
      outcome.products,
      assignSideHighlights(RDKitModule, outcome.products, productSmartsFragments)
    );
  }

  const targetLabel = buildProductLabel(targets);
  const enrichedOutcomes = outcomes.map((outcome) => ({
    ...outcome,
    comparison: compareProducts(targets, outcome.products)
  }));
  const bestOutcome = pickBestOutcome(enrichedOutcomes);

  let verdict = "no_outcomes";
  if (bestOutcome) {
    verdict = bestOutcome.comparison.verdict;
  }

  return {
    status: "rdkit_ready",
    rdkitVersion: RDKitModule.version(),
    templateName: request.template_name ?? null,
    reactionSmarts,
    reactionSvg,
    reactants,
    targets,
    outcomes: enrichedOutcomes,
    bestOutcomeIndex: bestOutcome?.index ?? null,
    verdict,
    summary: verdictSummary(verdict, enrichedOutcomes, bestOutcome, targetLabel),
    warnings: balanceWarnings(reactants, targets),
    reactantFormula: formatFormula(aggregateCounts(reactants)),
    targetFormula: formatFormula(aggregateCounts(targets)),
    generatedFormula: bestOutcome?.formula ?? null,
    targetLabel,
    bestLabel: bestOutcome?.label ?? null
  };
}

function safeSummarizeInputMolecule(RDKitModule, molecule, role, index) {
  const label = molecule?.label ?? `${role} ${index + 1}`;
  const value = molecule?.value ?? "";
  if (!value.trim()) {
    return {
      index, role, label, sourceSmiles: value,
      canonicalSmiles: null, svg: null, atomCounts: {}, formula: "?",
      error: "empty SMILES"
    };
  }
  try {
    return summarizeInputMolecule(RDKitModule, molecule, role, index);
  } catch (error) {
    return {
      index, role, label, sourceSmiles: value,
      canonicalSmiles: null, svg: null, atomCounts: {}, formula: "?",
      error: String(error?.message ?? error)
    };
  }
}

export function previewReactionRequest(RDKitModule, request) {
  const reactants = (request?.reactants ?? []).map((molecule, index) =>
    safeSummarizeInputMolecule(RDKitModule, molecule, "reactant", index)
  );
  const targets = (request?.products ?? []).map((molecule, index) =>
    safeSummarizeInputMolecule(RDKitModule, molecule, "product", index)
  );
  const reactionSmarts = (request?.reaction_smarts ?? "").trim();

  let smartsError = null;
  const validReactants = reactants.filter((r) => !r.error);
  const validTargets = targets.filter((t) => !t.error);
  if (reactionSmarts) {
    const { reactants: reactantFragments, products: productFragments } =
      splitReactionSmarts(reactionSmarts);
    try {
      if (reactantFragments.length) {
        applyHighlights(
          validReactants,
          assignSideHighlights(RDKitModule, validReactants, reactantFragments)
        );
      }
      if (productFragments.length) {
        applyHighlights(
          validTargets,
          assignSideHighlights(RDKitModule, validTargets, productFragments)
        );
      }
    } catch (error) {
      smartsError = String(error?.message ?? error);
    }
  }

  const cleanReactants = reactants.filter((r) => !r.error);
  const cleanTargets = targets.filter((t) => !t.error);
  return {
    reactants,
    targets,
    reactionSmarts,
    reactantFormula: cleanReactants.length ? formatFormula(aggregateCounts(cleanReactants)) : "-",
    targetFormula: cleanTargets.length ? formatFormula(aggregateCounts(cleanTargets)) : "-",
    warnings: cleanReactants.length && cleanTargets.length ? balanceWarnings(cleanReactants, cleanTargets) : [],
    smartsError
  };
}
