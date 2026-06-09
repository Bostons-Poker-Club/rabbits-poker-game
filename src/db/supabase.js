'use strict';

/**
 * pg-backed compatibility shim for @supabase/supabase-js.
 * Implements the subset of the Supabase fluent query API used in this codebase
 * so all existing call sites continue working against Railway PostgreSQL.
 */

const pool = require('../db');

// FK column for subquery counts: which column in the child table references the parent
const COUNT_FK = {
  table_seats:        'table_id',
  tournament_players: 'tournament_id',
};

// Serialize JS objects/arrays to JSON strings for pg JSONB columns
function _ser(v) {
  if (Array.isArray(v) || (v !== null && v !== undefined && typeof v === 'object' && !(v instanceof Date))) {
    return JSON.stringify(v);
  }
  return v;
}

class QueryBuilder {
  constructor(table) {
    this._table     = table;
    this._mode      = 'select'; // select | insert | update | delete | upsert
    this._cols      = '*';
    this._conds     = [];
    this._params    = [];
    this._orders    = [];
    this._lim       = null;
    this._single    = false;
    this._insertRows   = null;
    this._updateData   = null;
    this._upsertConf   = null;
    this._returning    = null;
    this._countMode    = false;
    this._countHead    = false;
  }

  _p(val) {
    this._params.push(val);
    return `$${this._params.length}`;
  }

  // ── Column/RETURNING selector ───────────────────────────────────────────────
  select(cols, opts) {
    if (this._mode === 'insert' || this._mode === 'update' || this._mode === 'upsert') {
      this._returning = cols || '*';
      return this;
    }
    if (opts && opts.count === 'exact') {
      this._countMode = true;
      this._countHead = !!opts.head;
    }
    this._cols = cols || '*';
    return this;
  }

  // ── Filters ─────────────────────────────────────────────────────────────────
  eq(col, val)   { this._conds.push(`${col} = ${this._p(val)}`);       return this; }
  neq(col, val)  { this._conds.push(`${col} != ${this._p(val)}`);      return this; }
  lt(col, val)   { this._conds.push(`${col} < ${this._p(val)}`);       return this; }
  lte(col, val)  { this._conds.push(`${col} <= ${this._p(val)}`);      return this; }
  gt(col, val)   { this._conds.push(`${col} > ${this._p(val)}`);       return this; }
  gte(col, val)  { this._conds.push(`${col} >= ${this._p(val)}`);      return this; }
  in(col, arr)   { this._conds.push(`${col} = ANY(${this._p(arr)})`);  return this; }
  ilike(col, v)  { this._conds.push(`${col} ILIKE ${this._p(v)}`);     return this; }

  not(col, op, val) {
    if (op === 'eq') this._conds.push(`${col} != ${this._p(val)}`);
    else if (op === 'in') this._conds.push(`NOT (${col} = ANY(${this._p(val)}))`);
    return this;
  }

  or(filterStr) {
    // Parses "col.op.val,col.op.val" and "col.is.null,col.lt.val"
    const clauses = filterStr.split(',').map(part => {
      // Find first and second dot to split col / op / val
      const i1 = part.indexOf('.');
      const i2 = part.indexOf('.', i1 + 1);
      if (i1 === -1 || i2 === -1) return null;
      const col = part.slice(0, i1);
      const op  = part.slice(i1 + 1, i2);
      const val = part.slice(i2 + 1);
      if (op === 'eq')  return `${col} = ${this._p(val)}`;
      if (op === 'neq') return `${col} != ${this._p(val)}`;
      if (op === 'lt')  return `${col} < ${this._p(val)}`;
      if (op === 'lte') return `${col} <= ${this._p(val)}`;
      if (op === 'gt')  return `${col} > ${this._p(val)}`;
      if (op === 'gte') return `${col} >= ${this._p(val)}`;
      if (op === 'is' && val === 'null') return `${col} IS NULL`;
      return null;
    }).filter(Boolean);
    if (clauses.length) this._conds.push(`(${clauses.join(' OR ')})`);
    return this;
  }

