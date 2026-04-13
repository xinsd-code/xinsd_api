import { DatabaseSchemaPayload } from '@/lib/types';
import {
  DBHarnessCatalogEntity,
  DBHarnessCatalogField,
  DBHarnessCatalogOverview,
  DBHarnessCatalogSnapshot,
  DBHarnessSemanticEntity,
  DBHarnessSemanticField,
  DBHarnessSemanticOverview,
  DBHarnessSemanticSnapshot,
  DatabaseMetricViewMap,
} from '../core/types';
import {
  dedupeStrings,
  isDateLikeType,
  isNumericType,
  isTextLikeType,
  scoreTextByKeywords,
  truncateText,
} from '../core/utils';

function inferSemanticRole(
  column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number],
  metric: DatabaseMetricViewMap[string]['fields'][string] | undefined
): DBHarnessCatalogField['semanticRole'] {
  const metricType = (metric?.metricType || '').toLowerCase();
  const calcMode = (metric?.calcMode || '').toLowerCase();
  const name = column.name.toLowerCase();

  if (metricType.includes('时间') || metricType.includes('time') || isDateLikeType(column.type)) {
    return 'time';
  }
  if (
    column.isPrimary
    || metricType.includes('标识')
    || metricType.includes('id')
    || /(^id$|_id$|uuid|code$)/i.test(name)
  ) {
    return 'identifier';
  }
  if (
    metricType.includes('度量')
    || metricType.includes('指标')
    || metricType.includes('metric')
    || calcMode.includes('求和')
    || calcMode.includes('平均')
    || calcMode.includes('计数')
    || calcMode.includes('count')
    || isNumericType(column.type)
  ) {
    return 'metric';
  }
  if (metricType.includes('维度') || metricType.includes('dimension') || isTextLikeType(column.type)) {
    return 'dimension';
  }
  return 'attribute';
}

function buildCatalogField(
  tableName: string,
  column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number],
  metricMappings: DatabaseMetricViewMap
): DBHarnessCatalogField {
  const metric = metricMappings[tableName]?.fields?.[column.name];
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable !== false,
    isPrimary: column.isPrimary === true,
    comment: truncateText(column.comment, 80),
    semanticRole: inferSemanticRole(column, metric),
    referencesTable: column.referencesTable,
    referencesColumn: column.referencesColumn,
    aliases: dedupeStrings([
      metric?.metricName,
      ...(metric?.aliases || []),
      column.comment,
    ], 36).slice(0, 6),
  };
}

function buildCatalogEntity(
  collection: DatabaseSchemaPayload['collections'][number],
  metricMappings: DatabaseMetricViewMap
): DBHarnessCatalogEntity {
  const fields = (collection.columns || []).map((column) => buildCatalogField(collection.name, column, metricMappings));

  return {
    name: collection.name,
    description: truncateText(metricMappings[collection.name]?.description, 120),
    fieldCount: fields.length,
    primaryKeys: fields.filter((field) => field.isPrimary).map((field) => field.name),
    relatedEntities: dedupeStrings(
      fields.flatMap((field) => (field.referencesTable ? [field.referencesTable] : [])),
      80
    ),
    fields,
  };
}

export function deriveCatalogSnapshot(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap
): DBHarnessCatalogSnapshot {
  const entities = schema.collections
    .filter((collection) => collection.category === 'table')
    .map((collection) => buildCatalogEntity(collection, metricMappings));

  return {
    engine: schema.engine,
    entityCount: entities.length,
    relationCount: entities.reduce((sum, entity) => sum + entity.relatedEntities.length, 0),
    entities,
  };
}

function buildSemanticField(
  tableName: string,
  column: NonNullable<DatabaseSchemaPayload['collections'][number]['columns']>[number],
  metricMappings: DatabaseMetricViewMap
): DBHarnessSemanticField {
  const metric = metricMappings[tableName]?.fields?.[column.name];
  return {
    table: tableName,
    column: column.name,
    metricName: metric?.metricName || column.comment || column.name,
    description: truncateText(metric?.description || column.comment, 120),
    metricType: metric?.metricType,
    calcMode: metric?.calcMode,
    enableForNer: metric?.enableForNer === true,
    aliases: dedupeStrings(metric?.aliases || [], 40),
    semanticRole: inferSemanticRole(column, metric),
    derivedFrom: metric ? 'mapping' : 'schema',
  };
}

