use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MoleculeInput {
    pub value: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TemplateBuildRequest {
    pub reactants: Vec<MoleculeInput>,
    pub products: Vec<MoleculeInput>,
    pub reaction_smarts: String,
    #[serde(default)]
    pub template_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageLevel {
    Error,
    Warning,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ValidationMessage {
    pub level: MessageLevel,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ValidationReport {
    pub ok: bool,
    pub messages: Vec<ValidationMessage>,
}