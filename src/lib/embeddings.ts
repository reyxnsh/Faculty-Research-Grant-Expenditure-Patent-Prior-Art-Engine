import { pipeline, env } from '@huggingface/transformers';
import path from 'path';

// Pinned model and vector specifications
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

// Single constant for pipeline and inference configuration ensuring consistency between stored and query vectors
export const EMBEDDING_CONFIG = {
  model: EMBEDDING_MODEL,
  cacheDir: path.resolve(process.cwd(), '.cache/transformers'),
  inferenceOptions: {
    pooling: 'mean' as const,
    normalize: true,
    truncation: true,
    max_length: 256,
  },
} as const;

// Configure Hugging Face environment cache
env.cacheDir = EMBEDDING_CONFIG.cacheDir;

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

let pipelineInstance: FeatureExtractionPipeline | null = null;
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Returns or initializes the singleton feature-extraction pipeline.
 * Tries native onnxruntime execution, falling back to CPU execution if native bindings encounter constraints.
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
      pipelineInstance = await pipeline('feature-extraction', EMBEDDING_CONFIG.model);
      return pipelineInstance;
    } catch (primaryErr) {
      console.warn(
        'Primary embedding backend failed, attempting CPU fallback:',
        primaryErr instanceof Error ? primaryErr.message : primaryErr
      );
      try {
        pipelineInstance = await pipeline('feature-extraction', EMBEDDING_CONFIG.model, {
          device: 'cpu',
        });
        return pipelineInstance;
      } catch (fallbackErr) {
        pipelinePromise = null;
        throw new Error(
          `Failed to initialize embedding pipeline with both native and CPU backends: ${
            fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
          }`
        );
      }
    }
  })();

  return pipelinePromise;
}

/**
 * Generates a 384-dimensional normalized embedding for input text.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, EMBEDDING_CONFIG.inferenceOptions);
  return Array.from(output.data as Float32Array);
}

/**
 * Formats a numeric array into pgvector literal format: '[0.1,0.2,...]'.
 */
export function formatPgVector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
