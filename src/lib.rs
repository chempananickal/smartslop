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
pub async fn run_rdkit_bridge(request: JsValue, adapter: Function) -> Result<JsValue, JsValue> {
    let parsed = parse_request(request)?;
    let report = validate_request(&parsed);
    if !report.ok {
        return Err(SmartslopError::ValidationFailed.into_js_value());
    }

    let payload = to_js_value(&parsed)?;
    let returned = adapter
        .call1(&JsValue::NULL, &payload)
        .map_err(|error| SmartslopError::RdkitAdapterThrew(js_error_string(&error)).into_js_value())?;
    let promise: Promise = returned
        .dyn_into()
        .map_err(|_| SmartslopError::AdapterMustReturnPromise.into_js_value())?;

    JsFuture::from(promise)
        .await
        .map_err(|error| SmartslopError::RdkitAdapterRejected(js_error_string(&error)).into_js_value())
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

fn js_error_string(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| value.dyn_ref::<js_sys::Error>().map(|error| error.to_string().into()))
        .unwrap_or_else(|| format!("{value:?}"))
}
