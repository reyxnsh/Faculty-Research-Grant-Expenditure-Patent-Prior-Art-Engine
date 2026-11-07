/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv').config();

exports.shorthands = undefined;

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER;

  if (!appUser) {
    throw new Error('013_application_role_permissions: missing required APP_DB_USER in environment');
  }

  if (!/^[a-zA-Z0-9_]+$/.test(appUser)) {
    throw new Error('013_application_role_permissions: invalid APP_DB_USER format');
  }

  // 1. Grant execution rights on workflow functions and procedures
  pgm.sql(`
    GRANT EXECUTE ON FUNCTION approve_expenditure(INT, INT) TO "${appUser}";
    GRANT EXECUTE ON FUNCTION reject_or_revert_expenditure(INT, INT, TEXT) TO "${appUser}";
    GRANT EXECUTE ON PROCEDURE approve_expenditure_proc(INT, INT, JSONB) TO "${appUser}";
    GRANT EXECUTE ON PROCEDURE reject_or_revert_expenditure_proc(INT, INT, TEXT, JSONB) TO "${appUser}";
    GRANT EXECUTE ON FUNCTION search_ip_fulltext(TEXT, INT) TO "${appUser}";
  `);

  // 2. Grant SELECT privileges on analytical reporting views
  pgm.sql(`
    GRANT SELECT ON TABLE
      v_grant_financial_summary,
      v_department_expenditure_overview,
      v_faculty_ip_portfolio
    TO "${appUser}";
  `);
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER;

  if (!appUser) {
    throw new Error('013_application_role_permissions: missing required APP_DB_USER in environment');
  }

  if (!/^[a-zA-Z0-9_]+$/.test(appUser)) {
    throw new Error('013_application_role_permissions: invalid APP_DB_USER format');
  }

  // 1. Revoke SELECT privileges on views
  pgm.sql(`
    REVOKE SELECT ON TABLE
      v_grant_financial_summary,
      v_department_expenditure_overview,
      v_faculty_ip_portfolio
    FROM "${appUser}";
  `);

  // 2. Revoke execution rights on functions and procedures
  pgm.sql(`
    REVOKE EXECUTE ON FUNCTION approve_expenditure(INT, INT) FROM "${appUser}";
    REVOKE EXECUTE ON FUNCTION reject_or_revert_expenditure(INT, INT, TEXT) FROM "${appUser}";
    REVOKE EXECUTE ON PROCEDURE approve_expenditure_proc(INT, INT, JSONB) FROM "${appUser}";
    REVOKE EXECUTE ON PROCEDURE reject_or_revert_expenditure_proc(INT, INT, TEXT, JSONB) FROM "${appUser}";
    REVOKE EXECUTE ON FUNCTION search_ip_fulltext(TEXT, INT) FROM "${appUser}";
  `);
};
