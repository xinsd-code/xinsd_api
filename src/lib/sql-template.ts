const SQL_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractSqlVariables(sqlTemplate: string): string[] {
  const variables = new Set<string>();
  for (const match of sqlTemplate.matchAll(SQL_VARIABLE_PATTERN)) {
    const key = match[1]?.trim();
    if (key) {
      variables.add(key);
    }
  }
  return Array.from(variables);
}

export { SQL_VARIABLE_PATTERN };
