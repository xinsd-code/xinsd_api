import { flattenJsonBody, parseJsonBody } from './json-body';
import { ForwardTargetParamOption, KeyValuePair } from './types';

export function extractForwardTargetParams(
  requestParams: KeyValuePair[] = [],
  requestBody = ''
): ForwardTargetParamOption[] {
  const queryParams: ForwardTargetParamOption[] = requestParams
    .filter((param) => param.key)
    .map((param) => ({
      key: param.key,
      value: param.value,
      location: 'query',
      valueType: 'string',
    }));

  const parsedBody = parseJsonBody(requestBody);
  const bodyParams: ForwardTargetParamOption[] =
    parsedBody.error || parsedBody.data === null
      ? []
      : flattenJsonBody(parsedBody.data).map((field) => ({
          key: field.path,
          value: field.value,
          location: 'body',
          valueType: field.type,
        }));

  return [...queryParams, ...bodyParams];
}