  // ── Sort / Limit ─────────────────────────────────────────────────────────────
  order(col, opts) {
    this._orders.push(`${col} ${opts && opts.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }
  limit(n) { this._lim = n; return this; }

  // ── Write ops ────────────────────────────────────────────────────────────────
  insert(data) {
    this._mode = 'insert';
    this._insertRows = Array.isArray(data) ? data : [data];
    return this;
  }
  update(data) {
    this._mode = 'update';
    this._updateData = data;
    return this;
  }
  upsert(data, opts) {
    this._mode = 'upsert';
    this._insertRows = Array.isArray(data) ? data : [data];
    this._upsertConf = opts && opts.onConflict ? opts.onConflict : null;
    return this;
  }
  delete() { this._mode = 'delete'; return this; }

  // ── Row selectors ─────────────────────────────────────────────────────────────
  single()      { this._single = true; return this._exec(); }
  maybeSingle() { this._single = true; return this._exec(); }
  then(ok, fail) { return this._exec().then(ok, fail); }

  // ── Execution ─────────────────────────────────────────────────────────────────
  async _exec() {
    try {
      const where   = this._conds.length  ? `WHERE ${this._conds.join(' AND ')}` : '';
      const orderBy = this._orders.length ? `ORDER BY ${this._orders.join(', ')}` : '';

      // DELETE
      if (this._mode === 'delete') {
        await pool.query(`DELETE FROM ${this._table} ${where}`, this._params);
        return { data: null, error: null };
      }

      // UPDATE
      if (this._mode === 'update') {
        const keys = Object.keys(this._updateData);
        const sets = keys.map(k => `${k} = ${this._p(_ser(this._updateData[k]))}`).join(', ');
        const ret  = this._returning ? `RETURNING ${this._returning}` : '';
        const { rows } = await pool.query(
          `UPDATE ${this._table} SET ${sets} ${where} ${ret}`, this._params
        );
        if (this._returning) {
          return { data: this._single ? (rows[0] || null) : rows, error: null };
        }
        return { data: null, error: null };
      }

      // INSERT / UPSERT
      if (this._mode === 'insert' || this._mode === 'upsert') {
        const inputRows = this._insertRows;
        const allKeys   = [...new Set(inputRows.flatMap(r => Object.keys(r)))];
        const vGroups   = inputRows.map(row =>
          `(${allKeys.map(k => this._p(_ser(row[k] !== undefined ? row[k] : null))).join(', ')})`
        ).join(', ');

        let onConflict = '';
        if (this._mode === 'upsert' && this._upsertConf) {
          const confCols = this._upsertConf.split(',').map(s => s.trim());
          const updKeys  = allKeys.filter(k => !confCols.includes(k));
          onConflict = updKeys.length
            ? `ON CONFLICT (${confCols.join(', ')}) DO UPDATE SET ${updKeys.map(k => `${k} = EXCLUDED.${k}`).join(', ')}`
            : `ON CONFLICT (${confCols.join(', ')}) DO NOTHING`;
        }
        const ret = this._returning ? `RETURNING ${this._returning}` : '';
        const result = await pool.query(
          `INSERT INTO ${this._table} (${allKeys.join(', ')}) VALUES ${vGroups} ${onConflict} ${ret}`,
          this._params
        );
        if (this._returning) {
          return { data: this._single ? (result.rows[0] || null) : result.rows, error: null };
        }
        return { data: null, error: null };
      }

      // COUNT (head: true)
      if (this._countHead) {
        const { rows } = await pool.query(
          `SELECT COUNT(*) AS n FROM ${this._table} ${where}`, this._params
        );
        return { count: Number(rows[0].n), data: null, error: null };
      }

      // SELECT — parse relationship patterns
      const { selectSql, joinSql, reshape } = this._parseRelations(this._cols);
      const limitSql = this._lim !== null ? `LIMIT ${this._lim}` : (this._single ? 'LIMIT 1' : '');
      const { rows } = await pool.query(
        `SELECT ${selectSql} FROM ${this._table} ${joinSql} ${where} ${orderBy} ${limitSql}`,
        this._params
      );

      let data = reshape ? rows.map(reshape) : rows;
      if (this._single) data = data[0] || null;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  }

  // ── Relationship / count pattern parser ──────────────────────────────────────
  // Handles: "*, table_seats(count)"  →  subquery count → [{ count: n }]
  //          "cols, users(id, name)"  →  LEFT JOIN users → nested { users: { ... } }
  _parseRelations(selectStr) {
    const relRx = /(\w+)\(([^)]+)\)/g;
    const rels = [];
    const base = selectStr.replace(relRx, (_, relTable, relCols) => {
      rels.push({ relTable, relCols: relCols.trim() });
      return '';
    }).replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim() || '*';

    if (!rels.length) return { selectSql: selectStr, joinSql: '', reshape: null };

    const extraCols = [];
    const joins     = [];
    const reshapeFns = [];

    for (const { relTable, relCols } of rels) {
      if (relCols === 'count') {
        const fkCol = COUNT_FK[relTable] || `${this._table.replace(/s$/, '')}_id`;
        const alias = `_cnt_${relTable}`;
        extraCols.push(
          `(SELECT COUNT(*) FROM ${relTable} _sq_${relTable} WHERE _sq_${relTable}.${fkCol} = ${this._table}.id) AS ${alias}`
        );
        const cap = relTable;
        reshapeFns.push(row => {
          const n = Number(row[`_cnt_${cap}`]);
          delete row[`_cnt_${cap}`];
          row[cap] = [{ count: n }];
          return row;
        });
      } else {
        const cols  = relCols.split(',').map(s => s.trim());
        const alias = `_j_${relTable}`;
        // Determine join condition — users table joins via user_id, others via table-specific FK
        const joinOn = relTable === 'users'
          ? `${alias}.id = ${this._table}.user_id`
          : `${alias}.id = ${this._table}.${relTable.replace(/s$/, '')}_id`;
        joins.push(`LEFT JOIN ${relTable} ${alias} ON ${joinOn}`);
        const prefixed = cols.map(c => `${alias}.${c} AS _r_${relTable}_${c}`);
        extraCols.push(...prefixed);
        const capTable = relTable;
        const capCols  = cols;
        reshapeFns.push(row => {
          const nested = {};
          let hasAny = false;
          for (const c of capCols) {
            const key = `_r_${capTable}_${c}`;
            if (key in row) {
              if (row[key] !== null) hasAny = true;
              nested[c] = row[key];
              delete row[key];
            }
          }
          row[capTable] = hasAny ? nested : null;
          return row;
        });
      }
    }

    const selectSql = [base, ...extraCols].filter(Boolean).join(', ');
    const joinSql   = joins.join(' ');
    const reshape   = reshapeFns.length
      ? (row => { reshapeFns.forEach(fn => fn(row)); return row; })
      : null;
    return { selectSql, joinSql, reshape };
  }
}

const supabaseAdmin = { from: (table) => new QueryBuilder(table) };
const supabase      = supabaseAdmin;

module.exports = { supabaseAdmin, supabase };
