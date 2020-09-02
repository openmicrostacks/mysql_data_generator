export type ValuePointer = string
export type ParsedValues = string[]
export type ValuesWithRatio = { [key: string]: number; }
export type Values = ValuePointer | ParsedValues | ValuesWithRatio;

export interface Column {
    name: string;
    generator: string;
    options: ColumnOptions;
    foreignKey?: {
        table: string;
        column: string;
        where?: string;
    };
    values?: Values;
}

interface BaseColumnOptions {
    nullable: boolean;
    unique: boolean;
    autoIncrement: boolean;
    unsigned: boolean;
}

export interface ColumnOptions extends BaseColumnOptions {
    min: number;
    max: number;
    minDate?: string;
    maxDate?: string | undefined;
}