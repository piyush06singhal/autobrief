const { runReadOnly } = require('./safeQuery');

// Reads a Postgres database's structure from information_schema so the AI can
// propose metrics for it. By design this sends the MODEL ONLY SCHEMA METADATA
// (table/column names, types, keys) — never row values — unless a caller
// explicitly opts in via includeSampleValues, which is off everywhere by
// default. That keeps a self-hoster's actual customer data out of the LLM call.

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];

// All columns of all base tables in user schemas, in table + ordinal order.
const COLUMNS_SQL = `
SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE t.table_type = 'BASE TABLE'
  AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

// Primary-key columns per table.
const PRIMARY_KEYS_SQL = `
SELECT tc.table_schema, tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`;

// Foreign-key edges (which column references which table.column).
const FOREIGN_KEYS_SQL = `
SELECT
  tc.table_schema, tc.table_name, kcu.column_name,
  ccu.table_schema AS foreign_table_schema,
  ccu.table_name   AS foreign_table_name,
  ccu.column_name  AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')`;

function tableKey(schema, name) {
    return `${schema}.${name}`;
}

// Postgres identifier quoting for the optional sample-values query. Double the
// embedded quotes; the whole thing is wrapped in double quotes. Only ever
// applied to real identifiers read back from information_schema.
function quoteIdent(ident) {
    return `"${String(ident).replace(/"/g, '""')}"`;
}

// Introspects the connected database. Returns:
//   { tables: [{ schema, name, columns:[{name,type,nullable}],
//                primaryKey:[col], foreignKeys:[{column,refTable,refColumn}],
//                sampleRows? }],
//     truncated: bool, tableCount }
async function introspectSchema({
    maxTables = 40,
    includeSampleValues = false,
    sampleRowLimit = 3,
} = {}) {
    const [cols, pks, fks] = await Promise.all([
        runReadOnly(COLUMNS_SQL),
        runReadOnly(PRIMARY_KEYS_SQL),
        runReadOnly(FOREIGN_KEYS_SQL),
    ]);

    const tables = new Map();
    function ensureTable(schema, name) {
        const key = tableKey(schema, name);
        if (!tables.has(key)) {
            tables.set(key, { schema, name, columns: [], primaryKey: [], foreignKeys: [] });
        }
        return tables.get(key);
    }

    for (const r of cols.rows) {
        ensureTable(r.table_schema, r.table_name).columns.push({
            name: r.column_name,
            type: r.data_type,
            nullable: r.is_nullable === 'YES',
        });
    }
    for (const r of pks.rows) {
        ensureTable(r.table_schema, r.table_name).primaryKey.push(r.column_name);
    }
    for (const r of fks.rows) {
        ensureTable(r.table_schema, r.table_name).foreignKeys.push({
            column: r.column_name,
            refTable: tableKey(r.foreign_table_schema, r.foreign_table_name),
            refColumn: r.foreign_column_name,
        });
    }

    let allTables = [...tables.values()];
    const tableCount = allTables.length;
    const truncated = tableCount > maxTables;
    if (truncated) allTables = allTables.slice(0, maxTables);

    // Sample values are opt-in (off by default). Even when enabled we cap the
    // number of rows and stringify defensively.
    if (includeSampleValues) {
        for (const t of allTables) {
            try {
                const { rows } = await runReadOnly(
                    `SELECT * FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)} LIMIT ${Number(sampleRowLimit)}`,
                );
                t.sampleRows = rows;
            } catch {
                t.sampleRows = []; // a table we can't read is not fatal for setup
            }
        }
    }

    return { tables: allTables, truncated, tableCount };
}

// Compact, token-friendly text description of the schema for the LLM prompt,
// e.g.  public.orders(id int8 PK, user_id int8 -> public.users.id, amount numeric, created_at timestamptz)
//
// Two guards keep even a huge schema inside the model's context window:
//   - maxColsPerTable  caps a pathologically wide table's column list.
//   - maxChars         caps the whole description; once the budget is reached we
//                      stop emitting tables and note how many were left out.
function formatSchemaForPrompt(schema, { maxColsPerTable = 60, maxChars = 14000 } = {}) {
    const formatted = schema.tables.map((t) => {
        const pk = new Set(t.primaryKey);
        const fkByCol = new Map(t.foreignKeys.map((f) => [f.column, f]));
        const shownCols = t.columns.slice(0, maxColsPerTable);
        const cols = shownCols.map((c) => {
            let s = `${c.name} ${c.type}`;
            if (pk.has(c.name)) s += ' PK';
            const fk = fkByCol.get(c.name);
            if (fk) s += ` -> ${fk.refTable}.${fk.refColumn}`;
            if (!c.nullable && !pk.has(c.name)) s += ' NOT NULL';
            return s;
        });
        const extraCols = t.columns.length - shownCols.length;
        if (extraCols > 0) cols.push(`... (+${extraCols} more columns)`);
        let line = `${tableKey(t.schema, t.name)}(${cols.join(', ')})`;
        if (t.sampleRows && t.sampleRows.length > 0) {
            line += `\n    sample: ${JSON.stringify(t.sampleRows).slice(0, 500)}`;
        }
        return line;
    });

    // Emit tables until the character budget is spent, so a schema with hundreds
    // of tables still yields a valid (if partial) prompt rather than overflowing.
    const kept = [];
    let used = 0;
    let omittedForBudget = 0;
    for (const line of formatted) {
        if (used + line.length + 1 > maxChars && kept.length > 0) {
            omittedForBudget += 1;
            continue;
        }
        kept.push(line);
        used += line.length + 1;
    }

    let text = kept.join('\n');
    const omittedForCount = schema.truncated ? schema.tableCount - schema.tables.length : 0;
    const totalOmitted = omittedForBudget + omittedForCount;
    if (totalOmitted > 0) {
        const shown = schema.tableCount ? schema.tableCount - totalOmitted : kept.length;
        text += `\n\n(Note: showing ${shown} table(s); ${totalOmitted} omitted to fit the model's context. The most relevant tables are usually listed first.)`;
    }
    return text;
}

module.exports = { introspectSchema, formatSchemaForPrompt };
