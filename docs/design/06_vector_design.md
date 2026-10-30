# Vector Database and Semantic Search Design

## 1. Database Paradigm Choice: PostgreSQL with pgvector

For the database requirement, we chose **Option 2** (Relational SQL + Vector Database). Rather than running a separate standalone vector database (such as Pinecone, Qdrant, or Chroma), we store and index vector embeddings directly inside **PostgreSQL 16 using the official `pgvector` extension** pinned to Docker image `pgvector/pgvector:0.8.0-pg16` (hosted on port 5433). The project uses the Node major version installed on the team machines (Node v26), pinned through `.nvmrc` and `package.json` engines (`>=22`).

We chose this setup for several reasons:

1. **Transactional Consistency (ACID)**: When an intellectual property disclosure is saved or updated, the relational fields (title, abstract, filing date), the author associations, the grant links, and the vector embedding are all committed together in one transaction. In contrast, using a separate vector database creates dual-write risks where a failure during save can leave the vector index out of sync with the relational database.
2. **Unified Relational and Vector Queries**: In a prior-art system, vector similarity search needs to work alongside relational metadata (such as filtering by department or funding grant, or returning author profiles). With `pgvector`, we can run a vector distance search and join with relational tables in a single SQL query.
3. **Operational Simplicity**: Storing vectors inside PostgreSQL means running a single Docker container on port 5433 instead of deploying, managing, and securing two different database services.
4. **Data Privacy**: Intellectual property disclosures and research drafts are sensitive. Using local embedding generation and local PostgreSQL storage ensures that drafts never leave the university's local environment.
5. **Unified Backups**: Standard database dumps (`pg_dump`) back up relational tables and vector embeddings simultaneously.

---

## 2. Text Representation & Embedding Pipeline

### 2.1 Standardized Text Format
To ensure that search queries and stored documents map into the same semantic space, we use the exact same text format for both:

`title || '. ' || abstract`

Example:
`Fault-Tolerant Quantum Key Distribution Protocol. We present a hardware-efficient protocol for quantum key distribution utilizing polar coding for channel reconciliation over optical fibers.`

We do not use prefixes like `Type:` because the embedding model was pre-trained on natural English sentences and paragraphs; adding artificial metadata prefixes shifts the embedding vector away from pure semantic content.

### 2.2 Embedding Model Selection & Configuration
- **Model**: `Xenova/all-MiniLM-L6-v2`
- **Package**: `@huggingface/transformers` (running locally in Node.js)
- **Pipeline Call Configuration**: The embedding pipeline is called with mean pooling and L2 normalization:
  ```javascript
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  ```
- **Embedding Dimensions**: **384 dimensions** (dense floating-point array).
- **Context Length & Truncation**:
  The `all-MiniLM-L6-v2` model supports up to 256 WordPiece tokens. Academic abstracts typically state their technical novelty, methodology, and problem statement within the first 150 to 200 words. When generating embeddings, text exceeding 256 tokens is safely truncated during tokenization using `truncation: true, max_length: 256`. The full text remains preserved in the relational `abstract` column for user inspection.
- **Local Model Caching for Offline Evaluation**:
  The model weights are downloaded once during initial setup and cached in a project-local directory (e.g. `.cache/transformers/`, excluded in `.gitignore`). This ensures that university demonstration sessions and test suites operate completely offline without external network dependencies.
- **Node.js Runtime & WASM Fallback**:
  The package's WebAssembly (WASM) fallback (`env.backends.onnx.wasm`) is to be verified in the Phase 1 smoke test if running on newer Node versions where native C++ bindings for `onnxruntime-node` are uncompiled.
- **Seed Embeddings**:
  Seed dataset embeddings are generated programmatically by a Node.js script in Phase 6 rather than hardcoded in raw SQL migration files.

---

## 3. Vector Storage & Mathematical Distance Metric

### 3.1 Data Type in PostgreSQL
Embeddings are stored in the `intellectual_property` table under:
```sql
embedding vector(384) NULL
```

### 3.2 Similarity Metric: Cosine Distance
For normalized semantic vectors, cosine similarity measures thematic closeness independent of text length:

`Cosine Similarity(u, v) = (u . v) / (||u|| * ||v||)`

In `pgvector`, the cosine distance operator is `<=>`:

`Cosine Distance(u, v) = 1 - Cosine Similarity(u, v)`

