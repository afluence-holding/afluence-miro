use std::{
  cell::Cell,
  collections::HashMap,
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
  },
  time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use llm_adapter::{
  backend::BackendError,
  core::{CoreContent, CoreMessage, CoreRole},
  router::ExecutableRequest,
};
use llm_runtime::{
  AccumulatedToolCall, RuntimeRouteEvent, ToolCallbackRequest, ToolExecutionResult, ToolLoopEvent, ToolResultMessage,
  append_tool_turns, dispatch_compiled_round,
};
use napi::{
  JsValue, Result, Status,
  bindgen_prelude::{CallbackContext, PromiseRaw, Unknown},
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use serde::Deserialize;
use serde_json::Value;
use zeroize::Zeroizing;

use super::{BackendRuntime, COPILOT_REQUEST_TIMEOUT, RuntimeError, dispatch, to_napi_error};
use crate::{
  llm::{
    CopilotExecuteInput,
    http_client::ToolSchemaHttpClient,
    route::{AuthorizedProviderProfile, AuthorizedTargetRef, CatalogSlot},
  },
  runtime::BackendRuntimeConfig,
};

pub(super) type PreparedCopilotExecution = (
  Arc<BackendRuntimeConfig>,
  CatalogSlot,
  ExecutableRequest,
  Vec<AuthorizedProviderProfile>,
  Vec<AuthorizedTargetRef>,
  HashMap<String, Zeroizing<String>>,
);

const STREAM_END: &str = "__AFFINE_COPILOT_STREAM_END__";
const TOOL_CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const TOOL_CALLBACK_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_INLINE_TOOL_IMAGE_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InlineImagePart {
  mime_type: String,
  data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostToolCallbackResponse {
  call_id: String,
  name: String,
  args: Value,
  raw_arguments_text: Option<String>,
  argument_parse_error: Option<String>,
  output: Value,
  is_error: Option<bool>,
  media: Option<Vec<InlineImagePart>>,
}

struct ToolExecutionWithMedia {
  result: ToolExecutionResult,
  media: Vec<InlineImagePart>,
}

#[napi_derive::napi]
pub struct CopilotStreamHandle {
  aborted: Arc<AtomicBool>,
}

#[napi_derive::napi]
impl CopilotStreamHandle {
  #[napi]
  pub fn abort(&self) {
    self.aborted.store(true, Ordering::Relaxed);
  }
}

#[napi_derive::napi]
impl BackendRuntime {
  #[napi]
  pub async fn execute_copilot_stream(
    &self,
    input: CopilotExecuteInput,
    max_steps: u32,
    callback: ThreadsafeFunction<String, ()>,
    tool_callback: ThreadsafeFunction<String, PromiseRaw<'static, String>>,
  ) -> Result<CopilotStreamHandle> {
    let (config, slot, request, profiles, candidates, managed_credentials) =
      self.prepare_copilot(input).await.map_err(to_napi_error)?;
    let messages = match &request {
      ExecutableRequest::Chat(request) => request.messages.clone(),
      _ => {
        return Err(to_napi_error(RuntimeError::invalid_input(
          "copilot stream requires a chat slot",
        )));
      }
    };
    let mut execution =
      dispatch::compile_execution(&config, slot, request, &profiles, &candidates, &managed_credentials)
        .map_err(to_napi_error)?;
    let aborted = Arc::new(AtomicBool::new(false));
    let worker_aborted = aborted.clone();
    tokio::task::spawn_blocking(move || {
      let deadline = Instant::now() + COPILOT_REQUEST_TIMEOUT;
      let result = run_stream(
        &mut execution,
        messages,
        max_steps.max(1) as usize,
        &callback,
        &tool_callback,
        &worker_aborted,
        deadline,
      );
      if let Err(message) = result
        && !worker_aborted.load(Ordering::Relaxed)
      {
        let _ = emit_json(
          &callback,
          &serde_json::json!({
            "type": "error",
            "errorKind": "dispatch",
            "message": message,
          }),
        );
      }
      let _ = callback.call(Ok(STREAM_END.to_string()), ThreadsafeFunctionCallMode::Blocking);
    });
    Ok(CopilotStreamHandle { aborted })
  }
}

fn run_stream(
  execution: &mut dispatch::CompiledExecution,
  mut messages: Vec<CoreMessage>,
  max_steps: usize,
  callback: &ThreadsafeFunction<String, ()>,
  tool_callback: &ThreadsafeFunction<String, PromiseRaw<'static, String>>,
  aborted: &AtomicBool,
  deadline: Instant,
) -> std::result::Result<(), String> {
  // `llm_runtime::run_tool_loop` deliberately only knows JSON tool results.
  // This host loop additionally keeps bounded image parts beside the result
  // until the provider selected for this exact round is known.
  let selected_route_supports_vision = Cell::new(false);
  for step in 0..max_steps {
    let outcome = {
      selected_route_supports_vision.set(false);
      let mut route_events = Vec::new();
      let result = dispatch_compiled_round(
        &ToolSchemaHttpClient::default(),
        &mut execution.plan,
        &messages,
        || aborted.load(Ordering::Relaxed) || Instant::now() >= deadline,
        |event| emit_json(callback, event).map_err(transport_error),
        |event: RuntimeRouteEvent| route_events.push(event),
      );
      for event in route_events {
        if let RuntimeRouteEvent::Selected { route_id } = &event {
          selected_route_supports_vision.set(execution.supports_vision(route_id));
        }
        let event = execution.project(event).map_err(|error| error.to_string())?;
        emit_json(callback, &event)?;
      }
      result.map_err(|error| error.to_string())?
    };
    if outcome.tool_calls.is_empty() {
      if let Some(done) = outcome.final_done {
        emit_json(callback, &done)?;
      }
      break;
    }
    if step == max_steps - 1 {
      return Err("tool loop reached max steps".to_string());
    }

    let mut replay_results = Vec::with_capacity(outcome.tool_calls.len());
    let mut images = Vec::new();
    for call in &outcome.tool_calls {
      let mut execution_result = execute_tool(tool_callback, call, aborted, deadline)?;
      let delivered = append_inline_images_for_selected_route(
        &mut images,
        selected_route_supports_vision.get(),
        &execution_result.media,
      )?;
      set_visual_delivery_marker(&mut execution_result.result.output, delivered);
      let result = execution_result.result;
      emit_json(
        callback,
        &ToolLoopEvent::ToolResult {
          call_id: result.call_id.clone(),
          name: result.name.clone(),
          arguments: result.arguments.clone(),
          arguments_text: result.arguments_text.clone(),
          arguments_error: result.arguments_error.clone(),
          output: result.output.clone(),
          is_error: result.is_error,
        },
      )?;
      replay_results.push(ToolResultMessage {
        call_id: result.call_id,
        output: result.output,
        is_error: result.is_error,
      });
    }
    append_tool_turns(&mut messages, &outcome.tool_calls, &replay_results);
    messages.append(&mut images);
  }
  if !aborted.load(Ordering::Relaxed) && Instant::now() >= deadline {
    Err("copilot stream deadline exceeded".to_string())
  } else {
    Ok(())
  }
}

fn emit_json(
  callback: &ThreadsafeFunction<String, ()>,
  value: &impl serde::Serialize,
) -> std::result::Result<(), String> {
  let value = serde_json::to_string(value).map_err(|error| error.to_string())?;
  let status = callback.call(Ok(value), ThreadsafeFunctionCallMode::Blocking);
  if status == Status::Ok {
    Ok(())
  } else {
    Err(format!("copilot stream callback failed: {status}"))
  }
}

fn transport_error(message: String) -> BackendError {
  BackendError::Transport { message }
}

fn append_inline_images(images: &mut Vec<CoreMessage>, parts: &[InlineImagePart]) -> std::result::Result<bool, String> {
  if parts.is_empty() {
    return Ok(false);
  }
  for part in parts {
    if !matches!(part.mime_type.as_str(), "image/png" | "image/jpeg" | "image/webp") {
      return Err("unsupported inline tool image MIME type".to_string());
    }
    let bytes = STANDARD
      .decode(&part.data)
      .map_err(|_| "invalid inline tool image encoding".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_INLINE_TOOL_IMAGE_BYTES {
      return Err("inline tool image exceeds the size limit".to_string());
    }
    images.push(CoreMessage {
      role: CoreRole::User,
      content: vec![
        CoreContent::Text {
          text: "Image returned by canvas_render; inspect these pixels before making any visual claim.".to_string(),
        },
        CoreContent::Image {
          source: serde_json::json!({
            "kind": "data",
            "data": part.data,
            "mimeType": part.mime_type,
          }),
        },
      ],
    });
  }
  Ok(true)
}

fn append_inline_images_for_selected_route(
  images: &mut Vec<CoreMessage>,
  supports_vision: bool,
  parts: &[InlineImagePart],
) -> std::result::Result<bool, String> {
  if !supports_vision {
    return Ok(false);
  }
  append_inline_images(images, parts)
}

fn set_visual_delivery_marker(output: &mut Value, delivered: bool) {
  let Some(data) = output
    .as_object_mut()
    .filter(|output| output.get("ok") == Some(&Value::Bool(true)))
    .and_then(|output| output.get_mut("data"))
    .and_then(Value::as_object_mut)
  else {
    return;
  };
  if data.get("artifact").is_some() {
    data.insert("visualVerificationDeliveredToModel".to_string(), Value::Bool(delivered));
  }
}

fn execute_tool(
  callback: &ThreadsafeFunction<String, PromiseRaw<'static, String>>,
  call: &AccumulatedToolCall,
  aborted: &AtomicBool,
  stream_deadline: Instant,
) -> std::result::Result<ToolExecutionWithMedia, String> {
  let request = serde_json::to_string(&ToolCallbackRequest {
    call_id: call.id.clone(),
    name: call.name.clone(),
    args: call.args.clone(),
    raw_arguments_text: call.raw_arguments_text.clone(),
    argument_parse_error: call.argument_parse_error.clone(),
  })
  .map_err(|error| error.to_string())?;
  let (sender, receiver) = mpsc::sync_channel(1);
  let sender = Arc::new(Mutex::new(Some(sender)));
  let callback_sender = sender.clone();
  let status = callback.call_with_return_value(
    Ok(request),
    ThreadsafeFunctionCallMode::NonBlocking,
    move |promise, _env| {
      match promise {
        Ok(promise) => {
          let success_sender = callback_sender.clone();
          let failure_sender = callback_sender.clone();
          match promise.then(move |ctx| {
            send_tool_result(
              &success_sender,
              serde_json::from_str::<HostToolCallbackResponse>(&ctx.value).map_err(|error| error.to_string()),
            );
            Ok(())
          }) {
            Ok(promise) => {
              if let Err(error) = promise.catch(move |ctx: CallbackContext<Unknown>| {
                let message = ctx.value.coerce_to_string()?.into_utf8()?.as_str()?.to_string();
                send_tool_result(&failure_sender, Err(message));
                Ok(())
              }) {
                send_tool_result(&callback_sender, Err(error.to_string()));
              }
            }
            Err(error) => send_tool_result(&callback_sender, Err(error.to_string())),
          }
        }
        Err(error) => send_tool_result(&callback_sender, Err(error.to_string())),
      }
      Ok(())
    },
  );
  if status != Status::Ok {
    return Err(format!("copilot tool callback failed: {status}"));
  }
  let tool_deadline = std::cmp::min(stream_deadline, Instant::now() + TOOL_CALLBACK_TIMEOUT);
  let response = loop {
    if aborted.load(Ordering::Relaxed) {
      return Err("copilot stream aborted".to_string());
    }
    let now = Instant::now();
    if now >= tool_deadline {
      return Err("copilot tool callback deadline exceeded".to_string());
    }
    match receiver.recv_timeout(std::cmp::min(TOOL_CALLBACK_POLL_INTERVAL, tool_deadline - now)) {
      Ok(response) => break response?,
      Err(mpsc::RecvTimeoutError::Timeout) => continue,
      Err(mpsc::RecvTimeoutError::Disconnected) => {
        return Err("copilot tool callback closed before completion".to_string());
      }
    }
  };
  if !response.args.is_object() {
    return Err("copilot tool callback args must be an object".to_string());
  }
  Ok(ToolExecutionWithMedia {
    result: ToolExecutionResult {
      call_id: response.call_id,
      name: response.name,
      arguments: response.args,
      arguments_text: response.raw_arguments_text,
      arguments_error: response.argument_parse_error,
      output: response.output,
      is_error: response.is_error,
    },
    media: response.media.unwrap_or_default(),
  })
}

type ToolResultSender = Arc<Mutex<Option<mpsc::SyncSender<std::result::Result<HostToolCallbackResponse, String>>>>>;

fn send_tool_result(sender: &ToolResultSender, result: std::result::Result<HostToolCallbackResponse, String>) {
  if let Some(sender) = sender.lock().expect("tool callback sender poisoned").take() {
    let _ = sender.send(result);
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use base64::{Engine, engine::general_purpose::STANDARD};
  use llm_adapter::core::{CoreContent, CoreRole};
  use serde_json::json;

  use super::{
    HostToolCallbackResponse, InlineImagePart, append_inline_images_for_selected_route, set_visual_delivery_marker,
  };
  use crate::runtime::backend_runtime::copilot::dispatch::{
    capability_supports_inline_canvas_image, selected_route_supports_vision,
  };
  use llm_adapter::capability::{AttachmentKind, AttachmentSource, DeclaredModelCapability, ModelInput, ModelOutput};

  fn capability(sources: Vec<AttachmentSource>) -> DeclaredModelCapability {
    DeclaredModelCapability {
      input: vec![ModelInput::Text, ModelInput::Image],
      output: vec![ModelOutput::Text],
      features: vec![],
      attachment_kinds: vec![AttachmentKind::Image],
      attachment_sources: sources,
    }
  }

  #[test]
  fn canvas_media_requires_the_selected_model_to_accept_image_data() {
    assert!(!capability_supports_inline_canvas_image(&capability(vec![
      AttachmentSource::Url
    ])));
    assert!(!capability_supports_inline_canvas_image(&capability(vec![
      AttachmentSource::Bytes
    ])));
    assert!(capability_supports_inline_canvas_image(&capability(vec![
      AttachmentSource::Data
    ])));
  }

  #[test]
  fn selected_fallback_route_controls_canvas_media_delivery() {
    let routes = HashMap::from([("first".to_string(), false), ("fallback".to_string(), true)]);
    let image = InlineImagePart {
      mime_type: "image/png".to_string(),
      data: STANDARD.encode(b"canvas pixels"),
    };
    let mut messages = Vec::new();

    let first_delivered = append_inline_images_for_selected_route(
      &mut messages,
      selected_route_supports_vision(&routes, "first"),
      &[image],
    )
    .expect("a no-vision route must not parse or send media");
    assert!(!first_delivered);
    assert!(messages.is_empty());

    let fallback_delivered = append_inline_images_for_selected_route(
      &mut messages,
      selected_route_supports_vision(&routes, "fallback"),
      &[InlineImagePart {
        mime_type: "image/png".to_string(),
        data: STANDARD.encode(b"canvas pixels"),
      }],
    )
    .expect("the selected vision fallback accepts bounded image data");
    assert!(fallback_delivered);
    assert!(matches!(messages.as_slice(), [message]
      if message.role == CoreRole::User
        && matches!(message.content.as_slice(), [CoreContent::Text { .. }, CoreContent::Image { source }]
          if source["kind"] == "data" && source["mimeType"] == "image/png")));
  }

  #[test]
  fn visual_delivery_marker_is_only_true_after_a_native_image_part() {
    let mut output = json!({
      "ok": true,
      "data": { "artifact": { "mimeType": "image/png" } },
    });
    set_visual_delivery_marker(&mut output, false);
    assert_eq!(output["data"]["visualVerificationDeliveredToModel"], false);
    set_visual_delivery_marker(&mut output, true);
    assert_eq!(output["data"]["visualVerificationDeliveredToModel"], true);
  }

  #[test]
  fn host_tool_callback_accepts_direct_node_responses_and_rejects_wrappers() {
    let render: HostToolCallbackResponse = serde_json::from_value(json!({
      "callId": "call-render",
      "name": "canvas_render",
      "args": {},
      "output": { "ok": true },
      "media": [{ "mimeType": "image/png", "data": "cHJldmlldw==" }]
    }))
    .expect("Node tool callbacks must serialize fields at the native top level");
    assert_eq!(render.call_id, "call-render");
    assert_eq!(render.name, "canvas_render");
    assert_eq!(render.media.expect("render media")[0].mime_type, "image/png");

    let failure: HostToolCallbackResponse = serde_json::from_value(json!({
      "callId": "call-capabilities",
      "name": "canvas_capabilities",
      "args": {},
      "output": { "message": "editor unavailable" },
      "isError": true
    }))
    .expect("tool failures must use the same top-level callback contract");
    assert_eq!(failure.is_error, Some(true));

    let wrapped = serde_json::from_value::<HostToolCallbackResponse>(json!({
      "response": {
        "callId": "call-capabilities",
        "name": "canvas_capabilities",
        "args": {},
        "output": {}
      }
    }));
    assert!(wrapped.is_err());
  }
}
