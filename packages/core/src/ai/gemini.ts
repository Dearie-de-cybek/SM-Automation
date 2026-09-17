// Gemini REST client (generateContent + batchEmbedContents).
// Wire details that matter: header `x-goog-api-key`, camelCase body,
// `generationConfig.responseMimeType='application/json'` + `responseJsonSchema`,
// thinking config differs per model family (sending the wrong one is a 400),
// and promptFeedback.blockReason / finishReason must be handled before parsing.

import type { AiEnv } from '../env';
import { ProviderError } from '../providers/errors';
import { createHttpClient, type HttpClient } from '../providers/http';
import {
  EMBEDDING_DIMENSIONS,
  LlmError,
  type EmbedTask,
  type LlmClient,
  type LlmImage,
  type LlmJsonRequest,
  type LlmJsonResult,
} from './types';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** batchEmbedContents rejects more than 100 requests per call. */
export const GEMINI_EMBED_BATCH_SIZE = 100;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Thinking tokens count against maxOutputTokens, so the retry budget has room to grow. */
const MAX_OUTPUT_TOKENS_CEILING = 32_768;
const MAX_HTTP_ATTEMPTS = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

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

/** The prompt or the answer tripped a safety/content filter. Never retryable. */
export class LlmBlockedError extends LlmError {
  readonly blockReason: string;
  constructor(message: string, blockReason: string, options: { status?: number | null; cause?: unknown } = {}) {
    super(message, { retryable: false, status: options.status ?? null, cause: options.cause });
    this.name = 'LlmBlockedError';
    this.blockReason = blockReason;
  }
}

/** finishReason MAX_TOKENS: the answer is truncated, so the JSON is unusable. */
export class LlmTruncatedError extends LlmError {
  readonly maxOutputTokens: number;
  constructor(message: string, maxOutputTokens: number) {
    super(message, { retryable: false });
    this.name = 'LlmTruncatedError';
    this.maxOutputTokens = maxOutputTokens;
  }
}

/** The model answered, but not with JSON matching the schema (after the repair round). */
export class LlmInvalidJsonError extends LlmError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { retryable: false, cause: options.cause });
    this.name = 'LlmInvalidJsonError';
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
    finishMessage?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

interface GeminiEmbedResponse {
  embeddings?: { values?: number[] }[];
}

/** finishReason values that mean "the model refused or was cut off by a filter". */
const CONTENT_BLOCK_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'OTHER',
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thinking parameters accepted by a given model id.
 * 3.8/3.7 Flash reject `minimal`; 2.5 models reject `thinkingLevel` entirely.
 * Order matters: `flash-lite` is checked before the generic 3.5/3.6 Flash rule.
 */
export function thinkingFor(model: string): ThinkingConfig {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/.test(model)) return undefined;
  if (/^gemini-3\.(8|7)-flash/.test(model)) return { thinkingLevel: 'low' };
  if (/flash-lite/.test(model)) return { thinkingLevel: 'minimal' };
  if (/^gemini-3\.[56]-flash/.test(model)) return { thinkingLevel: 'low' };
  if (/pro/.test(model)) return { thinkingLevel: 'low' };
  return undefined;
}

interface HttpErrorInfo {
  status: number | null;
  retryAfterSec: number | null;
  retryable: boolean;
}

function httpErrorInfo(error: unknown): HttpErrorInfo {
  if (error instanceof ProviderError) {
    const status = error.status;
    const retryable =
      status === null ? error.safeToRetry : status === 408 || status === 429 || status >= 500;
    return { status, retryAfterSec: error.retryAfterSec, retryable };
  }
  return { status: null, retryAfterSec: null, retryable: false };
}

function toLlmError(error: unknown, info: HttpErrorInfo, label: string): LlmError {
  if (error instanceof LlmError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`${label}: ${message}`, { retryable: info.retryable, status: info.status, cause: error });
}

/** L2 normalization: cosine similarity then reduces to a dot product. */
export function normalizeVector(values: number[]): number[] {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return values.slice();
  return values.map((value) => value / norm);
}

