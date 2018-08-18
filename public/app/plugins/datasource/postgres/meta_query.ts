export class PostgresMetaQuery {
  constructor(private target, private queryModel) {}

  getOperators(datatype: string) {
    switch (datatype) {
      case 'float4':
      case 'float8': {
        return ['=', '!=', '<', '<=', '>', '>='];
      }
      case 'text':
      case 'varchar':
      case 'char': {
        return ['=', '!=', '<', '<=', '>', '>=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', '~', '~*', '!~', '!~*'];
      }
      default: {
        return ['=', '!=', '<', '<=', '>', '>=', 'IN', 'NOT IN'];
      }
    }
  }

  // quote identifier as literal to use in metadata queries
  quoteIdentAsLiteral(value) {
    return this.queryModel.quoteLiteral(this.queryModel.unquoteIdentifier(value));
  }

  findMetricTable() {
    // query that returns first table found that has a timestamp(tz) column and a float column
    let query = `
SELECT
	table_name,
	( SELECT
	    column_name
	  FROM information_schema.columns c
    WHERE
      c.table_schema = t.table_schema AND
      c.table_name = t.table_name AND
      udt_name IN ('timestamptz','timestamp')
    ORDER BY ordinal_position LIMIT 1
  ) AS time_column,
  ( SELECT
      column_name
    FROM information_schema.columns c
    WHERE
      c.table_schema = t.table_schema AND
      c.table_name = t.table_name AND
      udt_name='float8'
    ORDER BY ordinal_position LIMIT 1
  ) AS value_column
FROM information_schema.tables t
WHERE
  table_schema IN (
		SELECT CASE WHEN trim(unnest) = '"$user"' THEN user ELSE trim(unnest) END
    FROM unnest(string_to_array(current_setting('search_path'),','))
  ) AND
  EXISTS
  ( SELECT 1
    FROM information_schema.columns c
    WHERE
      c.table_schema = t.table_schema AND
      c.table_name = t.table_name AND
      udt_name IN ('timestamptz','timestamp')
  ) AND
  EXISTS
  ( SELECT 1
    FROM information_schema.columns c
    WHERE
      c.table_schema = t.table_schema AND
      c.table_name = t.table_name AND
      udt_name='float8'
  )
LIMIT 1
;`;
    return query;
  }

  buildSchemaConstraint() {
    let query = `
table_schema IN (
	SELECT CASE WHEN trim(unnest) = \'"$user"\' THEN user ELSE trim(unnest) END
  FROM unnest(string_to_array(current_setting(\'search_path\'),\',\'))
)`;
    return query;
  }

  buildTableConstraint(table: string) {
    let query = '';

    // check for schema qualified table
    if (table.includes('.')) {
      let parts = table.split('.');
      query = 'table_schema = ' + this.quoteIdentAsLiteral(parts[0]);
      query += ' AND table_name = ' + this.quoteIdentAsLiteral(parts[1]);
      return query;
    } else {
      query = `
table_schema IN (
	SELECT CASE WHEN trim(unnest) = \'"$user"\' THEN user ELSE trim(unnest) END
  FROM unnest(string_to_array(current_setting(\'search_path\'),\',\'))
)`;
      query += ' AND table_name = ' + this.quoteIdentAsLiteral(table);

      return query;
    }
  }

  buildTableQuery() {
    let query = 'SELECT quote_ident(table_name) FROM information_schema.tables WHERE ';
    query += this.buildSchemaConstraint();
    query += ' ORDER BY table_name';
    return query;
  }

  buildColumnQuery(type?: string) {
    let query = 'SELECT quote_ident(column_name) FROM information_schema.columns WHERE ';
    query += this.buildTableConstraint(this.target.table);

    switch (type) {
      case 'time': {
        query +=
          " AND data_type IN ('timestamp without time zone','timestamp with time zone','bigint','integer','double precision','real')";
        break;
      }
      case 'metric': {
        query += " AND data_type IN ('text','char','varchar')";
        break;
      }
      case 'value': {
        query += " AND data_type IN ('bigint','integer','double precision','real')";
        query += ' AND column_name <> ' + this.quoteIdentAsLiteral(this.target.timeColumn);
        break;
      }
      case 'group': {
        query += " AND data_type IN ('text','char','varchar')";
        break;
      }
    }

    query += ' ORDER BY column_name';

    return query;
  }

  buildValueQuery(column: string) {
    let query = 'SELECT DISTINCT quote_literal(' + column + ')';
    query += ' FROM ' + this.target.table;
    query += ' WHERE $__timeFilter(' + this.target.timeColumn + ')';
    query += ' ORDER BY 1 LIMIT 100';
    return query;
  }

  buildDatatypeQuery(column: string) {
    let query = `
SELECT udt_name
FROM information_schema.columns
WHERE
  table_schema IN (
  SELECT schema FROM (
		  SELECT CASE WHEN trim(unnest) = \'"$user"\' THEN user ELSE trim(unnest) END as schema
      FROM unnest(string_to_array(current_setting(\'search_path\'),\',\'))
    ) s
    WHERE EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s.schema)
  )
`;
    query += ' AND table_name = ' + this.quoteIdentAsLiteral(this.target.table);
    query += ' AND column_name = ' + this.quoteIdentAsLiteral(column);
    return query;
  }

  buildAggregateQuery() {
    let query = 'SELECT DISTINCT proname FROM pg_aggregate ';
    query += 'INNER JOIN pg_proc ON pg_aggregate.aggfnoid = pg_proc.oid ';
    query += 'INNER JOIN pg_type ON pg_type.oid=pg_proc.prorettype ';
    query += "WHERE pronargs=1 AND typname IN ('float8') AND aggkind='n' ORDER BY 1";
    return query;
  }
}
