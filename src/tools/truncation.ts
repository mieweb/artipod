/** Cap tool output to protect the model's context window (head + tail). */
export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;

export function truncateOutput(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  if (text.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n…[${omitted} characters truncated]…\n${text.slice(-half)}`;
}