Because embeddings generated with `normalize: true` are unit length (`||u|| = 1`), cosine distance ranges between 0.0 (identical direction) and 2.0 (opposite direction). For display in the user interface, we convert distance into a similarity score:

`similarity_score = (1 - (embedding <=> query_vector))`

---

## 4. Index Architecture: HNSW

`pgvector` provides two approximate nearest neighbor (ANN) index types: IVFFlat and HNSW.

### 4.1 Why HNSW (Hierarchical Navigable Small World)
- **No Training Step Required**: IVFFlat requires training on an existing dataset before the index can be built, which performs poorly on small datasets. HNSW builds its multi-layer graph incrementally as rows are inserted.
- **Incremental Updates**: As new patents and papers are added, HNSW maintains search quality without needing index rebuilds.
- **Logarithmic Search Time**: HNSW traverses a multi-layer graph with logarithmic complexity, providing fast search times on large collections.

### 4.2 Index Definition & Runtime Tuning

```sql
CREATE INDEX idx_ip_embedding_hnsw 
ON intellectual_property 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

- `m = 16`: Number of bidirectional connections per graph node.
- `ef_construction = 64`: Size of the dynamic candidate list evaluated during index construction.
- **`hnsw.ef_search` Limit Behavior**: In PostgreSQL with `pgvector`, an HNSW index scan returns at most `hnsw.ef_search` candidates (which defaults to 40). `ef_search` must be greater than or equal to the inner `LIMIT` (the default is 40, so an inner `LIMIT` of 50 would silently return only 40 candidates). Because `SET LOCAL` only functions inside a transaction and parameterized database queries cannot combine multiple statements in one call, vector searches with custom `ef_search` are executed as separate calls on one connection:
  ```typescript
  await client.query('BEGIN');
  await client.query("SELECT set_config('hnsw.ef_search', '100', true)");
  const res = await client.query(searchQuery, [vector, dept, docType]);
  await client.query('COMMIT');
  ```
  In `pgvector` 0.8.0 or newer, iterative index scanning (`SET hnsw.iterative_scan = 'relaxed'`) is also available as an alternative to automatically continue scanning until the target `LIMIT` is satisfied.

*Testing Note on Query Planner*: On small seed or test datasets (such as fewer than a few hundred rows), PostgreSQL's cost-based query planner will typically choose a sequential scan over the HNSW index because reading a few disk pages sequentially has lower estimated cost than traversing index graphs. To verify that the HNSW index is active and working during testing, run `SET enable_seqscan = off;` before `EXPLAIN ANALYZE`.

---

## 5. Prior-Art Search Retrieval Workflow

To ensure that PostgreSQL uses the HNSW index effectively while allowing relational filtering, the search query is structured in three stages:
1. **Stage 1: Inner Vector Scan**: Scans only the `intellectual_property` table using `ORDER BY embedding <=> $1::vector LIMIT k`. Because this query involves only the indexed vector column and a `LIMIT`, the query planner can directly use the HNSW index.
2. **Stage 2: Middle Filter CTE with `EXISTS`**: Applies relational filters (e.g. target department or document type) against candidate document IDs using `EXISTS` without joining or multiplying rows.
3. **Stage 3: Outer Joins & Aggregation**: Joins only the filtered top-5 candidates with `ip_author`, `faculty`, `department`, `grant_ip`, and `grant_record`, aggregating all co-authors and funding grants into structured JSON without data truncation.

```sql
-- Executed inside a single-connection transaction after setting hnsw.ef_search:
-- BEGIN; SELECT set_config('hnsw.ef_search', '100', true); ...; COMMIT;

