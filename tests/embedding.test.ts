import { describe, it, expect, beforeAll } from 'vitest';
import { embed, EMBEDDING_CONFIG, getEmbeddingPipeline } from '@/lib/embeddings';
import { env, pipeline } from '@huggingface/transformers';

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return dotProduct;
}

describe('Embedding Engine (@huggingface/transformers)', () => {
  beforeAll(() => {
    const onnxVersion = env.backends.onnx?.versions?.node || 'native-onnx';
    const supportedDevices = env.backends.onnx?.getSupportedDevices
      ? env.backends.onnx.getSupportedDevices().join(', ')
      : 'cpu';
    console.log(
      `\n[EMBEDDING TEST ENVIRONMENT] Node: ${process.version} | ONNX Backend Version: ${onnxVersion} | Devices: ${supportedDevices}`
    );
  });

  it('generates a 384-dimensional vector with unit L2 norm', async () => {
    const text = 'Graph neural networks for drug discovery and molecular interaction modeling';
    const vector = await embed(text);

    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBe(384);

    for (const val of vector) {
      expect(typeof val).toBe('number');
      expect(Number.isFinite(val)).toBe(true);
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('produces deterministic output for identical input text', async () => {
    const text = 'Deterministic neural embedding generation verification';
    const vectorA = await embed(text);
    const vectorB = await embed(text);

    expect(vectorA).toEqual(vectorB);
  });

  it('ranks semantically similar sentences higher than unrelated sentences', async () => {
    const sentenceA = 'Convolutional neural networks for automated medical image diagnostics';
    const sentenceB = 'Deep learning models for radiologic scan classification';
    const unrelated = 'Ancient Roman architectural techniques and aqueduct construction materials';

    const vecA = await embed(sentenceA);
    const vecB = await embed(sentenceB);
    const vecUnrelated = await embed(unrelated);

    const simRelated = cosineSimilarity(vecA, vecB);
    const simUnrelated = cosineSimilarity(vecA, vecUnrelated);

    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.5);
    expect(simUnrelated).toBeLessThan(0.3);
  });

  it('verifies explicit 256-token truncation matches text cut to 256 tokens', async () => {
    const pipe = await getEmbeddingPipeline();
    const tokenizer = pipe.tokenizer;

    // Generate ~3000 words of technical text
    const words: string[] = [];
    for (let i = 0; i < 3000; i++) {
      words.push(`novelty${i % 250} patent${i % 17} method${i % 31} system${i % 7}`);
    }
    const longText = words.join(' ');

    // Cut text to exact 256 tokens using the tokenizer
    const tokenized256 = await tokenizer(longText, {
      truncation: true,
      max_length: EMBEDDING_CONFIG.maxTokens,
    });
    const cutText = tokenizer.decode(tokenized256.input_ids, {
      skip_special_tokens: true,
    });

    // Embed both through the same embed() function
    const vecLong = await embed(longText);
    const vecCut = await embed(cutText);

    const sim = cosineSimilarity(vecLong, vecCut);
    expect(sim).toBeGreaterThan(0.999);
  });

  it('loads successfully from local cache with remote model access disabled (offline mode)', async () => {
    // Disable remote model downloads to verify offline reproducibility
    env.allowRemoteModels = false;

    const offlinePipeline = await pipeline('feature-extraction', EMBEDDING_CONFIG.model);
    const output = await offlinePipeline(
      'Evaluating offline execution from local model cache',
      EMBEDDING_CONFIG.inferenceOptions
    );

    const dims = output.dims;
    expect(dims).toEqual([1, 384]);

    const vector = Array.from(output.data as Float32Array);
    expect(vector.length).toBe(384);

    // Re-enable remote models for any subsequent runs
    env.allowRemoteModels = true;
  });
});
