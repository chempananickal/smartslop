use crate::models::{
    MessageLevel, MoleculeFormat, MoleculeInput, NextStep, TemplateBuildRequest,
    ValidationMessage, ValidationReport,
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
            "At least one product input is required.",
        ));
    }

    validate_molecules("reactants", &request.reactants, &mut messages);
    validate_molecules("products", &request.products, &mut messages);
    validate_reaction_smarts(request.reaction_smarts.as_deref(), &mut messages);

    let ok = !messages
        .iter()
        .any(|message| message.level == MessageLevel::Error);

    ValidationReport {
        ok,
        requires_rdkit: ok,
        next_step: if ok {
            NextStep::InvokeRdkitBridge
        } else {
            NextStep::FixValidationErrors
        },
        messages,
    }
}

fn validate_reaction_smarts(value: Option<&str>, messages: &mut Vec<ValidationMessage>) {
    let Some(raw_value) = value else {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS is required for template execution.",
        ));
        return;
    };

    let trimmed = raw_value.trim();

    if trimmed.is_empty() {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS cannot be empty when provided.",
        ));
        return;
    }

    if !trimmed.contains(">>") {
        messages.push(error_message(
            "reaction_smarts",
            "Reaction SMARTS must contain a '>>' separator between reactants and products.",
        ));
    }

    if !trimmed.contains(':') {
        messages.push(warning_message(
            "reaction_smarts",
            "Reaction SMARTS without atom-mapping may execute poorly or fail to produce useful product sets.",
        ));
    }
}

fn validate_molecules(scope: &str, molecules: &[MoleculeInput], messages: &mut Vec<ValidationMessage>) {
    for (index, molecule) in molecules.iter().enumerate() {
        let field = format!("{scope}[{index}]");
        let trimmed = molecule.value.trim();

        if trimmed.is_empty() {
            messages.push(error_message(&field, "Molecule input cannot be empty."));
            continue;
        }

        match molecule.format {
            MoleculeFormat::Smiles => validate_smiles(&field, trimmed, messages),
            MoleculeFormat::Sdf | MoleculeFormat::Molfile => {
                validate_structure_block(&field, trimmed, messages)
            }
            MoleculeFormat::GraphJson => validate_graph_json(&field, trimmed, messages),
        }
    }
}

fn validate_smiles(field: &str, value: &str, messages: &mut Vec<ValidationMessage>) {
    if value.lines().count() > 1 {
        messages.push(warning_message(
            field,
            "SMILES input is usually a single line. Extra lines will need normalization before RDKit processing.",
        ));
    }
}

fn validate_structure_block(field: &str, value: &str, messages: &mut Vec<ValidationMessage>) {
    if !value.contains("M  END") {
        messages.push(error_message(
            field,
            "Structure blocks must include an 'M  END' record.",
        ));
    }
}

fn validate_graph_json(field: &str, value: &str, messages: &mut Vec<ValidationMessage>) {
    if !(value.starts_with('{') || value.starts_with('[')) {
        messages.push(error_message(
            field,
            "Graph JSON input must start with '{' or '['.",
        ));
        return;
    }

    if let Err(error) = serde_json::from_str::<serde_json::Value>(value) {
        messages.push(error_message(
            field,
            &format!("Graph JSON input is not valid JSON: {error}"),
        ));
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
            format: MoleculeFormat::Smiles,
            value: value.to_owned(),
            label: None,
        }
    }

    #[test]
    fn rejects_missing_reaction_sides() {
        let request = TemplateBuildRequest {
            reactants: Vec::new(),
            products: Vec::new(),
            reaction_smarts: None,
            include_stereochemistry: false,
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        assert_eq!(report.next_step, NextStep::FixValidationErrors);
        assert_eq!(report.messages.len(), 3);
    }

    #[test]
    fn accepts_simple_smiles_request() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCO")],
            products: vec![smiles_input("CC=O")],
            reaction_smarts: Some("[CH3:1][CH2:2][OH:3]>>[CH3:1][CH:2]=[O:3]".to_owned()),
            include_stereochemistry: true,
            template_name: Some("ethanol oxidation".to_owned()),
        };

        let report = validate_request(&request);

        assert!(report.ok);
        assert!(report.requires_rdkit);
        assert!(report.messages.is_empty());
        assert_eq!(report.next_step, NextStep::InvokeRdkitBridge);
    }

    #[test]
    fn rejects_invalid_graph_json() {
        let request = TemplateBuildRequest {
            reactants: vec![MoleculeInput {
                format: MoleculeFormat::GraphJson,
                value: "{bad json}".to_owned(),
                label: None,
            }],
            products: vec![smiles_input("CC=O")],
            reaction_smarts: None,
            include_stereochemistry: false,
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        assert!(report
            .messages
            .iter()
            .any(|message| message.field == "reactants[0]"));
        assert!(report
            .messages
            .iter()
            .any(|message| message.field == "reaction_smarts"));
    }

    #[test]
    fn rejects_invalid_reaction_smarts_shape() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr")],
            products: vec![smiles_input("CCO")],
            reaction_smarts: Some("CCBr.O>CCO".to_owned()),
            include_stereochemistry: false,
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        assert!(report
            .messages
            .iter()
            .any(|message| message.field == "reaction_smarts"));
    }

    #[test]
    fn rejects_missing_reaction_smarts() {
        let request = TemplateBuildRequest {
            reactants: vec![smiles_input("CCBr")],
            products: vec![smiles_input("CCO")],
            reaction_smarts: None,
            include_stereochemistry: false,
            template_name: None,
        };

        let report = validate_request(&request);

        assert!(!report.ok);
        assert!(report
            .messages
            .iter()
            .any(|message| message.field == "reaction_smarts"));
    }
}