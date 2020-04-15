import Knex = require('knex');
import { Column } from './column';
import { Schema } from './main';
import { MySQLColumn } from './mysql-column';
import { Table } from './table';

export interface CustomSchema {
    maxCharLength?: number;
    ignoredTables?: string[];
    tables?: Partial<Table>[];
    values?: { [key: string]: any[]; };
}

export class Analyser {
    private tables: Table[] = [];
    private values: { [key: string]: any[]; };

    constructor(
        private dbConnection: Knex,
        private database: string,
        private customSchema?: CustomSchema,
    ) {
        if (customSchema && customSchema.values) this.values = customSchema.values;
        else this.values = {};
    }

    public extractTables = async () => {
        const tables: { name: string, lines: number, referenced_table: any; }[] = await this.dbConnection
            .select([
                this.dbConnection.raw('t.TABLE_NAME AS name'),
                this.dbConnection.raw('GROUP_CONCAT(c.REFERENCED_TABLE_NAME SEPARATOR ",") AS referenced_table'),
            ])
            .from('information_schema.tables as t')
            .leftJoin('information_schema.key_column_usage as c', function () {
                this.on('c.CONSTRAINT_SCHEMA', '=', 't.TABLE_SCHEMA')
                    .andOn('c.TABLE_NAME', '=', 't.TABLE_NAME');
            })
            .where('t.TABLE_SCHEMA', this.database)
            .andWhere('t.TABLE_TYPE', 'BASE TABLE')
            .whereNotIn('t.TABLE_NAME', this.customSchema.ignoredTables || [])
            .groupBy('t.TABLE_SCHEMA', 't.TABLE_NAME')
            .orderBy(2);
        for (let t = 0; t < tables.length; t++) {
            const table = tables[t];
            let lines;
            if (this.customSchema) {
                const customTable = this.customSchema.tables.find(t => t.name.toLowerCase() === table.name.toLowerCase());
                if (customTable) lines = customTable.lines;
                // TODO: handle custom foreign keys
                if (customTable && customTable.columns) {
                    for (const column of customTable.columns) {
                        if (column.foreignKey) {
                            if (table.referenced_table) table.referenced_table += `,${column.foreignKey.table}`;
                        }
                    }
                }
            }
            if (lines === undefined) lines = (await this.dbConnection(table.name).count())[0]['count(*)'] as number;
            table.lines = lines;
            if (table.referenced_table !== null) {
                table.referenced_table = table.referenced_table.split(',');
            } else {
                table.referenced_table = [];
            }
        }

        const recursive = (branch: { name: string, lines: number, referenced_table: string[]; }[]) => {
            const table = branch[branch.length - 1];
            while (table.referenced_table.length > 0) {
                const tableName = table.referenced_table.pop();
                const referencedTable = tables.find((t) => {
                    return t.name === tableName;
                });
                if (referencedTable) recursive([].concat(branch, referencedTable));
            };

            if (table.referenced_table.length === 0) {
                if (this.tables.find((t) => t.name.toLowerCase() === table.name.toLowerCase())) return;
                this.tables.push({
                    name: table.name,
                    lines: table.lines,
                    columns: [],
                });
                branch.pop();
                return;
            }
        };

        tables.forEach((table) => {
            recursive([table]);
        });
    };

    public extractColumns = async () => {
        for (const table of this.tables) {
            const customTable = Object.assign({}, { columns: [] }, this.customSchema.tables.find(t => t.name.toLowerCase() === table.name.toLowerCase()));
            const columns: MySQLColumn[] = await this.dbConnection.select()
                .from('information_schema.COLUMNS')
                .where({ 'TABLE_NAME': table.name });

            columns
                .filter((column: MySQLColumn) => {
                    return ['enum', 'set'].includes(column.DATA_TYPE);
                }).forEach((column: MySQLColumn) => {
                    column.NUMERIC_PRECISION = column.COLUMN_TYPE.match(/[enum,set]\((.*)\)$/)[1].split('\',\'').length;
                });

            table.columns = columns.map((column: MySQLColumn) => {
                const options: Column['options'] = {};
                if (column.IS_NULLABLE === 'YES') options.nullable = true;
                options.max = column.CHARACTER_MAXIMUM_LENGTH || column.NUMERIC_PRECISION;
                if (column.COLUMN_TYPE.includes('unsigned')) options.unsigned = true;
                if (column.EXTRA.includes('auto_increment')) options.autoIncrement = true;
                return {
                    name: column.COLUMN_NAME,
                    generator: column.DATA_TYPE,
                    options,
                };
            });

            const foreignKeys = await this.dbConnection.select([
                'column_name',
                'referenced_table_name',
                'referenced_column_name',
            ])
                .from('information_schema.key_column_usage')
                .where('table_name', table.name)
                .whereNotNull('referenced_column_name');

            for (let c = 0; c < table.columns.length; c++) {
                const column = table.columns[c];
                const customColumn = customTable.columns.find(cc => cc.name.toLowerCase() === column.name.toLowerCase());
                const match = foreignKeys.find((fk) => fk.column_name.toLowerCase() === column.name.toLowerCase());
                if (match) {
                    column.foreignKey = { table: match.referenced_table_name, column: match.referenced_column_name };
                }
                if (customColumn) {
                    column.options = Object.assign({}, column.options, customColumn.options);
                    column.foreignKey = customColumn.foreignKey;
                    column.values = customColumn.values;
                }
            }
        }
    };

    public generateJson(): Schema {
        return {
            maxCharLength: this.customSchema.maxCharLength || 255,
            tables: this.tables,
            values: this.values,
        };
    }
}