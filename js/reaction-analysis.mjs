const ELEMENT_SYMBOLS = {
  1: "H",
  3: "Li",
  5: "B",
  6: "C",
  7: "N",
  8: "O",
  9: "F",
  11: "Na",
  12: "Mg",
  14: "Si",
  15: "P",
  16: "S",
  17: "Cl",
  19: "K",
  20: "Ca",
  26: "Fe",
  29: "Cu",
  30: "Zn",
  35: "Br",
  53: "I"
};

function addCount(target, symbol, increment = 1) {
  target[symbol] = (target[symbol] ?? 0) + increment;
}

function isEmptyCounts(counts) {
  return Object.keys(counts).length === 0;
}

function sortedSymbols(counts) {
  const symbols = Object.keys(counts).filter((symbol) => counts[symbol] > 0);
  const rest = symbols.filter((symbol) => symbol !== "C" && symbol !== "H").sort();

  if (symbols.includes("C")) {
    return ["C", ...(symbols.includes("H") ? ["H"] : []), ...rest];
  }

  return symbols.sort();
}

export function formatFormula(counts) {
  const symbols = sortedSymbols(counts);

  if (symbols.length === 0) {
    return "Balanced";
  }

  return symbols
    .map((symbol) => `${symbol}${counts[symbol] > 1 ? counts[symbol] : ""}`)
    .join("");
}

function countsFromJson(jsonString) {
  const payload = JSON.parse(jsonString);
  const counts = {};
  const defaultAtom = payload.defaults?.atom ?? {};

  for (const molecule of payload.molecules ?? []) {
    for (const atom of molecule.atoms ?? []) {
      const atomicNumber = atom.z ?? defaultAtom.z ?? 6;
      const hydrogenCount = atom.impHs ?? defaultAtom.impHs ?? 0;
      const symbol = ELEMENT_SYMBOLS[atomicNumber] ?? `Z${atomicNumber}`;

      addCount(counts, symbol, 1);
      if (hydrogenCount > 0) {
        addCount(counts, "H", hydrogenCount);
      }
    }
  }

  return counts;
}

function cloneCounts(counts) {
  return Object.fromEntries(Object.entries(counts).map(([symbol, count]) => [symbol, count]));
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

function diffCounts(left, right) {
  const diff = {};
  const symbols = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const symbol of symbols) {
    const value = (left[symbol] ?? 0) - (right[symbol] ?? 0);
    if (value !== 0) {
      diff[symbol] = value;
    }
  }

  return diff;
}

function productIdentity(record) {
  return record.canonicalSmiles ?? record.formula ?? record.label ?? "unknown_product";
}

function multisetFromValues(values) {
  const counts = {};

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function multisetFromProducts(records) {
  return multisetFromValues(records.map(productIdentity));
}

function expandMultiset(counts) {
  return Object.entries(counts)
    .flatMap(([value, count]) => Array.from({ length: count }, () => value))
    .sort();
}

function buildProductSignature(records) {
  const values = records.map(productIdentity).sort();
  return values.length ? values.join(" + ") : "No products";
}

function diffMultisets(left, right) {
  const diff = {};

  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const value = (left[key] ?? 0) - (right[key] ?? 0);
    if (value > 0) {
      diff[key] = value;
    }
  }

  return diff;
}

function intersectMultisets(left, right) {
  const intersection = {};

  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const shared = Math.min(left[key] ?? 0, right[key] ?? 0);
    if (shared > 0) {
      intersection[key] = shared;
    }
  }

  return intersection;
}

function moleculeRecordFromMol(RDKitModule, jsMol, baseRecord) {
  const atomCounts = countsFromJson(jsMol.get_json());

  return {
    ...baseRecord,
    canonicalSmiles: jsMol.get_smiles(),
    molblock: jsMol.get_molblock(),
    svg: jsMol.get_svg(300, 220),
    atomCounts,
    formula: formatFormula(atomCounts)
  };
}

