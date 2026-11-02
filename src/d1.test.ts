import { describe, it, expect } from 'vitest';
import type { D1Database, TableInfo, QueryOutcome } from './types';
import {
  buildD1TreeRows,
  formatQueryStatus,
  selectTableSql,
  pickRunText,
  refreshTargetDbId,
  toGridColumns,
  toGridSource,
} from './d1';

describe('buildD1TreeRows', () => {
  it('expanded {} with one db -> only [root] with expanded false', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    const expanded = new Set<string>();
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows).toEqual([
      {
        id: 'root',
        label: 'D1 Databases',
        icon: 'database',
        depth: 0,
        expandable: true,
        expanded: false,
        loading: false,
      },
    ]);
  });

  it('expanded {root}, db u1, schema not loaded -> [root, db:u1] with db:u1 depth 1, expandable true, expanded false, data {dbId:"u1"}', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    const expanded = new Set<string>(['root']);
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 'root',
      label: 'D1 Databases',
      icon: 'database',
      depth: 0,
      expandable: true,
      expanded: true,
      loading: false,
    });
    expect(rows[1]).toEqual({
      id: 'db:u1',
      label: 'db1',
      icon: 'database',
      depth: 1,
      expandable: true,
      expanded: false,
      loading: false,
      data: { dbId: 'u1' },
    });
  });

  it('expanded {root, db:u1} with schema not loaded -> no table rows', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    const expanded = new Set<string>(['root', 'db:u1']);
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows.map((r) => r.id)).toEqual(['root', 'db:u1']);
  });

  it('with schema -> tbl:u1:t (icon table, expandable true, data {dbId:"u1",table:"t"}) then tbl:u1:v (icon view, expandable false) and no column rows', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    schemas.set('u1', [
      {
        name: 't',
        kind: 'table',
        columns: [
          { name: 'id', col_type: 'INTEGER', pk: true, not_null: true },
          { name: 'x', col_type: 'TEXT', pk: false, not_null: false },
        ],
      },
      {
        name: 'v',
        kind: 'view',
        columns: [],
      },
    ]);
    const expanded = new Set<string>(['root', 'db:u1']);
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows.map((r) => r.id)).toEqual(['root', 'db:u1', 'tbl:u1:t', 'tbl:u1:v']);
    expect(rows[2]).toEqual({
      id: 'tbl:u1:t',
      label: 't',
      icon: 'table',
      depth: 2,
      expandable: true,
      expanded: false,
      loading: false,
      data: { dbId: 'u1', table: 't' },
    });
    expect(rows[3]).toEqual({
      id: 'tbl:u1:v',
      label: 'v',
      icon: 'view',
      depth: 2,
      expandable: false,
      expanded: false,
      loading: false,
      data: { dbId: 'u1', table: 'v' },
    });
  });

  it('adding tbl:u1:t to expanded -> col:u1:t:id labelled "id INTEGER (PK)" and col:u1:t:x labelled "x TEXT", depth 3, icon column, placed between tbl:u1:t and tbl:u1:v', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    schemas.set('u1', [
      {
        name: 't',
        kind: 'table',
        columns: [
          { name: 'id', col_type: 'INTEGER', pk: true, not_null: true },
          { name: 'x', col_type: 'TEXT', pk: false, not_null: false },
        ],
      },
      {
        name: 'v',
        kind: 'view',
        columns: [],
      },
    ]);
    const expanded = new Set<string>(['root', 'db:u1', 'tbl:u1:t']);
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows.map((r) => r.id)).toEqual([
      'root',
      'db:u1',
      'tbl:u1:t',
      'col:u1:t:id',
      'col:u1:t:x',
      'tbl:u1:v',
    ]);
    expect(rows[3]).toEqual({
      id: 'col:u1:t:id',
      label: 'id INTEGER (PK)',
      icon: 'column',
      depth: 3,
      expandable: false,
      expanded: false,
      loading: false,
      data: { dbId: 'u1' },
    });
    expect(rows[4]).toEqual({
      id: 'col:u1:t:x',
      label: 'x TEXT',
      icon: 'column',
      depth: 3,
      expandable: false,
      expanded: false,
      loading: false,
      data: { dbId: 'u1' },
    });
  });

  it('tbl:u1:t expanded but db:u1 collapsed -> no table/column rows', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    schemas.set('u1', [
      {
        name: 't',
        kind: 'table',
        columns: [
          { name: 'id', col_type: 'INTEGER', pk: true, not_null: true },
        ],
      },
    ]);
    const expanded = new Set<string>(['root', 'tbl:u1:t']);
    const loading = new Set<string>();

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    expect(rows.map((r) => r.id)).toEqual(['root', 'db:u1']);
  });

  it('loading {db:u1} -> that row has loading true', () => {
    const dbs: D1Database[] = [{ uuid: 'u1', name: 'db1', created_at: null, jurisdiction: null }];
    const schemas = new Map<string, TableInfo[]>();
    const expanded = new Set<string>(['root']);
    const loading = new Set<string>(['db:u1']);

    const rows = buildD1TreeRows(dbs, schemas, expanded, loading);
    const dbRow = rows.find((r) => r.id === 'db:u1');
    expect(dbRow?.loading).toBe(true);
  });
});

