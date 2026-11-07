import { pipeline, env } from '@huggingface/transformers';
import path from 'path';

// Model specifications and pipeline inference configuration
export const EMBEDDING_CONFIG = {
  model: 'Xenova/all-MiniLM-L6-v2',
  dimension: 384,
  maxTokens: 256,
  dtype: 'fp32' as const,
  cacheDir: path.resolve(process.cwd(), '.cache/transformers'),
  inferenceOptions: {
    pooling: 'mean' as const,
    normalize: true,
  },
} as const;

export const EMBEDDING_MODEL = EMBEDDING_CONFIG.model;
export const EMBEDDING_DIMENSION = EMBEDDING_CONFIG.dimension;

// Point Hugging Face environment cache to project local directory
env.cacheDir = EMBEDDING_CONFIG.cacheDir;

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

let pipelineInstance: FeatureExtractionPipeline | null = null;
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Returns or initializes the singleton feature-extraction pipeline.
 */
export async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelineInstance) {
    return pipelineInstance;
  }

  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    try {
      pipelineInstance = await pipeline('feature-extraction', EMBEDDING_CONFIG.model, {
        dtype: EMBEDDING_CONFIG.dtype,
      });
      return pipelineInstance;
    } catch (err) {
      pipelinePromise = null;
      throw new Error(
        `Failed to initialize embedding pipeline (${EMBEDDING_CONFIG.model}): ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  })();

  return pipelinePromise;
}

/**
 * Generates a 384-dimensional normalized embedding for input text.
 * Applies explicit 256-token truncation via the model tokenizer to ensure
 * consistency between stored disclosures and search queries.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();

  // Explicitly truncate input to maxTokens using the pipeline tokenizer
  const tokens = await pipe.tokenizer(text, {
    truncation: true,
    max_length: EMBEDDING_CONFIG.maxTokens,
  });
  const truncatedText = pipe.tokenizer.decode(tokens.input_ids, {
    skip_special_tokens: true,
  });

  const output = await pipe(truncatedText, EMBEDDING_CONFIG.inferenceOptions);
  return Array.from(output.data as Float32Array);
}

/**
 * Formats a numeric array into pgvector literal format: '[0.1,0.2,...]'.
 */
export function formatPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