function summarizeMolecule(RDKitModule, molecule, role, index) {
  const jsMol = RDKitModule.get_mol(molecule.value);

  if (jsMol == null) {
    throw new Error(`RDKit rejected ${role}[${index}] as invalid ${molecule.format} input.`);
  }

  try {
    return moleculeRecordFromMol(RDKitModule, jsMol, {
      index,
      role,
      format: molecule.format,
      label: molecule.label ?? `${role} ${index + 1}`,
      sourceInput: molecule.value,
      sourceSmiles: molecule.value
    });
  } finally {
    jsMol.delete?.();
  }
}

function compareProductSets(targetProducts, candidateProducts) {
  const targetCounts = multisetFromProducts(targetProducts);
  const candidateCounts = multisetFromProducts(candidateProducts);
  const matchedCounts = intersectMultisets(targetCounts, candidateCounts);
  const missingCounts = diffMultisets(targetCounts, candidateCounts);
  const unexpectedCounts = diffMultisets(candidateCounts, targetCounts);
  const matchedProducts = expandMultiset(matchedCounts);
  const missingProducts = expandMultiset(missingCounts);
  const unexpectedProducts = expandMultiset(unexpectedCounts);
  const exact = missingProducts.length === 0 && unexpectedProducts.length === 0;
  const score = matchedProducts.length / Math.max(targetProducts.length, candidateProducts.length, 1);

  return {
    verdict: exact ? "exact_match" : matchedProducts.length > 0 ? "partial_match" : "no_match",
    exact,
    score,
    targetSignature: buildProductSignature(targetProducts),
    outcomeSignature: buildProductSignature(candidateProducts),
    matchedProducts,
    missingProducts,
    unexpectedProducts
  };
}

function chooseBestOutcome(outcomes) {
  return [...outcomes].sort((left, right) => {
    if (left.comparison.exact !== right.comparison.exact) {
      return Number(right.comparison.exact) - Number(left.comparison.exact);
    }

    if (left.comparison.score !== right.comparison.score) {
      return right.comparison.score - left.comparison.score;
    }

    if (left.comparison.missingProducts.length !== right.comparison.missingProducts.length) {
      return left.comparison.missingProducts.length - right.comparison.missingProducts.length;
    }

    if (left.comparison.unexpectedProducts.length !== right.comparison.unexpectedProducts.length) {
      return left.comparison.unexpectedProducts.length - right.comparison.unexpectedProducts.length;
    }

    return left.index - right.index;
  })[0] ?? null;
}

function summarizeOutcomeSet(RDKitModule, productSet, outcomeIndex, targetProducts) {
  const products = [];

  for (let productIndex = 0; productIndex < productSet.size(); productIndex += 1) {
    const jsMol = productSet.at(productIndex);

    try {
      const canonicalSmiles = jsMol.get_smiles();
      products.push(
        moleculeRecordFromMol(RDKitModule, jsMol, {
          index: productIndex,
          role: "generated_product",
          format: "smiles",
          label: `outcome ${outcomeIndex + 1}.${productIndex + 1}`,
          sourceInput: canonicalSmiles,
          sourceSmiles: canonicalSmiles
        })
      );
    } finally {
      jsMol.delete?.();
    }
  }

  return {
    index: outcomeIndex,
    products,
    signature: buildProductSignature(products),
    formula: formatFormula(aggregateCounts(products)),
    comparison: compareProductSets(targetProducts, products)
  };
}

function createReactantMolList(RDKitModule, reactants) {
  const molList = new RDKitModule.MolList();
  const allocated = [];

  for (const reactant of reactants) {
    const sourceValue = reactant.sourceInput ?? reactant.sourceSmiles ?? reactant.canonicalSmiles;
    const jsMol = RDKitModule.get_mol(sourceValue);

    if (jsMol == null) {
      throw new Error(`RDKit could not prepare reactant ${reactant.label} for reaction execution.`);
    }

    allocated.push(jsMol);
    molList.append(jsMol);
  }

  return { molList, allocated };
}

function formatProductList(values) {
  return values.length ? values.join(", ") : null;
}