describe('formatQueryStatus', () => {
  function makeOutcome(overrides: Partial<QueryOutcome>): QueryOutcome {
    return {
      columns: [],
      rows: [],
      result_statement: null,
      statement_count: 1,
      rows_read: 0,
      rows_written: 0,
      changes: 0,
      duration_ms: 0,
      limit_applied: false,
      ...overrides,
    };
  }

  it('columns ["one"], rows [[1]], limit_applied true, read 0, written 0, duration 2 ms, statement_count 1 -> "1 row(s) (auto LIMIT 1000) · read 0 · written 0 · 2.0 ms"', () => {
    const outcome = makeOutcome({
      columns: ['one'],
      rows: [[1]],
      limit_applied: true,
      rows_read: 0,
      rows_written: 0,
      duration_ms: 2,
      statement_count: 1,
    });
    expect(formatQueryStatus(outcome)).toBe(
      '1 row(s) (auto LIMIT 1000) · read 0 · written 0 · 2.0 ms'
    );
  });

  it('5 rows, no limit, read 5, written 0, 1.5 ms -> "5 row(s) · read 5 · written 0 · 1.5 ms"', () => {
    const outcome = makeOutcome({
      columns: ['col'],
      rows: [[1], [2], [3], [4], [5]],
      limit_applied: false,
      rows_read: 5,
      rows_written: 0,
      duration_ms: 1.5,
      statement_count: 1,
    });
    expect(formatQueryStatus(outcome)).toBe('5 row(s) · read 5 · written 0 · 1.5 ms');
  });

  it('no columns, statement_count 1, changes 0, 0.5 ms -> "Executed 1 statement(s) · 0 row(s) changed · read 0 · written 0 · 0.5 ms"', () => {
    const outcome = makeOutcome({
      columns: [],
      rows: [],
      statement_count: 1,
      changes: 0,
      rows_read: 0,
      rows_written: 0,
      duration_ms: 0.5,
    });
    expect(formatQueryStatus(outcome)).toBe(
      'Executed 1 statement(s) · 0 row(s) changed · read 0 · written 0 · 0.5 ms'
    );
  });

  it('statement_count 2 with result_statement 2, columns ["two"] -> "Showing result of statement 2 of 2 · 1 row(s) · read 0 · written 0 · 0.5 ms"', () => {
    const outcome = makeOutcome({
      columns: ['two'],
      rows: [[2]],
      statement_count: 2,
      result_statement: 2,
      rows_read: 0,
      rows_written: 0,
      duration_ms: 0.5,
    });
    expect(formatQueryStatus(outcome)).toBe(
      'Showing result of statement 2 of 2 · 1 row(s) · read 0 · written 0 · 0.5 ms'
    );
  });

  it('statement_count 2, result_statement null, no columns, changes 3 -> "Executed 2 statement(s) · 3 row(s) changed · read 0 · written 0 · 0.5 ms" with no prefix', () => {
    const outcome = makeOutcome({
      columns: [],
      rows: [],
      statement_count: 2,
      result_statement: null,
      changes: 3,
      rows_read: 0,
      rows_written: 0,
      duration_ms: 0.5,
    });
    expect(formatQueryStatus(outcome)).toBe(
      'Executed 2 statement(s) · 3 row(s) changed · read 0 · written 0 · 0.5 ms'
    );
  });

  it('statement_count 1 with columns -> no prefix', () => {
    const outcome = makeOutcome({
      columns: ['col'],
      rows: [[1]],
      statement_count: 1,
      result_statement: 1,
      rows_read: 0,
      rows_written: 0,
      duration_ms: 1.0,
    });
    expect(formatQueryStatus(outcome)).toBe('1 row(s) · read 0 · written 0 · 1.0 ms');
    expect(formatQueryStatus(outcome)).not.toContain('Showing result of statement');
  });
});

