use llm_adapter::backend::{
  BackendError, BackendHttpClient, DefaultHttpClient, HttpBody, HttpRequest, HttpResponse, HttpUploadRequest,
};
use serde_json::Value;

/// Responses attempts to make function schemas strict when `strict` is absent.
/// Our schemas intentionally contain optional properties, so opt out at the
/// final HTTP boundary until the adapter models this protocol field.
/// https://developers.openai.com/api/docs/guides/function-calling#strict-mode
pub(crate) struct ToolSchemaHttpClient<C = DefaultHttpClient> {
  inner: C,
}

impl Default for ToolSchemaHttpClient {
  fn default() -> Self {
    Self {
      inner: DefaultHttpClient::default(),
    }
  }
}

fn disable_implicit_responses_strict_mode(request: &mut HttpRequest) {
  let HttpBody::Json(body) = &mut request.body else {
    return;
  };
  let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
    return;
  };

  for tool in tools {
    let Some(tool) = tool.as_object_mut() else {
      continue;
    };
    // Responses function definitions are flat. This excludes Chat
    // Completions, Anthropic and Gemini payloads by construction.
    if tool.get("type").and_then(Value::as_str) == Some("function")
      && tool.get("name").and_then(Value::as_str).is_some()
      && tool.get("parameters").is_some()
    {
      tool.entry("strict").or_insert(Value::Bool(false));
    }
  }
}

impl<C: BackendHttpClient> BackendHttpClient for ToolSchemaHttpClient<C> {
  fn post_json(&self, mut request: HttpRequest) -> Result<HttpResponse, BackendError> {
    disable_implicit_responses_strict_mode(&mut request);
    self.inner.post_json(request)
  }

  fn put_bytes(&self, request: HttpUploadRequest) -> Result<(), BackendError> {
    self.inner.put_bytes(request)
  }

  fn post_sse(
    &self,
    mut request: HttpRequest,
    on_chunk: &mut dyn FnMut(&str) -> Result<(), BackendError>,
  ) -> Result<(), BackendError> {
    disable_implicit_responses_strict_mode(&mut request);
    self.inner.post_sse(request, on_chunk)
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use llm_adapter::{
    backend::{BackendError, BackendHttpClient, HttpBody, HttpRequest, HttpResponse},
    target::EgressPolicy,
  };
  use serde_json::json;

  use super::ToolSchemaHttpClient;
  use super::disable_implicit_responses_strict_mode;

  fn request(body: serde_json::Value) -> HttpRequest {
    HttpRequest {
      url: "https://api.openai.com/v1/responses".to_string(),
      headers: Vec::new(),
      body: HttpBody::Json(body),
      timeout_ms: None,
      egress_policy: EgressPolicy::PublicOnly,
    }
  }

  #[test]
  fn explicitly_disables_responses_implicit_tool_strictness() {
    let mut request = request(json!({
      "tools": [{
        "type": "function",
        "name": "canvas_read",
        "parameters": {
          "type": "object",
          "properties": { "cursor": { "type": "string" } },
          "required": []
        }
      }]
    }));

    disable_implicit_responses_strict_mode(&mut request);

    assert_eq!(request.body["tools"][0]["strict"], json!(false));
    assert_eq!(request.body["tools"][0]["parameters"]["required"], json!([]));
  }

  #[test]
  fn leaves_other_provider_tool_shapes_unchanged() {
    let body = json!({
      "tools": [
        { "type": "function", "function": { "name": "chat_tool", "parameters": {} } },
        { "name": "anthropic_tool", "input_schema": {} },
        { "functionDeclarations": [{ "name": "gemini_tool", "parameters": {} }] }
      ]
    });
    let mut request = request(body.clone());

    disable_implicit_responses_strict_mode(&mut request);

    assert_eq!(request.body.as_json(), Some(&body));
  }

  #[derive(Default)]
  struct CapturingClient {
    requests: Mutex<Vec<HttpRequest>>,
  }

  impl BackendHttpClient for CapturingClient {
    fn post_json(&self, request: HttpRequest) -> Result<HttpResponse, BackendError> {
      self.requests.lock().unwrap().push(request);
      Ok(HttpResponse {
        status: 200,
        body: json!({}),
      })
    }

    fn post_sse(
      &self,
      request: HttpRequest,
      _on_chunk: &mut dyn FnMut(&str) -> Result<(), BackendError>,
    ) -> Result<(), BackendError> {
      self.requests.lock().unwrap().push(request);
      Ok(())
    }
  }

  #[test]
  fn rewrites_both_final_http_dispatch_paths_and_preserves_explicit_values() {
    let client = ToolSchemaHttpClient {
      inner: CapturingClient::default(),
    };
    let body = json!({
      "tools": [
        { "type": "function", "name": "implicit", "parameters": {} },
        { "type": "function", "name": "strict", "parameters": {}, "strict": true },
        { "type": "function", "name": "loose", "parameters": {}, "strict": false }
      ]
    });

    client.post_json(request(body.clone())).unwrap();
    client.post_sse(request(body), &mut |_| Ok(())).unwrap();

    let requests = client.inner.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
      let body = &request.body;
      assert_eq!(body["tools"][0]["strict"], json!(false));
      assert_eq!(body["tools"][1]["strict"], json!(true));
      assert_eq!(body["tools"][2]["strict"], json!(false));
    }
  }

  #[test]
  fn actual_responses_encoder_keeps_optional_canvas_fields_at_final_http_boundary() {
    let parameters = json!({
      "type": "object",
      "properties": {
        "scope": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}}}},
        "cursor": {"type": "string"}
      },
      "required": ["scope"]
    });
    let canonical: llm_adapter::core::CoreRequest = serde_json::from_value(json!({
      "model": "test-model",
      "tools": [{"name": "canvas_read", "parameters": parameters}]
    }))
    .unwrap();
    let client = ToolSchemaHttpClient {
      inner: CapturingClient::default(),
    };
    for streaming in [false, true] {
      let body = llm_adapter::protocol::openai::responses::request::encode(&canonical, streaming);
      let mut outgoing = request(body);
      outgoing
        .headers
        .push(("Authorization".to_string(), "Bearer unit-test".to_string()));
      outgoing.timeout_ms = Some(45000);
      if streaming {
        client.post_sse(outgoing, &mut |_| Ok(())).unwrap();
      } else {
        client.post_json(outgoing).unwrap();
      }
    }
    let requests = client.inner.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests.iter() {
      assert_eq!(request.url, "https://api.openai.com/v1/responses");
      assert_eq!(
        request.headers,
        vec![("Authorization".to_string(), "Bearer unit-test".to_string())]
      );
      assert_eq!(request.timeout_ms, Some(45000));
      assert_eq!(request.egress_policy, EgressPolicy::PublicOnly);
      assert_eq!(request.body["tools"][0]["strict"], json!(false));
      assert_eq!(request.body["tools"][0]["parameters"], parameters);
    }
  }
}