WITH nearest_candidates AS (
    -- Stage 1: Fast HNSW index scan returning candidate document IDs and distance
    SELECT 
        document_id,
        embedding <=> $1::vector AS cosine_dist
    FROM intellectual_property
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT 50
),
filtered_candidates AS (
    -- Stage 2: Middle CTE applying relational filters before expanding joins
    SELECT 
        nc.document_id,
        nc.cosine_dist
    FROM nearest_candidates nc
    JOIN intellectual_property ip ON nc.document_id = ip.document_id
    WHERE ($2::text IS NULL OR EXISTS (
        -- Optional filter: target department code ($2)
        SELECT 1 
        FROM ip_author ipa
        JOIN faculty f ON ipa.faculty_id = f.faculty_id
        JOIN department d ON f.department_id = d.department_id
        WHERE ipa.document_id = nc.document_id
          AND d.department_code = $2::text
    ))
    AND ($3::text IS NULL OR ip.doc_type = $3::text)
    ORDER BY nc.cosine_dist ASC
    LIMIT 5
)
-- Stage 3: Join relational metadata and aggregate co-authors and funding grants
SELECT 
    ip.document_id,
    ip.doc_type,
    ip.title,
    ip.abstract,
    ip.filing_date,
    ip.publication_or_patent_number,
    ROUND((1 - fc.cosine_dist)::numeric, 4) AS similarity_score,
    COALESCE(
        jsonb_agg(
            DISTINCT jsonb_build_object(
                'author_order', ipa.author_order,
                'is_corresponding', ipa.is_corresponding,
                'faculty_name', f.full_name,
                'department_code', d.department_code,
                'email', f.email
            )
        ) FILTER (WHERE f.faculty_id IS NOT NULL),
        '[]'::jsonb
    ) AS authors,
    COALESCE(
        jsonb_agg(
            DISTINCT jsonb_build_object(
                'grant_code', g.grant_code,
                'title', g.title,
                'funding_agency', g.funding_agency
            )
        ) FILTER (WHERE g.grant_id IS NOT NULL),
        '[]'::jsonb
    ) AS funding_grants
FROM filtered_candidates fc
JOIN intellectual_property ip ON fc.document_id = ip.document_id
LEFT JOIN ip_author ipa ON ip.document_id = ipa.document_id
LEFT JOIN faculty f ON ipa.faculty_id = f.faculty_id
LEFT JOIN department d ON f.department_id = d.department_id
LEFT JOIN grant_ip gi ON ip.document_id = gi.document_id
LEFT JOIN grant_record g ON gi.grant_id = g.grant_id
GROUP BY ip.document_id, ip.doc_type, ip.title, ip.abstract, ip.filing_date, 
         ip.publication_or_patent_number, fc.cosine_dist
ORDER BY fc.cosine_dist ASC;
```

---

## 6. Hybrid Search Architecture (Semantic + Lexical)

While vector similarity captures conceptual meaning, exact keyword match is helpful for specific model names, part numbers, or uncommon terms. We combine semantic and lexical search using **Reciprocal Rank Fusion (RRF)**.

When a user pastes a draft paragraph, an exact boolean `AND` query across all words would return zero results because no existing document contains every single word. Instead, the lexical query converts the query into an `OR` query by converting `&` delimiters from `plainto_tsquery` to `|`:

`replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery`

If the input draft is empty or contains only stop-words (so `plainto_tsquery` returns an empty string), the backend skips the lexical branch and executes semantic search only.

```sql
WITH top_semantic AS (
    -- Gather top-20 semantic candidates using vector index
    SELECT 
        document_id,
        embedding <=> $1::vector AS cosine_dist
    FROM intellectual_property
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT 20
),
ranked_semantic AS (
    SELECT 
        document_id,
        ROW_NUMBER() OVER (ORDER BY cosine_dist ASC) AS rank_semantic
    FROM top_semantic
),
top_lexical AS (
    -- Gather top-20 lexical candidates using OR query over draft text lexemes
    SELECT 
        document_id,
        ts_rank_cd(tsv, replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery) AS lex_score
    FROM intellectual_property
    WHERE tsv @@ replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery
    ORDER BY lex_score DESC
    LIMIT 20
),
ranked_lexical AS (
    SELECT 
        document_id,
        ROW_NUMBER() OVER (ORDER BY lex_score DESC) AS rank_lexical
    FROM top_lexical
)
SELECT 
    ip.document_id,
    ip.title,
    ip.doc_type,
    COALESCE(1.0 / (60 + s.rank_semantic), 0.0) +
    COALESCE(1.0 / (60 + l.rank_lexical), 0.0) AS rrf_score
FROM intellectual_property ip
LEFT JOIN ranked_semantic s ON ip.document_id = s.document_id
LEFT JOIN ranked_lexical l ON ip.document_id = l.document_id
WHERE s.document_id IS NOT NULL OR l.document_id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT 10;
```
This hybrid query balances conceptual similarity with keyword presence, allowing long draft disclosures to match relevant prior art accurately.
