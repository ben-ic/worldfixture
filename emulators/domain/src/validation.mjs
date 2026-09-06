export class DomainError extends Error {
  constructor(status, code, message, field) { super(message); this.status = status; this.code = code; this.field = field; }
}
const invalid = (field, message) => { throw new DomainError(400, 'validation_error', message, field); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredFields = {
  'commerce.products': ['name', 'price_cents', 'currency', 'status'],
  'commerce.orders': ['shopper_id', 'currency', 'items', 'subtotal_cents', 'total_cents', 'status'],
  'social.posts': ['author_id', 'title', 'body'],
  'social.reviews': ['author_id', 'product_id', 'rating', 'body'],
  'social.comments': ['author_id', 'parent_id', 'parent_kind', 'body'],
  'work.projects': ['name', 'owner_id'],
  'work.tasks': ['title', 'project_id', 'assignee_id', 'reporter_id', 'status'],
  'work.time_entries': ['task_id', 'person_id', 'minutes', 'date'],
  'support.cases': ['title', 'customer_id', 'contact_id', 'owner_id'],
};
export const WRITABLE_COLLECTIONS = Object.freeze(Object.keys(requiredFields));
const states = {
  'commerce.products': ['active', 'preorder', 'sold-out', 'retired'],
  'commerce.orders': ['placed', 'packed', 'shipped', 'delivered', 'returned', 'refunded', 'cancelled'],
};
const strings = new Set(['name', 'title', 'body', 'description', 'summary', 'sku', 'category', 'collection', 'status', 'state', 'priority', 'channel', 'number', 'shipping_city', 'note', 'next_action', 'parent_kind']);
const references = {
  author_id: 'identity.people', shopper_id: 'identity.people', owner_id: 'identity.people', assignee_id: 'identity.people',
  reporter_id: 'identity.people', person_id: 'identity.people', contact_id: 'identity.people', organization_id: 'identity.organizations',
  customer_id: 'finance.customers', supplier_id: 'finance.suppliers', project_id: 'work.projects', task_id: 'work.tasks',
  product_id: 'commerce.products', order_id: 'commerce.orders', invoice_id: 'finance.invoices', payment_id: 'finance.payments',
};
const referenceArrays = {member_ids: 'identity.people', product_ids: 'commerce.products', to_ids: 'identity.people'};

export function referenceEdges(collection, record) {
  const edges = [];
  function walk(value, path = '') {
    if (Array.isArray(value)) { value.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return; }
    if (!object(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const field = path ? `${path}.${key}` : key;
      if (references[key] && typeof item === 'string') edges.push({collection: key === 'owner_id' && collection === 'software.repositories' ? 'identity.organizations' : references[key], id: item, field});
      if (referenceArrays[key] && Array.isArray(item)) item.forEach((id, index) => edges.push({collection: referenceArrays[key], id, field: `${field}[${index}]`}));
      if (key === 'parent_id' && collection === 'social.comments' && typeof item === 'string') edges.push({collection: value.parent_kind === 'post' ? 'social.posts' : 'social.reviews', id: item, field});
      walk(item, field);
    }
  }
  walk(record);
  return edges;
}

function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(field, `${field} must be an integer of at least ${minimum} within the safe integer range`);
}
function inspectTypes(value, path = '') {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) invalid(path, `${path} cannot be represented as a finite safe JSON number`);
  if (Array.isArray(value)) { value.forEach((item, index) => inspectTypes(item, `${path}[${index}]`)); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid(field, 'Reserved object keys are not allowed');
    if (strings.has(key) && typeof item !== 'string') invalid(field, `${field} must be a string`);
    if (key.endsWith('_id') && item !== null && (typeof item !== 'string' || !item)) invalid(field, `${field} must be a nonempty string or null`);
    if (key.endsWith('_ids') || ['tags', 'labels'].includes(key)) {
      if (!Array.isArray(item) || item.some(entry => typeof entry !== 'string' || !entry)) invalid(field, `${field} must be an array of nonempty strings`);
      if (new Set(item).size !== item.length) invalid(field, `${field} contains duplicate values`);
    }
    if (key.endsWith('_cents')) integer(item, field);
    if (key === 'currency' && (typeof item !== 'string' || !/^[a-z]{3}$/i.test(item))) invalid(field, `${field} must be a three-letter currency code`);
    if (key === 'verified_buyer' && typeof item !== 'boolean') invalid(field, `${field} must be a boolean`);
    if ((key.endsWith('_on') || key === 'date') && item !== null) {
      if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item) || !Number.isFinite(Date.parse(item)) || new Date(item).toISOString().slice(0, 10) !== item) invalid(field, `${field} must be a valid ISO date`);
    }
    if (key.endsWith('_at') && item !== null) {
      if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(item) || !Number.isFinite(Date.parse(item))) invalid(field, `${field} must be an ISO timestamp with a timezone`);
      const day = item.slice(0, 10);
      if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) invalid(field, `${field} must contain a valid calendar date`);
    }
    inspectTypes(item, field);
  }
}

