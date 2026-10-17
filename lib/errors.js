/** 0.15.0 统一错误码：所有失败都带一个可展示的中文原因。 */
export const ERROR_CODES = Object.freeze({
  EMPTY_INPUT: "empty_input",
  INPUT_TOO_LONG: "input_too_long",
  NOTHING_TO_OPTIMIZE: "nothing_to_optimize",
  LLM_UNAVAILABLE: "llm_unavailable",
  MODEL_UNAVAILABLE: "model_unavailable",
  LLM_ERROR: "llm_error",
  EMPTY_RESULT: "empty_result",
  TRUNCATED: "truncated",
  VALIDATION_FAILED: "validation_failed",
  REQUEST_TIMEOUT: "request_timeout",
  PAYLOAD_TOO_LARGE: "payload_too_large",
});

export const ERROR_MESSAGES = Object.freeze({
  empty_input: "请先输入内容",
  input_too_long: "内容过长，请精简后再优化",
  nothing_to_optimize: "这条消息不需要优化",
  llm_unavailable: "模型服务不可用",
  model_unavailable: "未找到可用的默认模型",
  llm_error: "模型调用失败",
  empty_result: "模型没有返回有效内容",
  truncated: "结果被截断，请再试一次",
  validation_failed: "结果未通过校验，已保留原文",
  request_timeout: "优化超时，已保留原文",
  payload_too_large: "请求体过大，请精简后再优化",
});
