import { describe, it, expect } from 'vitest';
import { getAdminPool } from '@/lib/db';

describe('Schema Structure & Relational Definition', () => {
  const pool = getAdminPool();

  it('verifies all 10 domain and audit tables exist in information_schema', async () => {
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'pgmigrations'
      ORDER BY table_name;
    `);

    const tables = res.rows.map((r) => r.table_name);
    const expectedTables = [
      'audit_log',
      'department',
      'expenditure',
      'faculty',
      'grant_account',
      'grant_ip',
      'grant_record',
      'intellectual_property',
      'ip_author',
      'users',
    ];

    expect(tables).toEqual(expectedTables);
  });

  it('verifies column data types and nullability for core business entities', async () => {
    const colRes = await pool.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `);

    const colsByTable = new Map<string, Map<string, { type: string; nullable: string }>>();
    for (const row of colRes.rows) {
      if (!colsByTable.has(row.table_name)) {
        colsByTable.set(row.table_name, new Map());
      }
      colsByTable.get(row.table_name)!.set(row.column_name, {
        type: row.data_type,
        nullable: row.is_nullable,
      });
    }

    // 1. Department
    const deptCols = colsByTable.get('department')!;
    expect(deptCols.get('department_name')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(deptCols.get('department_code')).toMatchObject({ type: 'character varying', nullable: 'NO' });

    // 2. Faculty
    const facCols = colsByTable.get('faculty')!;
    expect(facCols.get('full_name')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(facCols.get('email')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(facCols.get('department_id')).toMatchObject({ type: 'integer', nullable: 'NO' });

    // 3. Users
    const userCols = colsByTable.get('users')!;
    expect(userCols.get('email')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(userCols.get('role')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(userCols.get('faculty_id')).toMatchObject({ type: 'integer', nullable: 'YES' });

    // 4. Grant Record
    const grantCols = colsByTable.get('grant_record')!;
    expect(grantCols.get('total_budget')).toMatchObject({ type: 'numeric', nullable: 'NO' });
    expect(grantCols.get('start_date')).toMatchObject({ type: 'date', nullable: 'NO' });
    expect(grantCols.get('end_date')).toMatchObject({ type: 'date', nullable: 'NO' });

    // 5. Grant Account
    const accCols = colsByTable.get('grant_account')!;
    expect(accCols.get('budget_allocated')).toMatchObject({ type: 'numeric', nullable: 'NO' });
    expect(accCols.get('current_balance')).toMatchObject({ type: 'numeric', nullable: 'NO' });

    // 6. Expenditure
    const expCols = colsByTable.get('expenditure')!;
    expect(expCols.get('amount')).toMatchObject({ type: 'numeric', nullable: 'NO' });
    expect(expCols.get('status')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(expCols.get('approved_by')).toMatchObject({ type: 'integer', nullable: 'YES' });

    // 7. Intellectual Property
    const ipCols = colsByTable.get('intellectual_property')!;
    expect(ipCols.get('doc_type')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(ipCols.get('title')).toMatchObject({ type: 'character varying', nullable: 'NO' });
    expect(ipCols.get('embedding')).toMatchObject({ type: 'USER-DEFINED', nullable: 'YES' });
    expect(ipCols.get('tsv')).toMatchObject({ type: 'tsvector', nullable: 'YES' });
  });

  it('verifies all primary key definitions', async () => {
    const pkRes = await pool.query(`
      SELECT tc.table_name, ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name <> 'pgmigrations'
      ORDER BY tc.table_name, ccu.column_name;
    `);

    const pks = new Map<string, string[]>();
    for (const r of pkRes.rows) {
      if (!pks.has(r.table_name)) pks.set(r.table_name, []);
      pks.get(r.table_name)!.push(r.column_name);
    }

    expect(pks.get('department')).toEqual(['department_id']);
    expect(pks.get('faculty')).toEqual(['faculty_id']);
    expect(pks.get('users')).toEqual(['user_id']);
    expect(pks.get('grant_record')).toEqual(['grant_id']);
    expect(pks.get('grant_account')).toEqual(['account_id']);
    expect(pks.get('expenditure')).toEqual(['transaction_id']);
    expect(pks.get('intellectual_property')).toEqual(['document_id']);
    expect(pks.get('ip_author')?.sort()).toEqual(['document_id', 'faculty_id']);
    expect(pks.get('grant_ip')?.sort()).toEqual(['document_id', 'grant_id']);
    expect(pks.get('audit_log')).toEqual(['log_id']);
  });

  it('verifies foreign key constraints, referenced tables, and ON DELETE/UPDATE actions', async () => {
    const fkRes = await pool.query(`
      SELECT
        rc.constraint_name,
        kcu.table_name AS source_table,
        kcu.column_name AS source_column,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON rc.constraint_name = kcu.constraint_name
       AND rc.constraint_schema = kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON rc.constraint_name = ccu.constraint_name
       AND rc.constraint_schema = ccu.constraint_schema
      WHERE rc.constraint_schema = 'public'
      ORDER BY rc.constraint_name;
    `);

    interface FkRow {
      constraint_name: string;
      source_table: string;
      source_column: string;
      target_table: string;
      target_column: string;
      delete_rule: string;
      update_rule: string;
    }
    const fksByName = new Map<string, FkRow>();
    for (const row of fkRes.rows) {
      fksByName.set(row.constraint_name, row as FkRow);
    }

    // 1. fk_faculty_department (RESTRICT / CASCADE)
    expect(fksByName.get('fk_faculty_department')).toMatchObject({
      source_table: 'faculty',
      source_column: 'department_id',
      target_table: 'department',
      target_column: 'department_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 2. fk_user_faculty (RESTRICT / CASCADE)
    expect(fksByName.get('fk_user_faculty')).toMatchObject({
      source_table: 'users',
      source_column: 'faculty_id',
      target_table: 'faculty',
      target_column: 'faculty_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 3. fk_grant_pi (RESTRICT / CASCADE)
    expect(fksByName.get('fk_grant_pi')).toMatchObject({
      source_table: 'grant_record',
      source_column: 'pi_faculty_id',
      target_table: 'faculty',
      target_column: 'faculty_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 4. fk_account_grant (CASCADE / CASCADE)
    expect(fksByName.get('fk_account_grant')).toMatchObject({
      source_table: 'grant_account',
      source_column: 'grant_id',
      target_table: 'grant_record',
      target_column: 'grant_id',
      delete_rule: 'CASCADE',
      update_rule: 'CASCADE',
    });

    // 5. fk_expenditure_account (RESTRICT / CASCADE)
    expect(fksByName.get('fk_expenditure_account')).toMatchObject({
      source_table: 'expenditure',
      source_column: 'account_id',
      target_table: 'grant_account',
      target_column: 'account_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 6. fk_expenditure_submitter (RESTRICT / CASCADE)
    expect(fksByName.get('fk_expenditure_submitter')).toMatchObject({
      source_table: 'expenditure',
      source_column: 'submitted_by',
      target_table: 'faculty',
      target_column: 'faculty_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 7. fk_expenditure_approver (RESTRICT / CASCADE)
    expect(fksByName.get('fk_expenditure_approver')).toMatchObject({
      source_table: 'expenditure',
      source_column: 'approved_by',
      target_table: 'users',
      target_column: 'user_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 8. fk_ipauthor_document (CASCADE / CASCADE)
    expect(fksByName.get('fk_ipauthor_document')).toMatchObject({
      source_table: 'ip_author',
      source_column: 'document_id',
      target_table: 'intellectual_property',
      target_column: 'document_id',
      delete_rule: 'CASCADE',
      update_rule: 'CASCADE',
    });

    // 9. fk_ipauthor_faculty (RESTRICT / CASCADE)
    expect(fksByName.get('fk_ipauthor_faculty')).toMatchObject({
      source_table: 'ip_author',
      source_column: 'faculty_id',
      target_table: 'faculty',
      target_column: 'faculty_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });

    // 10. fk_grantip_grant (CASCADE / CASCADE)
    expect(fksByName.get('fk_grantip_grant')).toMatchObject({
      source_table: 'grant_ip',
      source_column: 'grant_id',
      target_table: 'grant_record',
      target_column: 'grant_id',
      delete_rule: 'CASCADE',
      update_rule: 'CASCADE',
    });

    // 11. fk_grantip_document (CASCADE / CASCADE)
    expect(fksByName.get('fk_grantip_document')).toMatchObject({
      source_table: 'grant_ip',
      source_column: 'document_id',
      target_table: 'intellectual_property',
      target_column: 'document_id',
      delete_rule: 'CASCADE',
      update_rule: 'CASCADE',
    });

    // 12. fk_audit_user (RESTRICT / CASCADE)
    expect(fksByName.get('fk_audit_user')).toMatchObject({
      source_table: 'audit_log',
      source_column: 'changed_by',
      target_table: 'users',
      target_column: 'user_id',
      delete_rule: 'RESTRICT',
      update_rule: 'CASCADE',
    });
  });
});
