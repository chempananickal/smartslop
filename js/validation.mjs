// Static linter for reaction-template requests. Ported from src/validation.rs.
// Same output shape as the old Rust `validate_template_request`:
//   { ok: boolean, messages: [{ level: "error"|"warning", field, message }] }

function errorMessage(field, message) {
  return { level: "error", field, message };
}

function warningMessage(field, message) {
  return { level: "warning", field, message };
}

function collectAtomMaps(side) {
  const maps = new Set();
  const re = /:(\d+)/g;
  let match;
  while ((match = re.exec(side)) !== null) {
    maps.add(Number(match[1]));
  }
  return maps;
}

function difference(a, b) {
  const out = [];
  for (const value of a) if (!b.has(value)) out.push(value);
  out.sort((x, y) => x - y);
  return out;
}

function validateReactionSmarts(rawValue, messages) {
  const trimmed = (rawValue ?? "").trim();
  if (!trimmed) {
    messages.push(errorMessage("reaction_smarts", "Reaction SMARTS is required."));
    return;
  }

  const separatorIndex = trimmed.indexOf(">>");
  if (separatorIndex < 0) {
    messages.push(errorMessage(
      "reaction_smarts",
      "Reaction SMARTS must contain a '>>' separator between reactants and products."
    ));
    return;
  }

  const lhs = trimmed.slice(0, separatorIndex);
  const rhs = trimmed.slice(separatorIndex + 2);
  if (!lhs.trim() || !rhs.trim()) {
    messages.push(errorMessage(
      "reaction_smarts",
      "Reaction SMARTS must have atoms on both sides of '>>'."
    ));
    return;
  }

  const lhsMaps = collectAtomMaps(lhs);
  const rhsMaps = collectAtomMaps(rhs);

  if (lhsMaps.size === 0 && rhsMaps.size === 0) {
    messages.push(warningMessage(
      "reaction_smarts",
      "Reaction SMARTS has no atom maps (e.g. [C:1]). Unmapped templates often generate unrelated products."
    ));
    return;
  }

  const unmappedRhs = difference(rhsMaps, lhsMaps);
  if (unmappedRhs.length) {
    messages.push(warningMessage(
      "reaction_smarts",
      `Product side references atom maps not present on the reactant side: [${unmappedRhs.join(", ")}]. RDKit will treat these as new atoms.`
    ));
  }

  const droppedLhs = difference(lhsMaps, rhsMaps);
  if (droppedLhs.length) {
    messages.push(warningMessage(
      "reaction_smarts",
      `Reactant atom maps missing from products: [${droppedLhs.join(", ")}]. Those atoms will be dropped from the generated products.`
    ));
  }
}

function validateMolecules(scope, molecules, messages) {
  molecules.forEach((molecule, index) => {
    const field = `${scope}[${index}]`;
    const trimmed = (molecule?.value ?? "").trim();
    if (!trimmed) {
      messages.push(errorMessage(field, "Molecule input cannot be empty."));
      return;
    }
    if (trimmed.split(/\r?\n/).length > 1) {
      messages.push(warningMessage(
        field,
        "SMILES input is usually a single line; extra lines will be ignored."
      ));
    }
  });
}

export function validateTemplateRequest(request) {
  const messages = [];
  const reactants = request?.reactants ?? [];
  const products = request?.products ?? [];

  if (reactants.length === 0) {
    messages.push(errorMessage("reactants", "At least one reactant input is required."));
  }
  if (products.length === 0) {
    messages.push(errorMessage("products", "At least one target product input is required."));
  }

  validateMolecules("reactants", reactants, messages);
  validateMolecules("products", products, messages);
  validateReactionSmarts(request?.reaction_smarts, messages);

  const ok = !messages.some((m) => m.level === "error");
  return { ok, messages };
}