export function validateRecord(collection, record, get) {
  if (!WRITABLE_COLLECTIONS.includes(collection)) throw new DomainError(403, 'read_only_collection', `${collection} is a read-only canonical seed view`);
  if (!object(record)) invalid('record', 'record must be an object');
  if (typeof record.id !== 'string' || !/^[a-z][a-z0-9.-]+$/.test(record.id) || record.id.length > 512) invalid('id', 'id must be a canonical record ID containing lowercase letters, digits, dots or hyphens');
  for (const field of requiredFields[collection]) if (record[field] === undefined || record[field] === null || record[field] === '') invalid(field, `${field} is required`);
  inspectTypes(record);
  if (states[collection] && !states[collection].includes(record.status)) invalid('status', `status is invalid for ${collection}`);
  if (collection === 'social.comments' && !['post', 'review'].includes(record.parent_kind)) invalid('parent_kind', 'parent_kind must be post or review');
  for (const edge of referenceEdges(collection, record)) if (!get(edge.collection, edge.id)) invalid(edge.field, `${edge.field} refers to missing ${edge.collection} record ${edge.id}`);
  if (collection === 'commerce.products') integer(record.price_cents, 'price_cents', 1);
  if (collection === 'commerce.orders') {
    if (!Array.isArray(record.items) || !record.items.length) invalid('items', 'items must be a nonempty array');
    let subtotal = 0n;
    record.items.forEach((item, index) => {
      const field = `items[${index}]`;
      if (!object(item)) invalid(field, `${field} must be an object`);
      integer(item.quantity, `${field}.quantity`, 1); integer(item.unit_amount_cents, `${field}.unit_amount_cents`, 1);
      const product = get('commerce.products', item.product_id);
      if (!product) invalid(`${field}.product_id`, 'Each order item must name an existing product');
      if (product.currency?.toUpperCase() !== record.currency.toUpperCase()) invalid('currency', 'Order and product currencies must match');
      subtotal += BigInt(item.quantity) * BigInt(item.unit_amount_cents);
    });
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER) || subtotal !== BigInt(record.subtotal_cents)) invalid('subtotal_cents', 'subtotal_cents must equal the sum of item quantity times unit amount');
    const total = subtotal + BigInt(record.shipping_cents ?? 0) - BigInt(record.discount_cents ?? 0);
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER) || total !== BigInt(record.total_cents)) invalid('total_cents', 'total_cents must equal subtotal plus shipping minus discount');
  }
  if (collection === 'social.reviews') {
    integer(record.rating, 'rating', 1); if (record.rating > 5) invalid('rating', 'rating must be from 1 through 5');
    if (record.order_id) {
      const order = get('commerce.orders', record.order_id);
      if (order.shopper_id !== record.author_id || !order.items?.some(item => item.product_id === record.product_id)) invalid('order_id', 'The review order must belong to its author and contain its product');
    }
  }
  if (collection === 'work.time_entries') integer(record.minutes, 'minutes', 1);
  if (record.start_on && record.target_on && record.target_on < record.start_on) invalid('target_on', 'target_on cannot precede start_on');
  return record;
}

export function validateEnvelope(value, operation) {
  if (!object(value)) invalid('body', 'Request body must be an object');
  const allowed = new Set(['actor_id', ...(operation === 'create' ? ['record'] : operation === 'update' ? ['patch', 'expected_version'] : ['expected_version'])]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(key, `Unknown request field ${key}`);
  if (typeof value.actor_id !== 'string' || !value.actor_id) invalid('actor_id', 'actor_id must explicitly name a world person');
  if (value.expected_version !== undefined) integer(value.expected_version, 'expected_version', 1);
  const field = operation === 'create' ? 'record' : operation === 'update' ? 'patch' : null;
  if (field && !object(value[field])) invalid(field, `${field} must be an object`);
}
