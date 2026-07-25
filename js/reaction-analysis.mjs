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
  const record = withMol(RDKitModule, molecule.value, (mol) =>
    moleculeRecord(RDKitModule, mol, { index, role, label, sourceSmiles: molecule.value })
  );
  if (!record) {
    throw new Error(`RDKit rejected ${role}[${index}] "${molecule.value}" as invalid SMILES.`);
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
  if (Object.keys(diff).length) {
    const parts = Object.entries(diff)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, delta]) => `${symbol}${delta > 0 ? `+${delta}` : delta}`);
    warnings.push(
      `Heavy-atom imbalance between reactants and target products: ${parts.join(", ")}. Check whether a byproduct or co-reagent is missing from your inputs.`
    );
  }
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