describe('selectTableSql', () => {
  it('selectTableSql("users") -> SELECT * FROM "users" LIMIT 100;', () => {
    expect(selectTableSql('users')).toBe('SELECT * FROM "users" LIMIT 100;');
  });

  it('selectTableSql("my\\"t") -> SELECT * FROM "my""""t" LIMIT 100;', () => {
    expect(selectTableSql('my"t')).toBe('SELECT * FROM "my""t" LIMIT 100;');
  });
});

describe('pickRunText', () => {
  it('pickRunText("SELECT 1; SELECT 2", 0, 8) -> "SELECT 1"', () => {
    expect(pickRunText('SELECT 1; SELECT 2', 0, 8)).toBe('SELECT 1');
  });

  it('pickRunText("SELECT 1; SELECT 2", 3, 3) -> the whole text', () => {
    expect(pickRunText('SELECT 1; SELECT 2', 3, 3)).toBe('SELECT 1; SELECT 2');
  });
});

describe('refreshTargetDbId', () => {
  it('"root" -> null', () => {
    expect(refreshTargetDbId('root')).toBeNull();
  });

  it('"db:u1", "tbl:u1:t", "col:u1:a:b:c" -> "u1"', () => {
    expect(refreshTargetDbId('db:u1')).toBe('u1');
    expect(refreshTargetDbId('tbl:u1:t')).toBe('u1');
    expect(refreshTargetDbId('col:u1:a:b:c')).toBe('u1');
  });
});

describe('toGridColumns and toGridSource', () => {
  it('toGridColumns(["a","a"]) -> props ["c0","c1"], names ["a","a"], size 150, minSize 50, sortable true', () => {
    const cols = toGridColumns(['a', 'a']);
    expect(cols).toHaveLength(2);
    expect(cols[0].prop).toBe('c0');
    expect(cols[0].name).toBe('a');
    expect(cols[0].size).toBe(150);
    expect(cols[0].minSize).toBe(50);
    expect(cols[0].sortable).toBe(true);

    expect(cols[1].prop).toBe('c1');
    expect(cols[1].name).toBe('a');
    expect(cols[1].size).toBe(150);
    expect(cols[1].minSize).toBe(50);
    expect(cols[1].sortable).toBe(true);
  });

  it('cellProperties({model:{c0:null}, prop:"c0"}) -> {class:{"cell-null":true}}; with model {c0:0} -> {}', () => {
    const cols = toGridColumns(['a']);
    expect(cols[0].cellProperties({ model: { c0: null }, prop: 'c0' })).toEqual({
      class: { 'cell-null': true },
    });
    expect(cols[0].cellProperties({ model: { c0: 0 }, prop: 'c0' })).toEqual({});
    expect(cols[0].cellProperties({ model: null, prop: 'c0' })).toEqual({});
  });

  it('two calls return different array references', () => {
    const cols1 = toGridColumns(['a']);
    const cols2 = toGridColumns(['a']);
    expect(cols1).not.toBe(cols2);
  });

  it('toGridSource([[1,null],[2,"x"]]) -> [{c0:1,c1:null},{c0:2,c1:"x"}]', () => {
    expect(toGridSource([[1, null], [2, 'x']])).toEqual([
      { c0: 1, c1: null },
      { c0: 2, c1: 'x' },
    ]);
  });
});
