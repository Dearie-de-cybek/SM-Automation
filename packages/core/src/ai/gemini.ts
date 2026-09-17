// Gemini REST client (generateContent + batchEmbedContents).
// Wire details that matter: header `x-goog-api-key`, camelCase body,
// `generationConfig.responseMimeType='application/json'` + `responseJsonSchema`,
// thinking config differs per model family (sending the wrong one is a 400),
// and promptFeedback.blockReason / finishReason must be handled before parsing.

import type { AiEnv } from '../env';
import type { HttpClient } from '../providers/http';
import type { EmbedTask, LlmClient, LlmJsonRequest, LlmJsonResult } from './types';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** batchEmbedContents rejects more than 100 requests per call. */
export const GEMINI_EMBED_BATCH_SIZE = 100;

export interface GeminiClientOptions {
  http?: HttpClient;
  timeoutMs?: number;
  /** Overrides AI_EMBEDDING_MODEL output width (default 768). */
  embeddingDimensions?: number;
}

export type GeminiEnv = Pick<
  AiEnv,
  'GEMINI_API_KEY' | 'AI_MODEL_FAST' | 'AI_MODEL_DEFAULT' | 'AI_MODEL_PREMIUM' | 'AI_EMBEDDING_MODEL'
>;

export type ThinkingConfig = { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' } | { thinkingBudget: number } | undefined;

const ni = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/**
 * Thinking parameters accepted by a given model id.
 * 3.8/3.7 Flash reject `minimal`; 2.5 models reject `thinkingLevel` entirely.
 */
export function thinkingFor(_model: string): ThinkingConfig {
  return ni('gemini.thinkingFor');
}

export function createGeminiClient(_env: GeminiEnv, _options?: GeminiClientOptions): LlmClient {
  return {
    generateJson<T>(_request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
      return ni('gemini.generateJson');
    },
    embed(_texts: string[], _task: EmbedTask): Promise<number[][]> {
      return ni('gemini.embed');
    },
  };
}
