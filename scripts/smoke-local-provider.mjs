import { performance } from 'node:perf_hooks';
import { createOllamaProvider } from '../mcp/providers/ollama.mjs';

const selectedModel = 'qwen3.5:9b-hermes';
const prompt = 'HEARTH_LOCAL_PROVIDER_OK';
const provider = createOllamaProvider({ model: selectedModel, profile: 'light', timeoutMs: 30_000 });

const health = await provider.health();
console.log('health:', JSON.stringify(health));
if (!health.ok) {
  console.log('error:', JSON.stringify(health.error));
  process.exitCode = 1;
} else {
  const models = await provider.listModels();
  console.log('models:', JSON.stringify(models));
  if (!models.ok) {
    console.log('error:', JSON.stringify(models.error));
    process.exitCode = 1;
  } else if (!models.models.includes(selectedModel)) {
    const error = { code: 'MODEL_UNAVAILABLE', message: `${selectedModel} was not found in the local Ollama model list` };
    console.log('selected model:', selectedModel);
    console.log('error:', JSON.stringify(error));
    process.exitCode = 1;
  } else {
    console.log('selected model:', selectedModel);
    const startedAt = performance.now();
    const result = await provider.chat({
      model: selectedModel,
      messages: [{ role: 'user', content: prompt }],
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log('response:', JSON.stringify(result.ok ? result.response : null));
    console.log('elapsed_ms:', elapsedMs);
    if (!result.ok) {
      console.log('error:', JSON.stringify(result.error));
      process.exitCode = 1;
    } else {
      console.log('normalized result:', JSON.stringify(result));
    }
  }
}
