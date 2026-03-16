import { KeyValuePair } from './types';

export function resolveVariables(text: string, variables: KeyValuePair[]): string {
  if (!text) return text;
  let resolved = text;
  for (const v of variables) {
    if (v.key && v.value !== undefined) {
      // Replace all occurrences of {{key}}
      // Use relatively safe regex escaping for v.key
      const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\{\\{${escapeRegExp(v.key)}\\}\\}`, 'g');
      resolved = resolved.replace(regex, v.value);
    }
  }
  return resolved;
}
