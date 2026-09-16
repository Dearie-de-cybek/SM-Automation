const e = $input.first().json;
const lines = [
  '🔥 n8n workflow error',
  `Workflow: ${e.workflow?.name ?? 'unknown'}`,
  e.execution?.lastNodeExecuted && `Node: ${e.execution.lastNodeExecuted}`,
  `Error: ${e.execution?.error?.message ?? e.trigger?.error?.message ?? 'unknown'}`,
  e.execution?.url && `Execution: ${e.execution.url}`,
].filter(Boolean);
return [{ json: { text: lines.join('\n').slice(0, 4000) } }];
