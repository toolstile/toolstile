// SQL rows are application-defined; Drizzle callers retain schema types.
// oxlint-disable-next-line typescript/no-explicit-any -- raw SQL row contract
export type SqlRow = Record<string, any>;
export type QueryResult<T = SqlRow> = { rows: T[]; rowCount: number };
export interface SqlResult {
	rows: SqlRow[];
	values: unknown[][];
	columns: { name: string; origin: string | null }[];
	changes: number;
}
export interface PoolClient {
	query<T = SqlRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
	raw(sql: string, params?: unknown[]): Promise<SqlResult>;
	release(error?: Error | boolean): void;
}
export interface Pool {
	query<T = SqlRow>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
	raw(sql: string, params?: unknown[]): Promise<SqlResult>;
	connect(): Promise<PoolClient>;
	end(): Promise<void>;
}

export function statement(sql: string, params: unknown[] = []) {
	return { sql, params };
}