/**
 * gemini-embedding-2 has no `taskType`: the task goes into the text itself.
 * Documents already shaped as `title: … | text: …` are passed through untouched.
 */
export function formatEmbeddingInput(model: string, text: string, task: EmbedTask): string {
  if (!/^gemini-embedding-2/.test(model)) return text;
  if (task === 'RETRIEVAL_QUERY') return `task: search result | query: ${text}`;
  return /^title:\s/.test(text) ? text : `title: none | text: ${text}`;
}

export function createGeminiClient(env: GeminiEnv, options: GeminiClientOptions = {}): LlmClient {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new LlmError('GEMINI_API_KEY is not configured');

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const http = options.http ?? createHttpClient({ timeoutMs, userAgent: 'sm-automation/1.0' });
  const dimensions = options.embeddingDimensions ?? EMBEDDING_DIMENSIONS;
  const embeddingModel = env.AI_EMBEDDING_MODEL;
  // Flipped once if the deprecated top-level `outputDimensionality` stops being honored.
  let useEmbedContentConfig = false;

  async function post<T>(path: string, body: unknown, label: string): Promise<T> {
    let delay = INITIAL_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await http.json<T>(`${GEMINI_BASE_URL}${path}`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey as string },
          json: body,
          timeoutMs,
          label,
        });
      } catch (error: unknown) {
        const info = httpErrorInfo(error);
        // These calls have no side effects, so any transient failure may be repeated.
        if (!info.retryable || attempt >= MAX_HTTP_ATTEMPTS) throw toLlmError(error, info, label);
        const wait =
          info.retryAfterSec !== null ? info.retryAfterSec * 1000 : delay * (1 + Math.random() * 0.25);
        await sleep(Math.min(wait, MAX_BACKOFF_MS));
        delay *= 2;
      }
    }
  }

  function buildParts(prompt: string, images: LlmImage[] | undefined): GeminiPart[] {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of images ?? []) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } });
    }
    return parts;
  }

  interface RawAnswer {
    text: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number };
  }

  async function callModel(
    model: string,
    system: string,
    parts: GeminiPart[],
    jsonSchema: object,
    maxOutputTokens: number,
    temperature: number | undefined,
  ): Promise<RawAnswer> {
    const thinking = thinkingFor(model);
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: jsonSchema,
        maxOutputTokens,
        ...(temperature === undefined ? {} : { temperature }),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };

    const response = await post<GeminiResponse>(
      `/models/${encodeURIComponent(model)}:generateContent`,
      body,
      `gemini generateContent (${model})`,
    );

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new LlmBlockedError(`Gemini blocked the prompt (${blockReason})`, blockReason);
    }
    const candidate = response.candidates?.[0];
    if (!candidate) throw new LlmBlockedError('Gemini returned no candidates', 'NO_CANDIDATES');

    const finishReason = candidate.finishReason ?? 'STOP';
    if (finishReason === 'MAX_TOKENS') {
      throw new LlmTruncatedError(`Gemini hit maxOutputTokens (${maxOutputTokens})`, maxOutputTokens);
    }
    if (finishReason !== 'STOP' && CONTENT_BLOCK_REASONS.has(finishReason)) {
      throw new LlmBlockedError(`Gemini stopped with ${finishReason}`, finishReason);
    }

    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');

    const usage = response.usageMetadata ?? {};
    return {
      text,
      model: response.modelVersion ?? model,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      },
    };
  }

  async function embedBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
    const build = (): unknown => ({
      requests: texts.map((text) => {
        const content = { parts: [{ text: formatEmbeddingInput(embeddingModel, text, task) }] };
        // gemini-embedding-2 rejects taskType; older models still use it.
        const taskField = /^gemini-embedding-2/.test(embeddingModel) ? {} : { taskType: task };
        return useEmbedContentConfig
          ? {
              model: `models/${embeddingModel}`,
              content,
              embedContentConfig: { outputDimensionality: dimensions, ...taskField },
            }
          : { model: `models/${embeddingModel}`, content, outputDimensionality: dimensions, ...taskField };
      }),
    });

    const run = async (): Promise<number[][]> => {
      const response = await post<GeminiEmbedResponse>(
        `/models/${encodeURIComponent(embeddingModel)}:batchEmbedContents`,
        build(),
        `gemini batchEmbedContents (${embeddingModel})`,
      );
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        throw new LlmError(`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs`);
      }
      return embeddings.map((entry) => {
        const values = entry.values ?? [];
        if (values.length !== dimensions) {
          throw new LlmError(`Gemini returned ${values.length} dimensions, expected ${dimensions}`);
        }
        return normalizeVector(values);
      });
    };

    try {
      return await run();
    } catch (error: unknown) {
      // The top-level `outputDimensionality` field is deprecated: fall back to the
      // nested config form once, then keep using it for the rest of the process.
      if (!useEmbedContentConfig && error instanceof LlmError && /dimensions/.test(error.message)) {
        useEmbedContentConfig = true;
        return run();
      }
      throw error;
    }
  }

  // `embeddingModel` is not part of LlmClient, but knowledge ingestion stores it
  // alongside every vector: embedding spaces are incompatible between models.
  const client: LlmClient & { embeddingModel: string } = {
    embeddingModel,

    async generateJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
      const model = request.model?.trim() || env.AI_MODEL_DEFAULT;
      const parts = buildParts(request.prompt, request.images);
      let budget = Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING);

      let answer: RawAnswer;
      try {
        answer = await callModel(model, request.system, parts, request.jsonSchema, budget, request.temperature);
      } catch (error: unknown) {
        if (!(error instanceof LlmTruncatedError) || budget >= MAX_OUTPUT_TOKENS_CEILING) throw error;
        budget = Math.min(budget * 2, MAX_OUTPUT_TOKENS_CEILING);
        answer = await callModel(model, request.system, parts, request.jsonSchema, budget, request.temperature);
      }

      const first = validate(request, answer.text);
      if (first.ok) return { data: first.data, model: answer.model, usage: answer.usage };

      // One repair round: hand the model its own output plus the validation error.
      const repairParts: GeminiPart[] = [
        ...parts,
        {
          text:
            `Your previous answer was rejected. It must be a single JSON object matching the schema.\n` +
            `Previous answer:\n${answer.text.slice(0, 4000)}\n\n` +
            `Validation error: ${first.error}\n\n` +
            `Return the corrected JSON object only.`,
        },
      ];
      const repaired = await callModel(model, request.system, repairParts, request.jsonSchema, budget, request.temperature);
      const second = validate(request, repaired.text);
      if (!second.ok) {
        throw new LlmInvalidJsonError(`Gemini (${model}) returned invalid JSON after one repair: ${second.error}`);
      }
      return {
        data: second.data,
        model: repaired.model,
        usage: {
          inputTokens: answer.usage.inputTokens + repaired.usage.inputTokens,
          outputTokens: answer.usage.outputTokens + repaired.usage.outputTokens,
        },
      };
    },

    async embed(texts: string[], task: EmbedTask): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let index = 0; index < texts.length; index += GEMINI_EMBED_BATCH_SIZE) {
        out.push(...(await embedBatch(texts.slice(index, index + GEMINI_EMBED_BATCH_SIZE), task)));
      }
      return out;
    },
  };

  return client;
}

type Validation<T> = { ok: true; data: T } | { ok: false; error: string };

/** Structured output guarantees syntactically valid JSON, not correct values. */
function validate<T>(request: LlmJsonRequest<T>, text: string): Validation<T> {
  const trimmed = stripCodeFence(text.trim());
  if (trimmed === '') return { ok: false, error: 'empty response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'not valid JSON' };
  }
  const result = request.zod.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
  };
}

/** Models occasionally wrap JSON in a markdown fence despite responseMimeType. */
function stripCodeFence(text: string): string {
  if (!text.startsWith('```')) return text;
  const withoutOpen = text.replace(/^```[a-zA-Z]*\s*\n?/, '');
  const close = withoutOpen.lastIndexOf('```');
  return (close === -1 ? withoutOpen : withoutOpen.slice(0, close)).trim();
}
