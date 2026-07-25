mod errors;
mod models;
mod validation;

use errors::SmartslopError;
use js_sys::{Function, Promise};
use serde::Serialize;
pub use models::*;
pub use validation::validate_request;
use wasm_bindgen::{JsCast, prelude::*};
use wasm_bindgen_futures::JsFuture;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen(start))]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn validate_template_request(request: JsValue) -> Result<JsValue, JsValue> {
    let parsed = parse_request(request)?;
    let report = validate_request(&parsed);
    to_js_value(&report)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn prepare_rdkit_request(request: JsValue) -> Result<JsValue, JsValue> {
    let parsed = parse_request(request)?;
    let validation = validate_request(&parsed);

    if !validation.ok {
        return Err(SmartslopError::ValidationFailed.into_js_value());
    }

    let bridge_request = RdkitBridgeRequest {
        request: parsed,
        validation,
    };

    to_js_value(&bridge_request)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub async fn run_rdkit_bridge(request: JsValue, adapter: Function) -> Result<JsValue, JsValue> {
    let bridge_request = prepare_rdkit_request(request)?;
    let returned = adapter
        .call1(&JsValue::NULL, &bridge_request)
        .map_err(|_| SmartslopError::RdkitAdapterThrew.into_js_value())?;
    let promise: Promise = returned
        .dyn_into()
        .map_err(|_| SmartslopError::AdapterMustReturnPromise.into_js_value())?;

    JsFuture::from(promise)
        .await
        .map_err(|_| SmartslopError::RdkitAdapterRejected.into_js_value())
}

fn parse_request(request: JsValue) -> Result<TemplateBuildRequest, JsValue> {
    serde_wasm_bindgen::from_value(request)
        .map_err(|error| SmartslopError::InvalidRequest(error.to_string()).into_js_value())
}

fn to_js_value<T>(value: &T) -> Result<JsValue, JsValue>
where
    T: Serialize,
{
    serde_wasm_bindgen::to_value(value)
        .map_err(|error| SmartslopError::SerializeResponse(error.to_string()).into_js_value())
}
