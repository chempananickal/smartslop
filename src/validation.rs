use std::collections::HashSet;

use crate::models::{
    MessageLevel, MoleculeInput, TemplateBuildRequest, ValidationMessage, ValidationReport,
};

pub fn validate_request(request: &TemplateBuildRequest) -> ValidationReport {
    let mut messages = Vec::new();

    if request.reactants.is_empty() {
        messages.push(error_message(
            "reactants",
            "At least one reactant input is required.",
        ));
    }

    if request.products.is_empty() {
        messages.push(error_message(
            "products",
            "At least one target product input is required.",
        ));
    }

    validate_molecules("reactants", &request.reactants, &mut messages);
    validate_molecules("products", &request.products, &mut messages);
    validate_reaction_smarts(&request.reaction_smarts, &mut messages);

    let ok = !messages
        .iter()
        .any(|message| message.level == MessageLevel::Error);

    ValidationReport { ok, messages }
}

fn validate_reaction_smarts(raw_value: &str, messages: &mut Vec<ValidationMessage>) {
    let trimmed = raw_value.trim();

    if trimmed.is_empty() {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS is required.",
        ));
        return;
    }

    let Some((lhs, rhs)) = trimmed.split_once(">>") else {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS must contain a '>>' separator between reactants and products.",
        ));
        return;
    };

    if lhs.trim().is_empty() || rhs.trim().is_empty() {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS must have atoms on both sides of '>>'.",
        ));
        return;
    }

    let lhs_maps = collect_atom_maps(lhs);
    let rhs_maps = collect_atom_maps(rhs);

    if lhs_maps.is_empty() && rhs_maps.is_empty() {
        messages.push(warning_message(
            "reaction_smarts",
            "Reaction SMARTS has no atom maps (e.g. [C:1]). Unmapped templates often generate unrelated products.",
        ));
        return;
    }

    let unmapped_rhs: Vec<u32> = rhs_maps.difference(&lhs_maps).copied().collect();
    if !unmapped_rhs.is_empty() {
        let mut sorted = unmapped_rhs;
        sorted.sort();
        messages.push(warning_message(
            "reaction_smarts",
            &format!(
                "Product side references atom maps not present on the reactant side: {sorted:?}. RDKit will treat these as new atoms."
            ),
        ));
    }

    let dropped_lhs: Vec<u32> = lhs_maps.difference(&rhs_maps).copied().collect();
    if !dropped_lhs.is_empty() {
        let mut sorted = dropped_lhs;
        sorted.sort();
        messages.push(warning_message(
            "reaction_smarts",
            &format!(
                "Reactant atom maps missing from products: {sorted:?}. Those atoms will be dropped from the generated products."
            ),
        ));
    }
}

fn collect_atom_maps(side: &str) -> HashSet<u32> {
    let mut maps = HashSet::new();
    let bytes = side.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b':' {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > index + 1
                && let Ok(value) = side[index + 1..end].parse::<u32>()
            {
                maps.insert(value);
            }
            index = end;
        } else {
            index += 1;
        }
    }

    maps
}

fn validate_molecules(
    scope: &str,
    molecules: &[MoleculeInput],
    messages: &mut Vec<ValidationMessage>,
) {
    for (index, molecule) in molecules.iter().enumerate() {
        let field = format!("{scope}[{index}]");
        let trimmed = molecule.value.trim();

        if trimmed.is_empty() {
            messages.push(error_message(&field, "Molecule input cannot be empty."));
            continue;
        }

        if trimmed.lines().count() > 1 {
            messages.push(warning_message(
                &field,
                "SMILES input is usually a single line; extra lines will be ignored.",
            ));
        }
    }
}

fn error_message(field: &str, message: &str) -> ValidationMessage {
    ValidationMessage {
        level: MessageLevel::Error,
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

fn warning_message(field: &str, message: &str) -> ValidationMessage {
    ValidationMessage {
        level: MessageLevel::Warning,
        field: field.to_owned(),
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn smiles_input(value: &str) -> MoleculeInput {
        MoleculeInput {
            value: value.to_owned(),
            label: None,
        }
    }

    #[test]
    fn rejects_missing_reaction_sides() {
        let request = TemplateBuildRequest {
            reactants: Vec::new(),
            products: Vec::new(),
            reaction_smarts: String::new(),
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        // reactants, products, reaction_smarts
        assert_eq!(report.messages.len(), 3);
    }

    #[test]
    fn accepts_simple_smiles_request() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCO")],
            products: vec![smiles_input("CC=O")],
            reaction_smarts: "[CH3:1][CH2:2][OH:3]>>[CH3:1][CH:2]=[O:3]".to_owned(),
            template_name: Some("ethanol oxidation".to_owned()),
        };

        let report = validate_request(&request);

        assert!(report.ok);
        assert!(report.messages.is_empty());
    }

    #[test]
    fn rejects_invalid_reaction_smarts_shape() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr")],
            products: vec![smiles_input("CCO")],
            reaction_smarts: "CCBr.O>CCO".to_owned(),
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        assert!(
            report
                .messages
                .iter()
                .any(|m| m.field == "reaction_smarts")
        );
    }

    #[test]
    fn warns_on_unmapped_smarts() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr"), smiles_input("O")],
            products: vec![smiles_input("CCO")],
            reaction_smarts: "CCBr.O>>CCO".to_owned(),
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(report.ok);
        assert!(report.messages.iter().any(|m| {
            m.level == MessageLevel::Warning
                && m.field == "reaction_smarts"
                && m.message.contains("no atom maps")
        }));
    }

    #[test]
    fn warns_when_product_side_introduces_atom_maps() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr")],
            products: vec![smiles_input("CCO")],
            reaction_smarts: "[CH3:1][CH2:2][Br:3]>>[CH3:1][CH2:2][OH:4]".to_owned(),
            template_name: None,
        };

        let report = validate_request(&request);
        assert!(report.ok);
        assert!(report.messages.iter().any(|m| m
            .message
            .contains("not present on the reactant side")));
    }

    #[test]
    fn warns_when_reactant_maps_dropped() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr")],
            products: vec![smiles_input("CC")],
            reaction_smarts: "[CH3:1][CH2:2][Br:3]>>[CH3:1][CH3:2]".to_owned(),
            template_name: None,
        };

        let report = validate_request(&request);
        assert!(report.ok);
        assert!(report
            .messages
            .iter()
            .any(|m| m.message.contains("missing from products")));
    }
}