function buildSemanticEntity(
  collection: DatabaseSchemaPayload['collections'][number],
  metricMappings: DatabaseMetricViewMap
): DBHarnessSemanticEntity {
  const description = truncateText(metricMappings[collection.name]?.description, 120);
  const fields = (collection.columns || []).map((column) => buildSemanticField(collection.name, column, metricMappings));

  return {
    table: collection.name,
    description,
    metrics: fields.filter((field) => field.semanticRole === 'metric').map((field) => field.metricName).slice(0, 10),
    dimensions: fields.filter((field) => field.semanticRole === 'dimension').map((field) => field.metricName).slice(0, 10),
    timeFields: fields.filter((field) => field.semanticRole === 'time').map((field) => field.metricName).slice(0, 8),
    identifierFields: fields.filter((field) => field.semanticRole === 'identifier').map((field) => field.metricName).slice(0, 8),
    nerEnabledFields: fields.filter((field) => field.enableForNer).map((field) => field.metricName).slice(0, 12),
    fields,
  };
}

export function deriveSemanticSnapshot(
  schema: DatabaseSchemaPayload,
  metricMappings: DatabaseMetricViewMap
): DBHarnessSemanticSnapshot {
  const entities = schema.collections
    .filter((collection) => collection.category === 'table')
    .map((collection) => buildSemanticEntity(collection, metricMappings));

  const fields = entities.flatMap((entity) => entity.fields);
  return {
    entityCount: entities.length,
    configuredFieldCount: fields.filter((field) => field.derivedFrom === 'mapping').length,
    inferredFieldCount: fields.filter((field) => field.derivedFrom === 'schema').length,
    glossary: dedupeStrings(
      fields.flatMap((field) => [field.metricName, ...field.aliases]),
      48
    ).slice(0, 120),
    entities,
  };
}

export function buildCatalogOverview(snapshot: DBHarnessCatalogSnapshot, keywords: Set<string>): DBHarnessCatalogOverview {
  const entities = snapshot.entities
    .map((entity) => ({
      score: scoreTextByKeywords(entity.name, keywords)
        + scoreTextByKeywords(entity.description, keywords)
        + entity.fields.reduce((sum, field) => (
          sum
          + scoreTextByKeywords(field.name, keywords)
          + scoreTextByKeywords(field.comment, keywords)
          + field.aliases.reduce((aliasSum, alias) => aliasSum + scoreTextByKeywords(alias, keywords), 0)
        ), 0),
      payload: {
        table: entity.name,
        description: entity.description,
        primaryKeys: entity.primaryKeys,
        relatedEntities: entity.relatedEntities,
        fields: entity.fields
          .slice()
          .sort((left, right) => (
            scoreTextByKeywords(right.name, keywords) - scoreTextByKeywords(left.name, keywords)
            || left.name.localeCompare(right.name)
          ))
          .slice(0, 8)
          .map((field) => ({
            name: field.name,
            type: field.type,
            semanticRole: field.semanticRole,
            comment: field.comment,
            aliases: field.aliases.slice(0, 3),
            referencesTable: field.referencesTable,
          })),
      },
    }))
    .sort((left, right) => right.score - left.score || left.payload.table.localeCompare(right.payload.table))
    .slice(0, 8)
    .map((item) => item.payload);

  return {
    engine: snapshot.engine,
    entityCount: snapshot.entityCount,
    relationCount: snapshot.relationCount,
    focusEntities: entities,
  };
}

export function buildSemanticOverview(snapshot: DBHarnessSemanticSnapshot, keywords: Set<string>): DBHarnessSemanticOverview {
  const entities = snapshot.entities
    .map((entity) => ({
      score: scoreTextByKeywords(entity.table, keywords)
        + scoreTextByKeywords(entity.description, keywords)
        + entity.fields.reduce((sum, field) => (
          sum
          + scoreTextByKeywords(field.metricName, keywords)
          + scoreTextByKeywords(field.description, keywords)
          + field.aliases.reduce((aliasSum, alias) => aliasSum + scoreTextByKeywords(alias, keywords), 0)
          + (field.enableForNer ? 1 : 0)
        ), 0),
      payload: {
        table: entity.table,
        description: entity.description,
        metrics: entity.metrics.slice(0, 6),
        dimensions: entity.dimensions.slice(0, 6),
        timeFields: entity.timeFields.slice(0, 4),
        nerEnabledFields: entity.nerEnabledFields.slice(0, 8),
      },
    }))
    .sort((left, right) => right.score - left.score || left.payload.table.localeCompare(right.payload.table))
    .slice(0, 8)
    .map((item) => item.payload);

  return {
    entityCount: snapshot.entityCount,
    configuredFieldCount: snapshot.configuredFieldCount,
    inferredFieldCount: snapshot.inferredFieldCount,
    focusEntities: entities,
  };
}
