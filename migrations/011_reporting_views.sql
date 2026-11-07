-- Up Migration
CREATE OR REPLACE VIEW v_grant_financial_summary AS
SELECT 
    g.grant_id,
    g.grant_code,
    g.title,
    g.funding_agency,
    g.status AS grant_status,
    g.start_date,
    g.end_date,
    f.full_name AS pi_name,
    d.department_code,
    g.total_budget AS sanctioned_budget,
    COALESCE(SUM(ga.budget_allocated), 0) AS total_allocated,
    (g.total_budget - COALESCE(SUM(ga.budget_allocated), 0)) AS unallocated_reserve,
    COALESCE(SUM(ga.current_balance), 0) AS remaining_cash_balance,
    COALESCE(SUM(ga.budget_allocated - ga.current_balance), 0) AS total_spent,
    CASE 
        WHEN g.total_budget > 0 
        THEN ROUND(((COALESCE(SUM(ga.budget_allocated - ga.current_balance), 0) / g.total_budget) * 100), 2)
        ELSE 0 
    END AS budget_utilization_pct,
    COUNT(DISTINCT ga.account_id) AS total_budget_heads
FROM grant_record g
JOIN faculty f ON g.pi_faculty_id = f.faculty_id
JOIN department d ON f.department_id = d.department_id
LEFT JOIN grant_account ga ON g.grant_id = ga.grant_id
GROUP BY g.grant_id, g.grant_code, g.title, g.funding_agency, g.status, 
         g.start_date, g.end_date, f.full_name, d.department_code, g.total_budget;

CREATE OR REPLACE VIEW v_department_expenditure_overview AS
WITH dept_grants AS (
    SELECT 
        f.department_id,
        COUNT(DISTINCT g.grant_id) AS total_grants,
        COUNT(DISTINCT CASE WHEN g.status = 'ACTIVE' THEN g.grant_id END) AS active_grants,
        COALESCE(SUM(g.total_budget), 0) AS total_sanctioned_funds
    FROM faculty f
    JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    GROUP BY f.department_id
),
dept_expenditures AS (
    SELECT 
        f.department_id,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'APPROVED'), 0) AS total_approved_expenditure,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'PENDING'), 0) AS pending_claims_value,
        COUNT(e.transaction_id) FILTER (WHERE e.status = 'APPROVED') AS approved_transaction_count
    FROM faculty f
    JOIN grant_record g ON f.faculty_id = g.pi_faculty_id
    JOIN grant_account ga ON g.grant_id = ga.grant_id
    JOIN expenditure e ON ga.account_id = e.account_id
    GROUP BY f.department_id
)
SELECT 
    d.department_id,
    d.department_name,
    d.department_code,
    COALESCE(dg.total_grants, 0) AS total_grants,
    COALESCE(dg.active_grants, 0) AS active_grants,
    COALESCE(dg.total_sanctioned_funds, 0) AS total_sanctioned_funds,
    COALESCE(de.total_approved_expenditure, 0) AS total_approved_expenditure,
    COALESCE(de.pending_claims_value, 0) AS pending_claims_value,
    COALESCE(de.approved_transaction_count, 0) AS approved_transaction_count
FROM department d
LEFT JOIN dept_grants dg ON d.department_id = dg.department_id
LEFT JOIN dept_expenditures de ON d.department_id = de.department_id;

CREATE OR REPLACE VIEW v_faculty_ip_portfolio AS
SELECT 
    f.faculty_id,
    f.full_name,
    f.email,
    f.designation,
    d.department_code,
    COUNT(DISTINCT ipa.document_id) AS total_ip_disclosures,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'PATENT' THEN ip.document_id END) AS patents_filed,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'PAPER' THEN ip.document_id END) AS papers_published,
    COUNT(DISTINCT CASE WHEN ip.doc_type = 'DRAFT_DISCLOSURE' THEN ip.document_id END) AS draft_disclosures,
    COUNT(DISTINCT CASE WHEN ipa.is_corresponding = TRUE THEN ipa.document_id END) AS corresponding_author_count,
    COUNT(DISTINCT g.grant_id) AS associated_funded_grants
FROM faculty f
JOIN department d ON f.department_id = d.department_id
LEFT JOIN ip_author ipa ON f.faculty_id = ipa.faculty_id
LEFT JOIN intellectual_property ip ON ipa.document_id = ip.document_id
LEFT JOIN grant_ip gi ON ip.document_id = gi.document_id
LEFT JOIN grant_record g ON gi.grant_id = g.grant_id
GROUP BY f.faculty_id, f.full_name, f.email, f.designation, d.department_code;

-- Down Migration
DROP VIEW IF EXISTS v_faculty_ip_portfolio;
DROP VIEW IF EXISTS v_department_expenditure_overview;
DROP VIEW IF EXISTS v_grant_financial_summary;
