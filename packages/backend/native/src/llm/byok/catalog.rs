use std::collections::BTreeMap;

use llm_adapter::capability::provider_default_capability_upper_bound;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{ByokCapabilityInput, contract::capability_input};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[napi_derive::napi(object)]
pub struct ByokCatalogModelOutput {
  pub model_id: String,
  pub display_name: String,
  pub recommended: bool,
  pub capabilities: Vec<ByokCapabilityInput>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[napi_derive::napi(object)]
pub struct ByokCatalogProviderOutput {
  pub provider: String,
  pub models: Vec<ByokCatalogModelOutput>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[napi_derive::napi(object)]
pub struct ByokCatalogOutput {
  pub version: String,
  pub providers: Vec<ByokCatalogProviderOutput>,
}

pub fn byok_catalog() -> ByokCatalogOutput {
  let variants = llm_adapter::core::default_model_registry_variants();
  let mut providers = ["openai", "anthropic", "gemini", "fal"]
    .into_iter()
    .map(|provider| (provider, BTreeMap::new()))
    .collect::<BTreeMap<_, BTreeMap<String, ByokCatalogModelOutput>>>();

  for variant in variants {
    let Some(provider) = provider_for_backend(&variant.backend_kind) else {
      continue;
    };
    let Some(capabilities) = provider_default_capability_upper_bound(provider, &variant.raw_model_id) else {
      continue;
    };
    providers
      .entry(provider)
      .or_default()
      .entry(variant.raw_model_id.clone())
      .or_insert_with(|| ByokCatalogModelOutput {
        model_id: variant.raw_model_id.clone(),
        display_name: variant.display_name.unwrap_or_else(|| variant.raw_model_id.clone()),
        recommended: is_recommended_model(provider, &variant.raw_model_id, &variant.capabilities),
        capabilities: capabilities.into_iter().map(capability_input).collect(),
      });
  }

  let providers = providers
    .into_iter()
    .map(|(provider, models)| {
      let mut models = models.into_values().collect::<Vec<_>>();
      models.sort_by_key(|model| model_catalog_priority(provider, &model.model_id));
      ByokCatalogProviderOutput {
        provider: provider.to_string(),
        models,
      }
    })
    .collect::<Vec<_>>();
  let encoded = serde_json::to_vec(&providers).expect("BYOK catalog must serialize");
  let version = Sha256::digest(encoded)
    .iter()
    .take(8)
    .map(|byte| format!("{byte:02x}"))
    .collect();
  ByokCatalogOutput { version, providers }
}

fn is_recommended_model(provider: &str, model_id: &str, capabilities: &[llm_adapter::core::ModelCapability]) -> bool {
  if provider == "openai" {
    return matches!(model_id, "gpt-5.6-luna" | "gpt-image-2" | "text-embedding-3-small");
  }
  capabilities
    .iter()
    .any(|capability| capability.default_for_output_type == Some(true))
}

fn model_catalog_priority(provider: &str, model_id: &str) -> (u8, String) {
  if provider == "openai" {
    let rank = match model_id {
      "gpt-5.6-luna" => 0,
      "gpt-image-2" => 1,
      "text-embedding-3-small" => 2,
      model_id if model_id.starts_with("gpt-5.6-") => 3,
      _ => 4,
    };
    return (rank, model_id.to_string());
  }
  (0, model_id.to_string())
}

fn provider_for_backend(backend: &str) -> Option<&'static str> {
  match backend {
    "openai_responses" => Some("openai"),
    "anthropic" => Some("anthropic"),
    "gemini_api" => Some("gemini"),
    "fal" => Some("fal"),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn catalog_contains_explicit_provider_default_declarations() {
    let catalog = byok_catalog();
    assert!(!catalog.version.is_empty());
    for provider in &catalog.providers {
      assert!(
        !provider.models.is_empty(),
        "{} has no catalog models",
        provider.provider
      );
      for model in &provider.models {
        assert!(!model.model_id.is_empty());
        assert!(!model.capabilities.is_empty());
      }
    }
  }

  #[test]
  fn openai_catalog_prioritizes_current_default_models() {
    let catalog = byok_catalog();
    let openai = catalog
      .providers
      .iter()
      .find(|provider| provider.provider == "openai")
      .expect("OpenAI catalog");

    assert_eq!(
      openai
        .models
        .iter()
        .take(5)
        .map(|model| model.model_id.as_str())
        .collect::<Vec<_>>(),
      [
        "gpt-5.6-luna",
        "gpt-image-2",
        "text-embedding-3-small",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ]
    );
    assert_eq!(
      openai
        .models
        .iter()
        .filter(|model| model.recommended)
        .map(|model| model.model_id.as_str())
        .collect::<Vec<_>>(),
      ["gpt-5.6-luna", "gpt-image-2", "text-embedding-3-small"]
    );
  }
}
