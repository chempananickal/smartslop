use wasm_bindgen::JsValue;

#[derive(Debug, thiserror::Error)]
pub enum SmartslopError {
    #[error("invalid request payload: {0}")]
    InvalidRequest(String),
    #[error("failed to serialize response: {0}")]
    SerializeResponse(String),
    #[error("request validation failed")]
    ValidationFailed,
    #[error("rdkit adapter threw an exception: {0}")]
    RdkitAdapterThrew(String),
    #[error("rdkit adapter must return a Promise")]
    AdapterMustReturnPromise,
    #[error("rdkit adapter promise was rejected: {0}")]
    RdkitAdapterRejected(String),
}

impl SmartslopError {
    pub fn into_js_value(self) -> JsValue {
        JsValue::from_str(&self.to_string())
    }
}