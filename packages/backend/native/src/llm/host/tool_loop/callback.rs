use std::sync::{
  Arc, Mutex,
  atomic::{AtomicBool, Ordering},
  mpsc::{self, SyncSender},
};

use llm_adapter::backend::BackendError;
use llm_runtime::{
  EventSink, ToolCallbackRequest as RuntimeToolCallbackRequest, ToolCallbackResponse as RuntimeToolCallbackResponse,
  ToolExecutionResult, ToolExecutor, ToolLoopEvent,
};
use napi::{
  Error, JsValue, Result, Status,
  bindgen_prelude::{CallbackContext, PromiseRaw, Unknown},
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use serde::Deserialize;
use serde_json::Value;

use super::contract::{NativeToolCall, ToolLoopStreamEvent};
use crate::llm::{backend_transport_error, host::callback_dispatch_failed_reason};

type ToolCallbackResult = std::result::Result<HostToolCallbackResponse, String>;
type ToolCallbackSender = SyncSender<ToolCallbackResult>;
type ToolCallbackSenderSlot = Arc<Mutex<Option<ToolCallbackSender>>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InlineImagePart {
  pub(super) mime_type: String,
  /// Base64 bytes only. The Node host removes the data URL prefix before this
  /// crosses the N-API callback boundary.
  pub(super) data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostToolCallbackResponse {
  call_id: String,
  name: String,
  args: Value,
  raw_arguments_text: Option<String>,
  argument_parse_error: Option<String>,
  output: Value,
  is_error: Option<bool>,
  media: Option<Vec<InlineImagePart>>,
}

impl HostToolCallbackResponse {
  fn into_runtime(self) -> RuntimeToolCallbackResponse {
    RuntimeToolCallbackResponse {
      call_id: self.call_id,
      name: self.name,
      args: self.args,
      raw_arguments_text: self.raw_arguments_text,
      argument_parse_error: self.argument_parse_error,
      output: self.output,
      is_error: self.is_error,
    }
  }
}

pub(super) struct ToolExecutionWithMedia {
  pub(super) result: ToolExecutionResult,
  pub(super) media: Vec<InlineImagePart>,
}

pub(super) struct NapiToolExecutor<'a> {
  callback: &'a ThreadsafeFunction<String, PromiseRaw<'static, String>>,
}

impl<'a> NapiToolExecutor<'a> {
  pub(super) fn new(callback: &'a ThreadsafeFunction<String, PromiseRaw<'static, String>>) -> Self {
    Self { callback }
  }
}

impl ToolExecutor<BackendError> for NapiToolExecutor<'_> {
  fn execute(&mut self, call: &NativeToolCall) -> std::result::Result<ToolExecutionResult, BackendError> {
    let result =
      execute_tool_callback(self.callback, call).map_err(|error| backend_transport_error(error.to_string()))?;
    let result = result.into_runtime();
    Ok(ToolExecutionResult {
      call_id: result.call_id,
      name: result.name,
      arguments: result.args,
      arguments_text: result.raw_arguments_text,
      arguments_error: result.argument_parse_error,
      output: result.output,
      is_error: result.is_error,
    })
  }
}

pub(super) fn execute_tool_callback_with_media(
  callback: &ThreadsafeFunction<String, PromiseRaw<'static, String>>,
  call: &NativeToolCall,
) -> Result<ToolExecutionWithMedia> {
  let response = execute_tool_callback(callback, call)?;
  let media = response.media.unwrap_or_default();
  let response = response.into_runtime();
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
    media,
  })
}

pub(super) struct NapiEventSink<'a> {
  callback: &'a ThreadsafeFunction<String, ()>,
  emitted: Option<&'a AtomicBool>,
}

impl<'a> NapiEventSink<'a> {
  pub(super) fn new_with_emitted(callback: &'a ThreadsafeFunction<String, ()>, emitted: &'a AtomicBool) -> Self {
    Self {
      callback,
      emitted: Some(emitted),
    }
  }
}

impl EventSink<BackendError> for NapiEventSink<'_> {
  fn emit(&mut self, event: &ToolLoopEvent) -> std::result::Result<(), BackendError> {
    if let Some(emitted) = self.emitted {
      emitted.store(true, Ordering::Relaxed);
    }
    emit_tool_loop_event(self.callback, event)
  }
}

pub(super) fn emit_tool_loop_event(
  callback: &ThreadsafeFunction<String, ()>,
  event: &ToolLoopStreamEvent,
) -> std::result::Result<(), BackendError> {
  let value = serde_json::to_string(event).unwrap_or_else(|error| {
    serde_json::json!({
      "type": "error",
      "message": format!("failed to serialize tool loop event: {error}"),
    })
    .to_string()
  });

  let status = callback.call(Ok(value), ThreadsafeFunctionCallMode::NonBlocking);
  if status != Status::Ok {
    return Err(backend_transport_error(callback_dispatch_failed_reason(status)));
  }

  Ok(())
}

pub(super) fn execute_tool_callback(
  callback: &ThreadsafeFunction<String, PromiseRaw<'static, String>>,
  call: &NativeToolCall,
) -> Result<HostToolCallbackResponse> {
  let request = RuntimeToolCallbackRequest {
    call_id: call.id.clone(),
    name: call.name.clone(),
    args: call.args.clone(),
    raw_arguments_text: call.raw_arguments_text.clone(),
    argument_parse_error: call.argument_parse_error.clone(),
  };
  let request = serde_json::to_string(&request).map_err(|error| Error::new(Status::InvalidArg, error.to_string()))?;
  let (sender, receiver) = mpsc::sync_channel::<ToolCallbackResult>(1);
  let sender = Arc::new(Mutex::new(Some(sender)));
  let sender_in_callback = sender.clone();
  let status = callback.call_with_return_value(
    Ok(request),
    ThreadsafeFunctionCallMode::NonBlocking,
    move |promise, _env| {
      match promise {
        Ok(promise) => {
          let sender_in_then = sender_in_callback.clone();
          let sender_in_catch = sender_in_callback.clone();
          promise
            .then(move |ctx| {
              let result = serde_json::from_str(&ctx.value).map_err(|error| error.to_string());
              send_tool_callback_result(&sender_in_then, result);
              Ok(())
            })?
            .catch(move |ctx: CallbackContext<Unknown>| {
              let message = ctx.value.coerce_to_string()?.into_utf8()?.as_str()?.to_string();
              send_tool_callback_result(&sender_in_catch, Err(message));
              Ok(())
            })?;
        }
        Err(error) => {
          send_tool_callback_result(&sender_in_callback, Err(error.to_string()));
        }
      }
      Ok(())
    },
  );

  if status != Status::Ok {
    return Err(Error::new(
      Status::GenericFailure,
      format!("native tool callback dispatch failed: {status}"),
    ));
  }

  let response_json = receiver.recv().map_err(|_| {
    Error::new(
      Status::GenericFailure,
      "native tool callback receiver closed before completion",
    )
  })?;

  let response = response_json.map_err(|message| Error::new(Status::GenericFailure, message))?;
  if !response.args.is_object() {
    return Err(Error::new(
      Status::InvalidArg,
      "Tool callback response args must be a JSON object",
    ));
  }
  Ok(response)
}

fn send_tool_callback_result(sender: &ToolCallbackSenderSlot, result: ToolCallbackResult) {
  if let Some(sender) = sender.lock().expect("tool callback sender poisoned").take() {
    let _ = sender.send(result);
  }
}
