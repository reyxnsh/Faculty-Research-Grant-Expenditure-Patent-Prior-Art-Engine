-- Up Migration
CREATE OR REPLACE FUNCTION search_ip_fulltext(
    p_query TEXT,
    p_limit INT DEFAULT 20
)
RETURNS TABLE (
    document_id INT,
    title       VARCHAR(400),
    doc_type    VARCHAR(30),
    rank        REAL
)
SECURITY INVOKER
SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
DECLARE
    v_tsquery TSQUERY;
BEGIN
    IF p_query IS NULL OR TRIM(p_query) = '' THEN
        RETURN;
    END IF;

    v_tsquery := websearch_to_tsquery('english', p_query);

    -- If query parses to empty or invalid tsquery, return no rows
    IF v_tsquery IS NULL OR v_tsquery = ''::tsquery THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT 
        ip.document_id,
        ip.title,
        ip.doc_type,
        ts_rank_cd(ip.tsv, v_tsquery)::REAL AS rank
    FROM intellectual_property ip
    WHERE ip.tsv @@ v_tsquery
    ORDER BY rank DESC, ip.document_id ASC
    LIMIT p_limit;
END;
$$;

-- Down Migration
DROP FUNCTION IF EXISTS search_ip_fulltext(TEXT, INT);