function buildTemplateSummary(verdict, generatedOutcomes, bestOutcome) {
  if (verdict === "template_exact_match") {
    return `The reaction SMARTS generated the requested target products exactly. ${generatedOutcomes.length} outcome set${generatedOutcomes.length === 1 ? "" : "s"} were enumerated.`;
  }

  if (verdict === "template_partial_match") {
    const missing = formatProductList(bestOutcome.comparison.missingProducts);
    const unexpected = formatProductList(bestOutcome.comparison.unexpectedProducts);
    const parts = [
      `The reaction SMARTS generated ${generatedOutcomes.length} outcome set${generatedOutcomes.length === 1 ? "" : "s"}; the best outcome overlaps with the requested products.`
    ];

    if (missing) {
      parts.push(`Missing target products: ${missing}.`);
    }

    if (unexpected) {
      parts.push(`Additional generated products: ${unexpected}.`);
    }

    return parts.join(" ");
  }

  if (verdict === "template_generated_other_products") {
    return `The reaction SMARTS generated ${generatedOutcomes.length} outcome set${generatedOutcomes.length === 1 ? "" : "s"}, but none matched the requested target products.`;
  }

  return "The reaction SMARTS executed against the supplied reactants but did not generate any product sets.";
}

function buildTemplateExecutionResult(RDKitModule, request, reactants, targetProducts) {
  const reactionSmarts = request.reaction_smarts?.trim();
  const reactantFormula = formatFormula(aggregateCounts(reactants));
  const targetFormula = formatFormula(aggregateCounts(targetProducts));

  if (!reactionSmarts) {
    return {
      reactionTemplate: {
        provided: false,
        smarts: null,
        svg: null,
        generatedOutcomes: [],
        outcomeCount: 0,
        bestOutcomeIndex: null,
        exactMatch: false,
        apiAvailable: typeof RDKitModule.get_rxn === "function" && typeof RDKitModule.MolList === "function",
        valid: false,
        targetSignature: buildProductSignature(targetProducts)
      },
      bestOutcome: null,
      reactionCheck: {
        possible: false,
        verdict: "missing_reaction_smarts",
        summary: "Provide a reaction SMARTS template to execute against the supplied reactants.",
        reactantFormula,
        targetFormula,
        generatedFormula: null,
        outcomeCount: 0,
        bestOutcomeIndex: null,
        comparison: null
      }
    };
  }

  if (typeof RDKitModule.get_rxn !== "function" || typeof RDKitModule.MolList !== "function") {
    return {
      reactionTemplate: {
        provided: true,
        smarts: reactionSmarts,
        svg: null,
        generatedOutcomes: [],
        outcomeCount: 0,
        bestOutcomeIndex: null,
        exactMatch: false,
        apiAvailable: false
      },
      bestOutcome: null,
      reactionCheck: {
        possible: false,
        verdict: "reaction_api_unavailable",
        summary: "This RDKit.js build does not expose reaction execution APIs.",
        reactantFormula,
        targetFormula,
        comparison: null,
        generatedFormula: null,
        outcomeCount: 0,
        bestOutcomeIndex: null
      }
    };
  }

  const reaction = RDKitModule.get_rxn(reactionSmarts);

  if (reaction == null) {
    return {
      reactionTemplate: {
        provided: true,
        smarts: reactionSmarts,
        svg: null,
        generatedOutcomes: [],
        outcomeCount: 0,
        bestOutcomeIndex: null,
        exactMatch: false,
        apiAvailable: true,
        valid: false
      },
      bestOutcome: null,
      reactionCheck: {
        possible: false,
        verdict: "invalid_reaction_smarts",
        summary: "RDKit could not parse the reaction SMARTS. Use an atom-mapped reaction SMARTS string with a '>>' separator.",
        reactantFormula,
        targetFormula,
        comparison: null,
        generatedFormula: null,
        outcomeCount: 0,
        bestOutcomeIndex: null
      }
    };
  }

  let reactionSvg = null;
  let generatedOutcomes = [];
  let executionError = null;

  try {
    reactionSvg = reaction.get_svg?.() ?? null;

    const { molList, allocated } = createReactantMolList(RDKitModule, reactants);
    let outcomeSets = null;

    try {
      outcomeSets = reaction.run_reactants(molList);

      for (let outcomeIndex = 0; outcomeIndex < outcomeSets.size(); outcomeIndex += 1) {
        const productSet = outcomeSets.get(outcomeIndex);

        try {
          generatedOutcomes.push(
            summarizeOutcomeSet(RDKitModule, productSet, outcomeIndex, targetProducts)
          );
        } finally {
          productSet.delete?.();
        }
      }
    } catch (error) {
      executionError = String(error);
    } finally {
      outcomeSets?.delete?.();
      for (const jsMol of allocated) {
        jsMol.delete?.();
      }
      molList.delete?.();
    }
  } finally {
    reaction.delete?.();
  }

  if (executionError) {
    return {
      reactionTemplate: {
        provided: true,
        smarts: reactionSmarts,
        svg: reactionSvg,
        generatedOutcomes: [],
        outcomeCount: 0,
        bestOutcomeIndex: null,
        exactMatch: false,
        apiAvailable: true,
        valid: true
      },
      bestOutcome: null,
      reactionCheck: {
        possible: false,
        verdict: "template_execution_failed",
        summary: `RDKit parsed the reaction SMARTS but could not execute it against the supplied reactants: ${executionError}`,
        reactantFormula,
        targetFormula,
        comparison: null,
        generatedFormula: null,
        outcomeCount: 0,
        bestOutcomeIndex: null
      }
    };
  }

  const bestOutcome = chooseBestOutcome(generatedOutcomes);
  const comparison = bestOutcome?.comparison ?? {
    verdict: "no_match",
    exact: false,
    score: 0,
    targetSignature: buildProductSignature(targetProducts),
    outcomeSignature: null,
    matchedProducts: [],
    missingProducts: targetProducts.map(productIdentity),
    unexpectedProducts: []
  };
  let verdict = "template_no_products";
  if (bestOutcome) {
    verdict = comparison.exact
      ? "template_exact_match"
      : comparison.score > 0
        ? "template_partial_match"
        : "template_generated_other_products";
  }

  return {
    reactionTemplate: {
      provided: true,
      smarts: reactionSmarts,
      svg: reactionSvg,
      generatedOutcomes,
      outcomeCount: generatedOutcomes.length,
      bestOutcomeIndex: bestOutcome?.index ?? null,
      exactMatch: comparison.exact,
      apiAvailable: true,
      valid: true,
      targetSignature: buildProductSignature(targetProducts)
    },
    bestOutcome: bestOutcome
      ? {
          index: bestOutcome.index,
          products: bestOutcome.products,
          signature: bestOutcome.signature,
          formula: bestOutcome.formula,
          comparison
        }
      : null,
    reactionCheck: {
      possible: comparison.exact,
      verdict,
      summary: buildTemplateSummary(verdict, generatedOutcomes, bestOutcome),
      reactantFormula,
      targetFormula,
      generatedFormula: bestOutcome?.formula ?? null,
      comparison,
      outcomeCount: generatedOutcomes.length,
      bestOutcomeIndex: bestOutcome?.index ?? null
    }
  };
}

export function analyzeReactionRequest(RDKitModule, bridgeRequest) {
  const { request } = bridgeRequest;
  const reactants = request.reactants.map((molecule, index) =>
    summarizeMolecule(RDKitModule, molecule, "reactant", index)
  );
  const products = request.products.map((molecule, index) =>
    summarizeMolecule(RDKitModule, molecule, "product", index)
  );
  const templateExecution = buildTemplateExecutionResult(RDKitModule, request, reactants, products);

  return {
    status: "rdkit_ready",
    analysisType: "reaction_template_execution",
    rdkitVersion: RDKitModule.version(),
    templateName: request.template_name ?? null,
    reactionSmarts: request.reaction_smarts ?? null,
    includeStereochemistry: request.include_stereochemistry,
    reactants,
    products,
    generatedOutcomes: templateExecution.reactionTemplate.generatedOutcomes,
    bestOutcome: templateExecution.bestOutcome,
    reactionTemplate: templateExecution.reactionTemplate,
    reactionCheck: templateExecution.reactionCheck
  };
}