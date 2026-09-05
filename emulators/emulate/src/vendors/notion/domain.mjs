import { DatabaseSync } from "node:sqlite";

const COLLECTIONS = {
  users: "notion_users",
  pages: "notion_pages",
  blocks: "notion_blocks",
  databases: "notion_databases",
  dataSources: "notion_data_sources",
  views: "notion_views",
  viewQueries: "notion_view_queries",
  comments: "notion_comments",
  fileUploads: "notion_file_uploads",
  folders: "notion_folders",
  asyncTasks: "notion_async_tasks",
  changes: "notion_changes",
  oauthClients: "notion_oauth_clients",
  oauthCodes: "notion_oauth_codes",
  oauthTokens: "notion_oauth_tokens",
  customEmojis: "notion_custom_emojis",
  teamspaces: "notion_teamspaces",
};

const DEFAULT_TIME = "2026-09-03T09:00:00.000Z";

const CREATABLE_BLOCK_TYPES = new Set([
  "audio", "bookmark", "breadcrumb", "bulleted_list_item", "callout", "code", "column", "column_list",
  "divider", "embed", "equation", "file", "heading_1", "heading_2", "heading_3", "heading_4", "image", "link_to_page",
  "numbered_list_item", "paragraph", "pdf", "quote", "synced_block", "table",
  "table_of_contents", "table_row", "tab", "template", "to_do", "toggle", "video",
]);

const CHILD_BLOCK_TYPES = new Set([
  "bulleted_list_item", "callout", "column", "column_list", "meeting_notes", "numbered_list_item", "paragraph",
  "quote", "synced_block", "table", "tab", "template", "to_do", "toggle",
]);

function blockChildren(input) {
  const type = input?.type ?? "paragraph";
  return input?.children ?? input?.[type]?.children ?? [];
}

function blockValue(input, type) {
  const value = structuredClone(input?.[type] ?? { rich_text: richText(input?.text ?? ""), color: "default" });
  if (value && typeof value === "object") delete value.children;
  return value;
}

function allowsBlockChildren(type, value) {
  if (CHILD_BLOCK_TYPES.has(type)) return true;
  return type.startsWith("heading_") && value?.is_toggleable === true;
}

function validUrl(value) {
  if (typeof value !== "string") return false;
  try { return Boolean(new URL(value)); } catch { return false; }
}

function validateBlockInput(input, { parentType = null, depth = 0, seedSyntax = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Each child must be a block object.";
  const type = input.type ?? "paragraph";
  if (!CREATABLE_BLOCK_TYPES.has(type)) {
    if (["child_database", "child_page"].includes(type)) return `${type} blocks must be created with the matching database or page endpoint.`;
    return `${type} is not a creatable block type.`;
  }
  if (!Object.hasOwn(input, type) && !(seedSyntax && Object.hasOwn(input, "text"))) return `${type} is required for a ${type} block.`;
  if (Object.hasOwn(input, "children") && !seedSyntax) return `Child blocks must be supplied in ${type}.children.`;
  const value = blockValue(input, type);
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${type} must be an object.`;
  const children = blockChildren(input);
  if (!Array.isArray(children)) return `${type}.children must be an array.`;
  if (children.length > 100) return "A block can contain no more than 100 child blocks in one request.";
  if (children.length && !allowsBlockChildren(type, value)) return `${type} blocks cannot contain child blocks.`;
  if (depth >= 2 && children.length) return "A request can contain no more than two levels of nested child blocks.";
  if (parentType === "column_list" && type !== "column") return "A column_list can contain only column blocks.";
  if (parentType === "column" && type === "column") return "A column cannot contain another column.";
  if (parentType === "table" && type !== "table_row") return "A table can contain only table_row blocks.";
  if (parentType === "tab" && type !== "paragraph") return "A tab can contain only paragraph blocks.";
  if (type === "column" && parentType !== "column_list") return "A column can only be a child of a column_list.";
  if (type === "table_row" && parentType !== "table") return "A table_row can only be a child of a table.";
  if (type === "column_list") {
    if (children.length < 2 || children.some((child) => child?.type !== "column" || blockChildren(child).length < 1)) {
      return "A column_list must contain at least two columns, and each column must contain at least one child.";
    }
    const ratios = children.map((child) => child?.column?.width_ratio).filter((ratio) => ratio !== undefined);
    if (ratios.some((ratio) => typeof ratio !== "number" || ratio <= 0 || ratio >= 1) || ratios.length && Math.abs(ratios.reduce((sum, ratio) => sum + ratio, 0) - 1) > 0.000001) {
      return "Column width_ratio values must be between 0 and 1 and must add up to 1.";
    }
  }
  if (type === "table") {
    if (!Number.isInteger(value.table_width) || value.table_width < 1) return "table.table_width must be a positive integer.";
    if (children.length < 1 || children[0]?.type !== "table_row") return "A table must contain at least one table_row.";
    if (children.some((child) => child?.table_row?.cells?.length !== value.table_width)) return "Each table_row must have table_width cells.";
  }
  if (type === "table_row" && !Array.isArray(value.cells)) return "table_row.cells must be an array.";
  if (["column", "column_list", "table", "tab"].includes(type) && !Array.isArray(input[type]?.children)) return `${type}.children is required and must be an array.`;
  const richTextRequired = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "heading_4", "bulleted_list_item", "numbered_list_item", "quote", "to_do", "toggle", "template", "callout", "code"]);
  if (richTextRequired.has(type) && !Array.isArray(value.rich_text)) return `${type}.rich_text is required and must be an array.`;
  if (type === "code" && typeof value.language !== "string") return "code.language is required.";
  if (type === "equation" && typeof value.expression !== "string") return "equation.expression is required.";
  if (type === "synced_block" && !Object.hasOwn(value, "synced_from")) return "synced_block.synced_from is required.";
  if (type === "link_to_page") {
    const idField = { page_id: "page_id", database_id: "database_id", comment_id: "comment_id" }[value.type];
    if (!idField || typeof value[idField] !== "string") return "link_to_page must contain a supported type and matching ID.";
  }
  for (const field of ["rich_text", "caption"]) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > 100)) return `${type}.${field} must contain no more than 100 rich text objects.`;
  }
  if (["bookmark", "link_preview"].includes(type) && !validUrl(value.url)) return `${type}.url must be a valid URL.`;
  if (["audio", "file", "image", "pdf", "video"].includes(type)) {
    const choices = Number(Boolean(value.external)) + Number(Boolean(value.file_upload));
    const fileType = value.type ?? (value.external ? "external" : value.file_upload ? "file_upload" : null);
    if (choices !== 1 || !fileType || !["external", "file_upload"].includes(fileType) || !value[fileType]) return `${type} must identify exactly one external file or file upload.`;
    if (fileType === "external" && !validUrl(value.external?.url)) return `${type}.external.url must be a valid URL.`;
    if (fileType === "file_upload" && typeof value.file_upload?.id !== "string") return `${type}.file_upload.id is required.`;
  }
  if (type === "embed") {
    const choices = Number(typeof value.url === "string") + Number(typeof value.file_upload?.id === "string");
    if (choices !== 1 || value.url && !validUrl(value.url)) return "embed must contain one valid url or file_upload.id.";
  }
  for (const child of children) {
    const error = validateBlockInput(child, { parentType: type, depth: depth + 1, seedSyntax });
    if (error) return error;
  }
  return null;
}

function collection(store, name, indexes) {
  return store.collection(COLLECTIONS[name], indexes);
}

function nextUuid(store, kind) {
  const key = `notion_uuid_counter_${kind}`;
  const prefix = { page: "10000000", block: "20000000", database: "30000000", data_source: "40000000", view: "50000000", view_query: "51000000", async_task: "70000000", comment: "80000000", file_upload: "90000000" }[kind] ?? "a0000000";
  const collectionName = { page: "pages", block: "blocks", database: "databases", data_source: "dataSources", view: "views", view_query: "viewQueries", async_task: "asyncTasks", comment: "comments", file_upload: "fileUploads" }[kind];
  let next = store.getData(key) ?? 0;
  let id;
  do {
    next += 1;
    id = `${prefix}-0000-4000-8000-${String(next).padStart(12, "0")}`;
  } while (collectionName && collection(store, collectionName).findOneBy("notion_id", id));
  store.setData(key, next);
  return id;
}

function now(store) {
  return store.getData("notion_clock") ?? DEFAULT_TIME;
}

function titleText(properties = {}) {
  for (const property of Object.values(properties)) {
    if (property?.type !== "title" || !Array.isArray(property.title)) continue;
    return property.title.map((part) => part?.plain_text ?? part?.text?.content ?? "").join("");
  }
  return "";
}

function normalizeId(value) {
  const text = String(value ?? "");
  const dashed = text.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
  if (dashed) return dashed.toLowerCase();
  const compact = text.match(/[0-9a-f]{32}/i)?.[0]?.toLowerCase();
  return compact ? `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}` : text;
}

function canRead(record, actor) {
  return Boolean(record && actor && (!Array.isArray(record.accessible_by) || record.accessible_by.length === 0 || record.accessible_by.includes(actor.notion_id)));
}

function dateInRange(value, range) {
  if (!range) return true;
  const day = String(value ?? "").slice(0, 10);
  return (!range.start_date || day >= range.start_date) && (!range.end_date || day < range.end_date);
}

function plainBlockText(block) {
  return block?.value?.rich_text?.map((part) => part.plain_text ?? part.text?.content ?? "").join("") ?? "";
}

function richText(content) {
  return [{
    type: "text",
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: content,
    href: null,
  }];
}

function asRichText(value, fallback = "") {
  if (Array.isArray(value)) return value.map((item) => {
    const result = structuredClone(item);
    result.annotations = {
      bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default",
      ...(result.annotations ?? {}),
    };
    if (result.type === "text") {
      result.text = { content: String(result.text?.content ?? ""), link: result.text?.link ?? null };
      result.plain_text ??= result.text.content;
      result.href ??= result.text.link?.url ?? null;
    } else {
      result.plain_text ??= result.equation?.expression ?? result.mention?.page?.id ?? result.mention?.database?.id ?? "";
      result.href ??= null;
    }
    return result;
  });
  return richText(String(value ?? fallback));
}

function responseProperties(properties = {}) {
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    if (typeof property === "string") return [name, { id: name === "Name" ? "title" : name, type: name === "Name" ? "title" : "rich_text", [name === "Name" ? "title" : "rich_text"]: richText(property) }];
    if (typeof property === "number") return [name, { id: name, type: "number", number: property }];
    if (typeof property === "boolean") return [name, { id: name, type: "checkbox", checkbox: property }];
    const result = structuredClone(property ?? {});
    result.id ??= name === "Name" || result.type === "title" ? "title" : name;
    const type = result.type ?? Object.keys(result).find((key) => key !== "id") ?? "rich_text";
    result.type = type;
    if (["title", "rich_text"].includes(type)) result[type] = asRichText(result[type] ?? []);
    return [name, result];
  }));
}

function responseSchema(properties = {}) {
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const result = structuredClone(property ?? {});
    const type = result.type ?? Object.keys(result).find((key) => !["id", "name", "description"].includes(key)) ?? "rich_text";
    result.id ??= type === "title" ? "title" : name;
    result.name ??= name;
    result.description ??= null;
    result.type = type;
    if (type === "status") result.status = { options: [], groups: [], ...(result.status ?? {}) };
    else if (["select", "multi_select"].includes(type)) result[type] = { options: [], ...(result[type] ?? {}) };
    else if (type === "number") result.number = { format: "number", ...(result.number ?? {}) };
    else result[type] ??= {};
    return [name, result];
  }));
}

function responseBlockValue(type, input = {}) {
  const value = structuredClone(input ?? {});
  if (Array.isArray(value.rich_text)) value.rich_text = asRichText(value.rich_text);
  if (Array.isArray(value.caption)) value.caption = asRichText(value.caption);
  if (Array.isArray(value.title)) value.title = asRichText(value.title);
  if (Array.isArray(value.cells)) value.cells = value.cells.map((cell) => asRichText(cell));
  if (["paragraph", "bulleted_list_item", "numbered_list_item", "quote", "toggle", "to_do", "callout"].includes(type)) {
    value.rich_text ??= [];
    value.color ??= "default";
  }
  if (["paragraph", "callout"].includes(type)) value.icon ??= null;
  if (type === "to_do") value.checked ??= false;
  if (type.startsWith("heading_")) {
    value.rich_text ??= [];
    value.color ??= "default";
    value.is_toggleable ??= false;
  }
  if (type === "code") {
    value.rich_text ??= [];
    value.caption ??= [];
    value.language ??= "plain text";
  }
  if (["bookmark", "embed", "audio", "file", "image", "pdf", "video"].includes(type)) value.caption ??= [];
  if (type === "table") {
    value.has_column_header ??= false;
    value.has_row_header ??= false;
  }
  if (type === "table_of_contents") value.color ??= "default";
  if (type === "template") value.rich_text ??= [];
  if (type === "synced_block") value.synced_from ??= null;
  return value;
}

function listResult(results, type, nextCursor = null) {
  return { object: "list", results, next_cursor: nextCursor, has_more: nextCursor !== null, type, [type]: {} };
}

function pageProperties(title, properties) {
  if (properties && Object.keys(properties).length > 0) return structuredClone(properties);
  return { title: { id: "title", type: "title", title: richText(title ?? "Untitled") } };
}

function publicUser(user) {
  const result = {
    object: "user",
    id: user.notion_id,
    type: user.type,
    name: user.name,
    avatar_url: user.avatar_url ?? null,
  };
  if (user.type === "person") result.person = { email: user.email };
  else result.bot = { owner: { type: "workspace", workspace: true }, workspace_name: user.workspace_name };
  return result;
}

function publicPage(page, parentDataSource = null, baseUrl = null) {
  const parent = structuredClone(page.parent);
  if (parent?.type === "data_source_id") parent.database_id ??= parentDataSource?.database_id;
  return {
    object: "page",
    id: page.notion_id,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    created_by: { object: "user", id: page.created_by },
    last_edited_by: { object: "user", id: page.last_edited_by },
    cover: page.cover ?? null,
    icon: page.icon ?? null,
    parent,
    in_trash: page.in_trash,
    is_archived: Boolean(page.in_trash),
    is_locked: Boolean(page.is_locked),
    properties: responseProperties(page.properties),
    // A restored snapshot can contain the origin of an earlier run. Notion's
    // real Page object returns a current web-application URL, so calculate this
    // response field from the advertised origin and stable page ID.
    url: baseUrl ? `${baseUrl}/notion/${page.notion_id.replaceAll("-", "")}` : page.url,
    public_url: page.public_url ?? null,
  };
}

function publicBlock(block) {
  const result = {
    object: "block",
    id: block.notion_id,
    parent: structuredClone(block.parent),
    created_time: block.created_time,
    last_edited_time: block.last_edited_time,
    created_by: { object: "user", id: block.created_by },
    last_edited_by: { object: "user", id: block.last_edited_by },
    has_children: block.has_children,
    in_trash: block.in_trash,
    type: block.type,
  };
  result[block.type] = responseBlockValue(block.type, block.value);
  return result;
}

function publicDatabase(database, sources = []) {
  return {
    object: "database", id: database.notion_id,
    created_time: database.created_time, last_edited_time: database.last_edited_time,
    title: asRichText(database.title), description: asRichText(database.description),
    icon: database.icon ?? null, cover: database.cover ?? null, is_inline: Boolean(database.is_inline),
    database_type: database.database_type ?? null,
    parent: structuredClone(database.parent), url: database.url, public_url: database.public_url ?? null,
    in_trash: Boolean(database.in_trash),
    is_locked: Boolean(database.is_locked),
    data_sources: sources.map((source) => ({ id: source.notion_id, name: source.name })),
  };
}

function publicDataSource(source, database = null) {
  return {
    object: "data_source", id: source.notion_id,
    created_time: source.created_time, last_edited_time: source.last_edited_time,
    created_by: { object: "user", id: source.created_by }, last_edited_by: { object: "user", id: source.last_edited_by },
    title: asRichText(source.title ?? source.name), description: asRichText(source.description),
    icon: source.icon ?? null, parent: { type: "database_id", database_id: source.database_id },
    cover: source.cover ?? null, is_inline: Boolean(source.is_inline), database_type: source.database_type ?? null,
    database_parent: structuredClone(source.database_parent ?? database?.parent ?? { type: "workspace", workspace: true }), properties: responseSchema(source.properties),
    url: source.url?.startsWith("collection://") || !source.url ? `https://www.notion.so/${source.notion_id.replaceAll("-", "")}` : source.url,
    public_url: source.public_url ?? null,
    in_trash: Boolean(source.in_trash),
  };
}

function publicView(view) {
  return {
    object: "view", id: view.notion_id, name: view.name,
    parent: { type: "database_id", database_id: view.database_id }, type: view.type,
    created_time: view.created_time, last_edited_time: view.last_edited_time, url: view.url,
    data_source_id: view.data_source_id,
    filter: structuredClone(view.filter ?? null), sorts: structuredClone(view.sorts ?? []),
    quick_filters: structuredClone(view.quick_filters ?? {}), configuration: view.configuration?.type ? structuredClone(view.configuration) : null,
    ...(view.dashboard_parent_view_id ? { dashboard_view_id: view.dashboard_parent_view_id, dashboard_parent_view_id: view.dashboard_parent_view_id } : {}),
  };
}

function publicComment(comment, uploads = null, baseUrl = "") {
  const displayName = comment.display_name?.type === "custom"
    ? { type: "custom", resolved_name: comment.display_name.resolved_name ?? comment.display_name.custom?.name ?? null }
    : { type: comment.display_name?.type ?? "user", resolved_name: comment.display_name?.resolved_name ?? null };
  const attachments = (comment.attachments ?? []).map((attachment) => {
    if (attachment.file?.url) return structuredClone(attachment);
    const upload = uploads?.findOneBy("notion_id", normalizeId(attachment.file_upload_id));
    const contentType = upload?.content_type ?? "application/octet-stream";
    const category = contentType.startsWith("audio/") ? "audio" : contentType.startsWith("image/") ? "image" : contentType === "application/pdf" ? "pdf" : contentType.startsWith("video/") ? "video" : "productivity";
    return { category, file: { url: `${baseUrl}/v1/file_uploads/${upload?.notion_id ?? attachment.file_upload_id}/content`, expiry_time: upload?.expiry_time ?? null } };
  });
  return {
    object: "comment", id: comment.notion_id, parent: structuredClone(comment.parent), discussion_id: comment.discussion_id,
    created_time: comment.created_time, last_edited_time: comment.last_edited_time,
    created_by: { object: "user", id: comment.created_by }, rich_text: asRichText(comment.rich_text),
    attachments,
    display_name: displayName,
    original_content_deleted: Boolean(comment.original_content_deleted),
  };
}

function publicFileUpload(upload, baseUrl) {
  const result = {
    object: "file_upload", id: upload.notion_id, created_time: upload.created_time,
    created_by: { id: upload.created_by, type: "person" }, last_edited_time: upload.last_edited_time,
    in_trash: false, expiry_time: upload.expiry_time, status: upload.status,
    filename: upload.filename ?? null, content_type: upload.content_type ?? null,
    content_length: upload.content_length ?? null,
    number_of_parts: { total: upload.number_of_parts, sent: upload.sent_parts.length },
  };
  if (upload.status === "pending" && upload.mode !== "external_url") {
    result.upload_url = `${baseUrl}/v1/file_uploads/${upload.notion_id}/send`;
    if (upload.mode === "multi_part") result.complete_url = `${baseUrl}/v1/file_uploads/${upload.notion_id}/complete`;
  }
  if (upload.file_import_result) result.file_import_result = structuredClone(upload.file_import_result);
  return result;
}

export function createNotionDomain(store, baseUrl, { objectStore, onChange } = {}) {
  const users = collection(store, "users", ["notion_id", "email"]);
  const pages = collection(store, "pages", ["notion_id"]);
  const blocks = collection(store, "blocks", ["notion_id", "parent_id"]);
  const databases = collection(store, "databases", ["notion_id"]);
  const dataSources = collection(store, "dataSources", ["notion_id", "database_id"]);
  const views = collection(store, "views", ["notion_id", "database_id", "data_source_id"]);
  const viewQueries = collection(store, "viewQueries", ["notion_id", "view_id", "actor_id"]);
  const comments = collection(store, "comments", ["notion_id", "discussion_id", "parent_id", "created_by"]);
  const fileUploads = collection(store, "fileUploads", ["notion_id", "created_by", "status"]);
  const folders = collection(store, "folders", ["notion_id", "owner_page_id", "parent_folder_id"]);
  const asyncTasks = collection(store, "asyncTasks", ["notion_id", "actor_id"]);
  const changes = collection(store, "changes", ["sequence", "object_id"]);
  const oauthTokens = collection(store, "oauthTokens", ["token", "refresh_token"]);
  const customEmojis = collection(store, "customEmojis", ["notion_id", "name"]);
  const teamspaces = collection(store, "teamspaces", ["notion_id", "name"]);
  const renderPage = (record) => publicPage(
    record,
    record?.parent?.type === "data_source_id" ? dataSources.findOneBy("notion_id", normalizeId(record.parent.data_source_id)) : null,
    baseUrl,
  );
  const renderDataSource = (record) => publicDataSource(record, databases.findOneBy("notion_id", normalizeId(record?.database_id)));
  const renderComment = (record) => publicComment(record, fileUploads, baseUrl);

  function normalizeIcon(icon) {
    if (!icon || icon.type !== "custom_emoji") return structuredClone(icon ?? null);
    const id = normalizeId(icon.custom_emoji?.id);
    const emoji = customEmojis.findOneBy("notion_id", id);
    return emoji ? { type: "custom_emoji", custom_emoji: { id: emoji.notion_id, name: emoji.name, url: emoji.url } } : null;
  }

  function listCustomEmojis({ name, startCursor, pageSize = 100 } = {}) {
    const all = customEmojis.all().filter((emoji) => name === undefined || emoji.name === name);
    const start = startCursor ? all.findIndex((emoji) => emoji.notion_id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = all.slice(start, start + pageSize);
    const response = listResult(selected.map((emoji) => ({ id: emoji.notion_id, name: emoji.name, url: emoji.url })), "custom_emoji", start + pageSize < all.length ? selected.at(-1)?.notion_id ?? null : null);
    delete response.custom_emoji;
    return response;
  }

  function userByLogin(login) {
    return users.findOneBy("email", login) ?? users.all().find((user) => user.name === login);
  }

  function user(id) {
    const value = id === "me" ? undefined : users.findOneBy("notion_id", id);
    return value ? publicUser(value) : null;
  }

  // The caller validates `pageSize`, exactly as it does for every sibling reader
  // in this file. This used to take the raw query value and coerce it with
  // `Number(pageSize) || 100`, so `?page_size=0` and `?page_size=abc` both meant
  // "all of them" -- measured against a running fixture, 99 users for a request
  // that asked for none. It was also the one reader with no invalid-cursor guard:
  // `findIndex` returning -1 became index 0, so an unknown `start_cursor`
  // re-served page one instead of the `start_cursor is not valid.` its siblings
  // answer.
  function listUsers({ startCursor, pageSize = 100 } = {}) {
    const all = users.all();
    const start = startCursor ? all.findIndex((item) => item.notion_id === startCursor) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = all.slice(start, start + pageSize);
    return {
      object: "list",
      results: selected.map(publicUser),
      next_cursor: start + pageSize < all.length ? selected.at(-1)?.notion_id ?? null : null,
      has_more: start + pageSize < all.length,
      type: "user",
      user: {},
    };
  }

  function page(id, actor) {
    const value = pages.findOneBy("notion_id", normalizeId(id));
    return value && (!actor || canRead(value, actor)) ? renderPage(value) : null;
  }

  function pageProperty(id, propertyId, { startCursor, pageSize = 100, actor } = {}) {
    const record = pages.findOneBy("notion_id", normalizeId(id));
    if (!canRead(record, actor)) return null;
    const entry = Object.entries(record.properties ?? {}).find(([name, property]) => name === propertyId || String(property?.id) === String(propertyId));
    if (!entry) return null;
    const property = structuredClone(entry[1]);
    const type = property.type ?? Object.keys(property).find((key) => key !== "id");
    const value = property[type];
    if (Array.isArray(value)) {
      const cursorPrefix = `${property.id ?? propertyId}:`;
      const indexedCursor = String(startCursor ?? "").startsWith(cursorPrefix) ? Number(String(startCursor).slice(cursorPrefix.length)) : null;
      const start = startCursor ? indexedCursor ?? value.findIndex((item) => String(item.id) === String(startCursor)) + 1 : 0;
      if (startCursor && (!Number.isInteger(start) || start < 1 || start > value.length)) return { invalid_cursor: true };
      const selected = value.slice(start, start + pageSize).map((item) => ({
        object: "property_item", id: property.id ?? propertyId, type,
        [type]: ["title", "rich_text"].includes(type) ? asRichText([item])[0] : structuredClone(item),
      }));
      const nextCursor = start + pageSize < value.length ? `${cursorPrefix}${start + pageSize}` : null;
      const metadata = type === "rollup" ? structuredClone(property.rollup) : {};
      return {
        object: "list", type: "property_item", results: selected, next_cursor: nextCursor, has_more: nextCursor !== null,
        property_item: { id: property.id ?? propertyId, type, [type]: metadata, next_url: nextCursor ? `${baseUrl}/v1/pages/${record.notion_id}/properties/${property.id ?? propertyId}?start_cursor=${encodeURIComponent(nextCursor)}` : null },
      };
    }
    return { object: "property_item", id: property.id ?? propertyId, type, [type]: structuredClone(value) };
  }

  function createPage(input, actor, { seedSyntax = false } = {}) {
    for (const child of input.children ?? []) {
      const error = validateBlockInput(child, { seedSyntax });
      if (error) return { validation_error: error };
    }
    const parent = normalizedParent(input.parent ?? { type: "workspace", workspace: true });
    const parentRecord = parent.type === "page_id" ? pages.findOneBy("notion_id", parent.page_id) : parent.type === "data_source_id" ? dataSources.findOneBy("notion_id", parent.data_source_id) : null;
    const templateType = input.template?.type;
    if (input.template && parent.type !== "data_source_id") return { validation_error: "template can only be used for a page in a data source." };
    if (input.template && !["none", "default", "template_id"].includes(templateType)) return { validation_error: "template.type must be none, default, or template_id." };
    if (["default", "template_id"].includes(templateType) && (input.children !== undefined || input.markdown !== undefined)) return { validation_error: "children and markdown cannot be used with a default or template_id template." };
    if (input.template?.timezone !== undefined) {
      try { new Intl.DateTimeFormat("en", { timeZone: input.template.timezone }).format(); }
      catch { return { validation_error: "template.timezone must be a valid IANA time zone." }; }
    }
    const templates = parentRecord?.templates ?? [];
    const selectedTemplate = templateType === "template_id"
      ? templates.find((template) => normalizeId(template.id ?? template.page_id) === normalizeId(input.template.template_id))
      : templateType === "default" ? templates.find((template) => template.is_default === true || template.default === true) : null;
    if (templateType === "template_id" && !selectedTemplate) return { validation_error: "template.template_id must identify a template in the parent data source." };
    const timestamp = now(store);
    const notionId = input.id ?? nextUuid(store, "page");
    const markdownLines = typeof input.markdown === "string" ? input.markdown.split("\n") : [];
    const markdownTitle = !input.title && !input.properties ? markdownLines[0]?.match(/^#\s+(.*)$/)?.[1] : null;
    if (markdownTitle) markdownLines.shift();
    const record = pages.insert({
      notion_id: notionId,
      created_time: input.created_time ?? input.last_edited_time ?? timestamp,
      last_edited_time: input.last_edited_time ?? timestamp,
      created_by: normalizeId(input.created_by ?? actor.notion_id),
      last_edited_by: normalizeId(input.last_edited_by ?? input.created_by ?? actor.notion_id),
      parent,
      properties: pageProperties(markdownTitle ?? input.title, input.properties),
      cover: input.cover ?? null,
      icon: normalizeIcon(input.icon),
      in_trash: false,
      url: `${baseUrl}/notion/${notionId.replaceAll("-", "")}`,
      public_url: null,
      accessible_by: structuredClone(input.accessible_by ?? parentRecord?.accessible_by ?? []),
      teamspace_id: input.teamspace_id ? normalizeId(input.teamspace_id) : null,
      verification: structuredClone(input.verification ?? null),
      is_skill: Boolean(input.is_skill),
      skill_description: input.skill_description ?? null,
      sidebar_section: input.sidebar_section ?? "private",
      favorited_by: structuredClone(input.favorited_by ?? []),
      last_viewed_by: structuredClone(input.last_viewed_by ?? {}),
    });
    const initialResponse = renderPage(record);
    for (const child of input.children ?? []) createBlock(record.notion_id, child, actor);
    for (const line of markdownLines) createBlock(record.notion_id, markdownBlock(line), actor);
    if (selectedTemplate) {
      const templatePage = pages.findOneBy("notion_id", normalizeId(selectedTemplate.page_id ?? selectedTemplate.id));
      const templateProperties = structuredClone(selectedTemplate.properties ?? templatePage?.properties ?? {});
      const callerProperties = structuredClone(record.properties);
      pages.update(record.id, {
        properties: { ...templateProperties, ...callerProperties },
        icon: input.icon ? normalizeIcon(input.icon) : normalizeIcon(selectedTemplate.icon ?? templatePage?.icon),
        cover: input.cover ?? structuredClone(selectedTemplate.cover ?? templatePage?.cover ?? null),
      });
      const asBlockInput = (sourceBlock) => {
        const childInput = { type: sourceBlock.type, [sourceBlock.type]: structuredClone(sourceBlock.value) };
        const nested = blocks.findBy("parent_id", sourceBlock.notion_id).filter((block) => !block.in_trash).sort((left, right) => left.position - right.position);
        if (nested.length) childInput.children = nested.map(asBlockInput);
        return childInput;
      };
      const cloneChildren = (sourceParentId, targetParentId) => {
        for (const sourceBlock of blocks.findBy("parent_id", sourceParentId).filter((block) => !block.in_trash).sort((left, right) => left.position - right.position)) createBlock(targetParentId, asBlockInput(sourceBlock), actor);
      };
      for (const child of selectedTemplate.children ?? []) createBlock(record.notion_id, child, actor);
      if (!selectedTemplate.children && templatePage) cloneChildren(templatePage.notion_id, record.notion_id);
      recordChange("page.template_applied", record.notion_id, actor.notion_id);
    }
    recordChange("page.created", record.notion_id, actor.notion_id, { parent: record.parent });
    return selectedTemplate ? initialResponse : renderPage(record);
  }

  function updatePage(id, input, actor) {
    const normalized = normalizeId(id);
    const current = pages.findOneBy("notion_id", normalized);
    if (!canRead(current, actor)) return null;
    if (input.erase_content) {
      for (const child of blocks.findBy("parent_id", normalized)) trashBlockTree(child.notion_id, actor);
    }
    const updated = pages.update(current.id, {
      properties: input.properties ? { ...current.properties, ...structuredClone(input.properties) } : current.properties,
      cover: Object.hasOwn(input, "cover") ? input.cover : current.cover,
      icon: Object.hasOwn(input, "icon") ? normalizeIcon(input.icon) : current.icon,
      in_trash: Object.hasOwn(input, "in_trash") ? Boolean(input.in_trash) : current.in_trash,
      is_locked: Object.hasOwn(input, "is_locked") ? Boolean(input.is_locked) : current.is_locked,
      is_skill: Object.hasOwn(input, "is_skill") ? Boolean(input.is_skill) : current.is_skill,
      skill_description: Object.hasOwn(input, "skill_description") ? input.skill_description : current.skill_description,
      last_edited_time: now(store),
      last_edited_by: actor.notion_id,
    });
    const topic = Object.hasOwn(input, "in_trash") && Boolean(input.in_trash) !== Boolean(current.in_trash)
      ? (input.in_trash ? "page.deleted" : "page.undeleted")
      : Object.hasOwn(input, "is_locked") && Boolean(input.is_locked) !== Boolean(current.is_locked)
        ? (input.is_locked ? "page.locked" : "page.unlocked")
        : "page.updated";
    recordChange(topic, normalized, actor.notion_id, {
      parent: updated.parent,
      ...(topic === "page.updated" ? { updated_properties: Object.keys(input.properties ?? {}).map((key) => current.properties?.[key]?.id ?? key) } : {}),
    });
    return renderPage(updated);
  }

  function movePage(id, parent, actor) {
    const normalized = normalizeId(id);
    const current = pages.findOneBy("notion_id", normalized);
    if (!canRead(current, actor) || !canUseParent(parent, actor)) return null;
    const updated = pages.update(current.id, { parent: normalizedParent(parent), last_edited_time: now(store), last_edited_by: actor.notion_id });
    recordChange("page.moved", normalized, actor.notion_id, { parent: updated.parent });
    return renderPage(updated);
  }

  function normalizedParent(parent) {
    if (parent?.type === "page_id" || parent?.page_id) return { type: "page_id", page_id: normalizeId(parent.page_id) };
    if (parent?.type === "data_source_id" || parent?.data_source_id) {
      const dataSourceId = normalizeId(parent.data_source_id);
      return { type: "data_source_id", data_source_id: dataSourceId, database_id: normalizeId(parent.database_id ?? dataSources.findOneBy("notion_id", dataSourceId)?.database_id) };
    }
    if (parent?.type === "database_id" || parent?.database_id) return { type: "database_id", database_id: normalizeId(parent.database_id) };
    return { type: "workspace", workspace: true };
  }

  function canUseParent(parent, actor) {
    if (parent?.type === "workspace" || parent?.workspace === true) return true;
    if (parent?.type === "page_id" || parent?.page_id) return canRead(pages.findOneBy("notion_id", normalizeId(parent.page_id)), actor);
    if (parent?.type === "data_source_id" || parent?.data_source_id) return canRead(dataSources.findOneBy("notion_id", normalizeId(parent.data_source_id)), actor);
    if (parent?.type === "database_id" || parent?.database_id) return canRead(databases.findOneBy("notion_id", normalizeId(parent.database_id)), actor);
    return false;
  }

  function rootPageForBlock(record) {
    let current = record;
    const seen = new Set();
    while (current && !seen.has(current.notion_id)) {
      seen.add(current.notion_id);
      if (current.parent?.type === "page_id") return pages.findOneBy("notion_id", normalizeId(current.parent.page_id));
      if (current.parent?.type === "database_id") return databases.findOneBy("notion_id", normalizeId(current.parent.database_id));
      current = blocks.findOneBy("notion_id", normalizeId(current.parent?.block_id));
    }
    return null;
  }

  function createBlock(parentId, input, actor) {
    const timestamp = now(store);
    const notionId = input.id ?? nextUuid(store, "block");
    const type = input.type ?? "paragraph";
    const value = blockValue(input, type);
    if (value.icon?.type === "custom_emoji") value.icon = normalizeIcon(value.icon);
    const normalizedParentId = normalizeId(parentId);
    const parentBlock = blocks.findOneBy("notion_id", normalizedParentId);
    const parentDatabase = databases.findOneBy("notion_id", normalizedParentId);
    const record = blocks.insert({
      notion_id: notionId,
      parent_id: normalizedParentId,
      parent: parentBlock ? { type: "block_id", block_id: normalizedParentId } : parentDatabase ? { type: "database_id", database_id: normalizedParentId } : { type: "page_id", page_id: normalizedParentId },
      created_time: timestamp,
      last_edited_time: timestamp,
      created_by: actor.notion_id,
      last_edited_by: actor.notion_id,
      has_children: blockChildren(input).length > 0,
      position: blocks.findBy("parent_id", normalizedParentId).length,
      in_trash: false,
      type,
      value,
    });
    for (const child of blockChildren(input)) createBlock(record.notion_id, child, actor);
    return publicBlock(record);
  }

  function block(id, actor) {
    const value = blocks.findOneBy("notion_id", normalizeId(id));
    const parent = value ? rootPageForBlock(value) : null;
    return value && (!actor || !parent || canRead(parent, actor)) ? publicBlock(value) : null;
  }

  function meetingNoteFilterValue(value, actor) {
    if (Array.isArray(value)) return value.map((item) => meetingNoteFilterValue(item, actor));
    if (value?.type === "exact") return meetingNoteFilterValue(value.value, actor);
    if (value?.type === "relative" && value.value === "me") return actor?.notion_id;
    if (value?.table === "notion_user") return normalizeId(value.id);
    return value;
  }

  function meetingNoteDateMatches(value, condition, actor) {
    const operator = condition.operator;
    const expected = condition.value;
    const timestamp = Date.parse(value);
    if (operator === "is_empty") return !value;
    if (operator === "is_not_empty") return Boolean(value);
    if (!value || Number.isNaN(timestamp) || !expected) return false;
    if (expected.type === "relative") {
      const direction = expected.direction === "future" ? 1 : -1;
      const count = Number(expected.count ?? 1);
      const unit = { day: 86_400_000, week: 604_800_000, month: 2_629_746_000, year: 31_556_952_000 }[expected.unit ?? "day"];
      if (!Number.isFinite(count) || !unit) return false;
      const current = Date.parse(now(store));
      const boundary = current + direction * count * unit;
      return direction < 0 ? timestamp >= boundary && timestamp <= current : timestamp >= current && timestamp <= boundary;
    }
    const exact = meetingNoteFilterValue(expected, actor);
    const exactValue = exact?.start_time ? `${exact.start_date}T${exact.start_time}` : exact?.start_date ?? exact;
    const expectedTimestamp = Date.parse(exactValue);
    if (Number.isNaN(expectedTimestamp)) return false;
    const dateOnly = exact?.type === "date" && !exact.start_time;
    const actualComparable = dateOnly ? String(value).slice(0, 10) : timestamp;
    const expectedComparable = dateOnly ? String(exactValue).slice(0, 10) : expectedTimestamp;
    if (["date_is", "date_equals", "datetime_equals", "equals"].includes(operator)) return String(value).slice(0, 10) === String(exactValue).slice(0, 10);
    if (["date_is_before", "date_before", "datetime_before", "before"].includes(operator)) return actualComparable < expectedComparable;
    if (["date_is_after", "date_after", "datetime_after", "after"].includes(operator)) return actualComparable > expectedComparable;
    if (["date_is_on_or_before", "date_on_or_before", "datetime_on_or_before", "on_or_before"].includes(operator)) return actualComparable <= expectedComparable;
    if (["date_is_on_or_after", "date_on_or_after", "datetime_on_or_after", "on_or_after"].includes(operator)) return actualComparable >= expectedComparable;
    return false;
  }

  function meetingNoteProperty(record, property) {
    if (property === "notion://meeting_notes/attendees") property = "attendees";
    if (property === "title") return record.value?.title?.map((part) => part.plain_text ?? part.text?.content ?? "").join("") ?? "";
    if (property === "attendees") return record.value?.calendar_event?.attendees ?? [];
    return record[property];
  }

  function meetingNoteLeafMatches(record, leaf, actor) {
    const supported = new Set(["title", "attendees", "created_time", "created_by", "last_edited_time", "last_edited_by", "notion://meeting_notes/attendees"]);
    if (!supported.has(leaf?.property) || !leaf.filter || typeof leaf.filter.operator !== "string") throw new Error("A meeting note filter must contain a supported property and operator.");
    const property = leaf.property === "notion://meeting_notes/attendees" ? "attendees" : leaf.property;
    const value = meetingNoteProperty(record, property);
    const operator = leaf.filter.operator;
    if (["created_time", "last_edited_time"].includes(property)) return meetingNoteDateMatches(value, leaf.filter, actor);
    if (operator === "is_empty") return emptyValue(value);
    if (operator === "is_not_empty") return !emptyValue(value);
    const expected = meetingNoteFilterValue(leaf.filter.value, actor);
    if (property === "attendees") {
      const wanted = Array.isArray(expected) ? expected : [expected];
      const actual = Array.isArray(value) ? value.map(normalizeId) : [];
      const contains = wanted.some((id) => actual.includes(normalizeId(id)));
      if (["person_contains", "contains", "user_contains"].includes(operator)) return contains;
      if (["person_does_not_contain", "does_not_contain", "user_does_not_contain"].includes(operator)) return !contains;
      return false;
    }
    if (["created_by", "last_edited_by"].includes(property)) {
      const wanted = Array.isArray(expected) ? expected : [expected];
      const contains = wanted.some((id) => normalizeId(id) === normalizeId(value));
      if (["person_contains", "equals", "user_equals"].includes(operator)) return contains;
      if (["person_does_not_contain", "does_not_equal", "user_does_not_equal"].includes(operator)) return !contains;
      return false;
    }
    const actual = String(value ?? "").toLowerCase();
    const wanted = String(expected ?? "").toLowerCase();
    if (["string_is", "equals", "string_equals"].includes(operator)) return actual === wanted;
    if (["string_is_not", "does_not_equal", "string_does_not_equal"].includes(operator)) return actual !== wanted;
    if (["contains", "string_contains"].includes(operator)) return actual.includes(wanted);
    if (["does_not_contain", "string_does_not_contain"].includes(operator)) return !actual.includes(wanted);
    if (["starts_with", "string_starts_with"].includes(operator)) return actual.startsWith(wanted);
    if (["ends_with", "string_ends_with"].includes(operator)) return actual.endsWith(wanted);
    return false;
  }

  function meetingNoteFilterMatches(record, filter, actor, depth = 0) {
    if (!filter) return true;
    if (filter.property) return meetingNoteLeafMatches(record, filter, actor);
    if (!["and", "or"].includes(filter.operator) || !Array.isArray(filter.filters) || depth > 1) throw new Error("A meeting note filter can contain and/or groups nested by one level.");
    if (filter.filters.length > 100) throw new Error("A meeting note filter group can contain at most 100 filters.");
    return filter.operator === "and"
      ? filter.filters.every((entry) => meetingNoteFilterMatches(record, entry, actor, depth + 1))
      : filter.filters.some((entry) => meetingNoteFilterMatches(record, entry, actor, depth + 1));
  }

  function createMeetingNote(input, actor) {
    let parentPage;
    if (input.source?.type === "file_upload") {
      const upload = fileUploads.findOneBy("notion_id", normalizeId(input.source.file_upload_id));
      parentPage = pages.findOneBy("notion_id", normalizeId(input.parent?.page_id));
      if (!upload || upload.created_by !== actor.notion_id || upload.status !== "uploaded" || input.parent?.type !== "page_id") return null;
    } else if (input.source?.type === "block") {
      const source = blocks.findOneBy("notion_id", normalizeId(input.source.block_id));
      parentPage = source ? rootPageForBlock(source) : null;
    } else {
      return { validation_error: "source must identify one uploaded file or one accessible block." };
    }
    if (!canRead(parentPage, actor)) return null;
    const result = createBlock(parentPage.notion_id, {
      type: "meeting_notes",
      meeting_notes: { title: richText(input.title ?? "Meeting notes"), status: "transcription_not_started" },
    }, actor);
    recordChange("meeting_note.created", result.id, actor.notion_id);
    return result;
  }

  function queryMeetingNotes(input, actor) {
    const allowedSorts = new Set(["title", "attendees", "created_time", "created_by", "last_edited_time", "last_edited_by"]);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return { validation_error: "limit must be an integer from 1 through 50." };
    if (!Array.isArray(input.sort ?? [])) return { validation_error: "sort must be an array." };
    if ((input.sort ?? []).length > 100 || (input.sort ?? []).some((item) => !allowedSorts.has(item?.property) || !["ascending", "descending"].includes(item?.direction))) return { validation_error: "sort can contain at most 100 supported property sorts." };
    let result = blocks.all().filter((item) => {
      if (item.type !== "meeting_notes" || item.in_trash) return false;
      const root = rootPageForBlock(item);
      const attendees = item.value?.calendar_event?.attendees;
      return canRead(root, actor) && (Array.isArray(attendees) ? attendees.some((id) => normalizeId(id) === actor.notion_id) : item.created_by === actor.notion_id);
    });
    try {
      if (input.filter) meetingNoteFilterMatches(result[0] ?? {}, input.filter, actor);
      result = result.filter((item) => meetingNoteFilterMatches(item, input.filter, actor));
    }
    catch (error) { return { validation_error: error.message }; }
    for (const sort of [...(input.sort ?? [])].reverse()) {
      result.sort((left, right) => compareValues(meetingNoteProperty(left, sort.property), meetingNoteProperty(right, sort.property)) * (sort.direction === "descending" ? -1 : 1));
    }
    return { results: result.slice(0, limit).map(publicBlock), has_more: result.length > limit };
  }

  function children(parentId, { startCursor, pageSize = 100, actor } = {}) {
    const parentPage = pages.findOneBy("notion_id", normalizeId(parentId));
    if (parentPage && actor && !canRead(parentPage, actor)) return { object: "list", results: [], next_cursor: null, has_more: false, type: "block", block: {} };
    const normalized = normalizeId(parentId);
    const parentBlock = blocks.findOneBy("notion_id", normalized);
    const root = parentBlock ? rootPageForBlock(parentBlock) : parentPage ?? databases.findOneBy("notion_id", normalized);
    if (root && actor && !canRead(root, actor)) return listResult([], "block");
    const all = blocks.findBy("parent_id", normalized).filter((item) => !item.in_trash).sort((left, right) => (left.position ?? left.id) - (right.position ?? right.id));
    const start = startCursor ? all.findIndex((item) => item.notion_id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const size = Math.min(100, Math.max(1, Number(pageSize) || 100));
    const selected = all.slice(start, start + size);
    return {
      object: "list",
      results: selected.map(publicBlock),
      next_cursor: start + size < all.length ? selected.at(-1)?.notion_id ?? null : null,
      has_more: start + size < all.length,
      type: "block",
      block: {},
    };
  }

  function appendChildren(parentId, input, actor) {
    const normalized = normalizeId(parentId);
    const parentPage = pages.findOneBy("notion_id", normalized);
    const parentBlock = blocks.findOneBy("notion_id", normalized);
    const parentDatabase = databases.findOneBy("notion_id", normalized);
    const root = parentPage ?? parentDatabase ?? rootPageForBlock(parentBlock);
    if (!(parentPage ?? parentBlock ?? parentDatabase) || !canRead(root, actor)) return null;
    const parentType = parentBlock?.type ?? null;
    const parentValue = parentBlock?.value ?? null;
    if (parentBlock && !allowsBlockChildren(parentType, parentValue)) return { validation_error: `${parentType} blocks cannot contain child blocks.` };
    for (const child of input.children ?? []) {
      const error = validateBlockInput(child, { parentType });
      if (error) return { validation_error: error };
    }
    const prior = blocks.findBy("parent_id", normalized).filter((item) => !item.in_trash).sort((left, right) => (left.position ?? left.id) - (right.position ?? right.id));
    const afterId = input.position?.type === "after_block" ? normalizeId(input.position.after_block?.id) : null;
    const afterIndex = afterId ? prior.findIndex((item) => item.notion_id === afterId) : -1;
    if (afterId && afterIndex < 0) return { validation_error: "position.after_block.id must identify an existing child of this parent." };
    const results = (input.children ?? []).map((child) => createBlock(parentId, child, actor));
    const createdIds = results.map((item) => item.id);
    let orderedIds;
    if (input.position?.type === "start") orderedIds = [...createdIds, ...prior.map((item) => item.notion_id)];
    else if (input.position?.type === "after_block") {
      orderedIds = [...prior.slice(0, afterIndex + 1).map((item) => item.notion_id), ...createdIds, ...prior.slice(afterIndex + 1).map((item) => item.notion_id)];
    } else orderedIds = [...prior.map((item) => item.notion_id), ...createdIds];
    orderedIds.forEach((id, position) => {
      const item = blocks.findOneBy("notion_id", id);
      if (item) blocks.update(item.id, { position });
    });
    if (parentBlock && results.length > 0) blocks.update(parentBlock.id, { has_children: true, last_edited_time: now(store), last_edited_by: actor.notion_id });
    recordChange("block.children_appended", parentId, actor.notion_id, {
      updated_blocks: results.map((item) => ({ id: item.id, type: "block" })),
    });
    return { object: "list", results, next_cursor: null, has_more: false, type: "block", block: {} };
  }

  function updateBlock(id, input, actor) {
    const normalized = normalizeId(id);
    const current = blocks.findOneBy("notion_id", normalized);
    const root = current ? rootPageForBlock(current) : null;
    if (!current || !canRead(root, actor) || current.in_trash) return null;
    const value = Object.hasOwn(input, current.type) ? structuredClone(input[current.type]) : current.value;
    const updated = blocks.update(current.id, {
      value, in_trash: Object.hasOwn(input, "in_trash") ? Boolean(input.in_trash) : current.in_trash,
      last_edited_time: now(store), last_edited_by: actor.notion_id,
    });
    recordChange("block.updated", normalized, actor.notion_id);
    return publicBlock(updated);
  }

  function trashBlockTree(id, actor) {
    const current = blocks.findOneBy("notion_id", normalizeId(id));
    if (!current) return null;
    for (const child of blocks.findBy("parent_id", current.notion_id)) trashBlockTree(child.notion_id, actor);
    return blocks.update(current.id, { in_trash: true, last_edited_time: now(store), last_edited_by: actor.notion_id });
  }

  function deleteBlock(id, actor) {
    const normalized = normalizeId(id);
    const current = blocks.findOneBy("notion_id", normalized);
    const root = current ? rootPageForBlock(current) : null;
    if (!current || !canRead(root, actor) || current.in_trash) return null;
    const updated = trashBlockTree(normalized, actor);
    recordChange("block.deleted", normalized, actor.notion_id);
    return publicBlock(updated);
  }

  function search(input = {}, actor) {
    const options = typeof input === "string" ? { query: input } : input;
    const needle = String(options.query ?? "").toLowerCase();
    const includeTrash = Boolean(options.filter?.in_trash);
    const objectType = options.filter?.value;
    const pageResults = pages.all()
      .filter((item) => canRead(item, actor) && Boolean(item.in_trash) === includeTrash && (!needle || titleText(item.properties).toLowerCase().includes(needle)))
      .map(publicPage);
    const sourceResults = dataSources.all()
      .filter((item) => canRead(item, actor) && Boolean(item.in_trash) === includeTrash && (!needle || String(item.name ?? "").toLowerCase().includes(needle)))
      .map(renderDataSource);
    let all = objectType === "page" ? pageResults : objectType === "data_source" ? sourceResults : [...pageResults, ...sourceResults];
    const direction = options.sort?.direction === "ascending" ? 1 : -1;
    if (options.sort) all.sort((left, right) => String(left.last_edited_time ?? "").localeCompare(String(right.last_edited_time ?? "")) * direction);
    const start = options.start_cursor ? all.findIndex((item) => item.id === normalizeId(options.start_cursor)) + 1 : 0;
    if (options.start_cursor && start === 0) return { invalid_cursor: true };
    const size = Math.min(100, Math.max(1, Number(options.page_size) || 100));
    const selected = all.slice(start, start + size);
    return listResult(selected, "page_or_data_source", start + size < all.length ? selected.at(-1)?.id ?? null : null);
  }

  function recordChange(topic, objectId, actorId, data = undefined) {
    const sequence = changes.count() + 1;
    const change = {
      sequence, topic, object_id: objectId, actor_id: actorId, occurred_at: now(store),
      ...(data === undefined ? {} : { data: structuredClone(data) }),
    };
    changes.insert(change);
    onChange?.(structuredClone(change));
  }

  function markdownLine(item) {
    const value = item[item.type] ?? {};
    const text = value.rich_text?.map((part) => part.plain_text ?? part.text?.content ?? "").join("") ?? "";
    if (item.type.startsWith("heading_")) return `${"#".repeat(Number(item.type.at(-1)))} ${text}`;
    if (item.type === "bulleted_list_item") return `- ${text}`;
    if (item.type === "numbered_list_item") return `1. ${text}`;
    if (item.type === "to_do") return `- [${value.checked ? "x" : " "}] ${text}`;
    if (item.type === "quote") return `> ${text}`;
    if (item.type === "divider") return "---";
    if (item.type === "code") return `\`\`\`${value.language ?? "plain text"}\n${text}\n\`\`\``;
    return text;
  }

  function renderMarkdownChildren(parentId, actor) {
    return children(parentId, { actor }).results.map((item) => markdownLine(item)).join("\n");
  }

  function markdownForPage(id, actor) {
    const normalized = normalizeId(id);
    const value = page(normalized, actor);
    if (value) {
      const title = titleText(value.properties) || "Untitled";
      const body = renderMarkdownChildren(value.id, actor);
      const markdown = `# ${title}${body ? `\n${body}` : ""}`;
      return { object: "page_markdown", id: value.id, markdown, truncated: false, unknown_block_ids: [], title, url: value.url, text: markdown, page: value };
    }
    const valueBlock = block(normalized, actor);
    if (!valueBlock) return null;
    const nested = renderMarkdownChildren(valueBlock.id, actor);
    const markdown = `${markdownLine(valueBlock)}${nested ? `\n${nested}` : ""}`;
    return { object: "page_markdown", id: valueBlock.id, markdown, truncated: false, unknown_block_ids: [], text: markdown };
  }

  function markdownBlock(line) {
    let match = line.match(/^(#{1,4})\s+(.*)$/);
    if (match) return { type: `heading_${match[1].length}`, [`heading_${match[1].length}`]: { rich_text: richText(match[2]), color: "default", is_toggleable: false } };
    match = line.match(/^- \[([ xX])\]\s+(.*)$/);
    if (match) return { type: "to_do", to_do: { rich_text: richText(match[2]), checked: match[1].toLowerCase() === "x", color: "default" } };
    match = line.match(/^[-*]\s+(.*)$/);
    if (match) return { type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(match[1]), color: "default" } };
    match = line.match(/^\d+\.\s+(.*)$/);
    if (match) return { type: "numbered_list_item", numbered_list_item: { rich_text: richText(match[1]), color: "default" } };
    match = line.match(/^>\s?(.*)$/);
    if (match) return { type: "quote", quote: { rich_text: richText(match[1]), color: "default" } };
    if (line === "---") return { type: "divider", divider: {} };
    return { type: "paragraph", paragraph: { rich_text: richText(line.replaceAll("<br>", "\n")), color: "default" } };
  }

  function replacePageMarkdown(pageRecord, markdown, actor) {
    for (const child of blocks.findBy("parent_id", pageRecord.notion_id)) trashBlockTree(child.notion_id, actor);
    const lines = String(markdown).split("\n");
    const first = lines[0]?.match(/^#\s+(.*)$/);
    if (first) {
      const propertyName = Object.entries(pageRecord.properties ?? {}).find(([, property]) => property?.type === "title")?.[0] ?? "title";
      const old = pageRecord.properties?.[propertyName] ?? { id: "title", type: "title" };
      pageRecord = pages.update(pageRecord.id, { properties: { ...pageRecord.properties, [propertyName]: { ...old, type: "title", title: richText(first[1]) } } });
      lines.shift();
    }
    for (const line of lines) createBlock(pageRecord.notion_id, markdownBlock(line), actor);
    pages.update(pageRecord.id, { last_edited_time: now(store), last_edited_by: actor.notion_id });
  }

  function updatePageMarkdown(id, input, actor) {
    const record = pages.findOneBy("notion_id", normalizeId(id));
    if (!canRead(record, actor)) return null;
    const current = markdownForPage(id, actor).markdown;
    let updated = current;
    if (input.type === "replace_content" && typeof input.replace_content?.new_str === "string") updated = input.replace_content.new_str;
    else if (input.type === "insert_content" && typeof input.insert_content?.content === "string") {
      const command = input.insert_content;
      if (command.after !== undefined && command.position !== undefined) return { validation_error: "after and position cannot be used together." };
      if (command.after !== undefined) {
        const index = current.indexOf(command.after);
        if (index < 0) return { validation_error: "after does not match page content." };
        updated = `${current.slice(0, index + command.after.length)}${command.content}${current.slice(index + command.after.length)}`;
      } else if (command.position?.type === "start") updated = `${command.content}\n${current}`;
      else updated = `${current}\n${command.content}`;
    } else if (input.type === "replace_content_range" && typeof input.replace_content_range?.content_range === "string" && typeof input.replace_content_range?.new_str === "string") {
      const command = input.replace_content_range;
      const index = current.indexOf(command.content_range);
      if (index < 0) return { validation_error: "content_range does not match page content." };
      updated = `${current.slice(0, index)}${command.new_str}${current.slice(index + command.content_range.length)}`;
    } else if (input.type === "update_content" && Array.isArray(input.update_content?.content_updates)) {
      for (const command of input.update_content.content_updates) {
        if (typeof command.old_str !== "string" || command.old_str.length === 0 || typeof command.new_str !== "string") return { validation_error: "Each content update requires non-empty old_str and string new_str." };
        const occurrences = updated.split(command.old_str).length - 1;
        if (occurrences === 0) return { validation_error: "old_str does not match page content." };
        if (occurrences > 1 && command.replace_all_matches !== true) return { validation_error: "old_str matches more than one location." };
        updated = command.replace_all_matches ? updated.split(command.old_str).join(command.new_str) : updated.replace(command.old_str, command.new_str);
      }
    } else return { validation_error: "Markdown update command is not valid." };
    replacePageMarkdown(record, updated, actor);
    recordChange("page.markdown_updated", record.notion_id, actor.notion_id, {
      parent: record.parent,
      updated_blocks: [{ id: record.notion_id, type: "page" }],
    });
    const result = markdownForPage(record.notion_id, actor);
    return input.allow_async ? { async_task: completeTask("update_page_markdown", actor, result) } : result;
  }

  function commentTarget(parent, actor) {
    if (parent?.page_id) {
      const record = pages.findOneBy("notion_id", normalizeId(parent.page_id));
      return canRead(record, actor) ? { type: "page_id", page_id: record.notion_id } : null;
    }
    if (parent?.block_id) {
      const record = blocks.findOneBy("notion_id", normalizeId(parent.block_id));
      return record && block(record.notion_id, actor) ? { type: "block_id", block_id: record.notion_id } : null;
    }
    return null;
  }

  function createComment(input, actor) {
    const reply = input.discussion_id ? comments.findOneBy("discussion_id", normalizeId(input.discussion_id)) : null;
    const parent = reply ? commentTarget(reply.parent, actor) : commentTarget(input.parent, actor);
    if (!parent || input.discussion_id && !reply) return null;
    const timestamp = now(store);
    const notionId = nextUuid(store, "comment");
    const record = comments.insert({
      notion_id: notionId, parent, parent_id: parent.page_id ?? parent.block_id,
      discussion_id: reply?.discussion_id ?? notionId, created_time: timestamp, last_edited_time: timestamp,
      created_by: actor.notion_id, rich_text: input.rich_text ? structuredClone(input.rich_text) : richText(input.markdown ?? ""),
      attachments: structuredClone(input.attachments ?? []),
      display_name: structuredClone(input.display_name ?? { type: "user", resolved_name: actor.name }),
      integration_created: true,
    });
    recordChange("comment.created", notionId, actor.notion_id, {
      parent: record.parent,
      page_id: record.parent.page_id ?? rootPageForBlock(blocks.findOneBy("notion_id", record.parent.block_id))?.notion_id,
      discussion_id: record.discussion_id,
    });
    return renderComment(record);
  }

  function comment(id, actor) {
    const record = comments.findOneBy("notion_id", normalizeId(id));
    return record && commentTarget(record.parent, actor) ? renderComment(record) : null;
  }

  function listComments(blockId, { startCursor, pageSize = 100, actor } = {}) {
    const parent = commentTarget({ page_id: blockId }, actor) ?? commentTarget({ block_id: blockId }, actor);
    if (!parent) return null;
    const all = comments.findBy("parent_id", normalizeId(blockId)).sort((left, right) => left.created_time.localeCompare(right.created_time) || left.id - right.id);
    const start = startCursor ? all.findIndex((item) => item.notion_id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = all.slice(start, start + pageSize);
    return listResult(selected.map(renderComment), "comment", start + pageSize < all.length ? selected.at(-1)?.notion_id ?? null : null);
  }

  function updateComment(id, input, actor) {
    const record = comments.findOneBy("notion_id", normalizeId(id));
    if (!record?.integration_created || record.created_by !== actor?.notion_id || !commentTarget(record.parent, actor)) return null;
    const updated = comments.update(record.id, {
      rich_text: input.rich_text ? structuredClone(input.rich_text) : richText(input.markdown ?? ""),
      last_edited_time: now(store),
    });
    recordChange("comment.updated", record.notion_id, actor.notion_id, {
      parent: record.parent,
      page_id: record.parent.page_id ?? rootPageForBlock(blocks.findOneBy("notion_id", record.parent.block_id))?.notion_id,
      discussion_id: record.discussion_id,
    });
    return renderComment(updated);
  }

  function deleteComment(id, actor) {
    const record = comments.findOneBy("notion_id", normalizeId(id));
    if (!record?.integration_created || record.created_by !== actor?.notion_id || !commentTarget(record.parent, actor)) return null;
    comments.delete(record.id);
    recordChange("comment.deleted", record.notion_id, actor.notion_id, {
      parent: record.parent,
      page_id: record.parent.page_id ?? rootPageForBlock(blocks.findOneBy("notion_id", record.parent.block_id))?.notion_id,
      discussion_id: record.discussion_id,
    });
    return renderComment(record);
  }

  function createFileUpload(input, actor) {
    const timestamp = now(store);
    const mode = input.mode ?? "single_part";
    const notionId = nextUuid(store, "file_upload");
    const objectStore = store.getData("notion_object_store") ?? { bucket: "worldfixture-documents", prefix: "notion/uploads" };
    const filename = String(input.filename ?? "upload").split(/[\\/]/).at(-1) || "upload";
    const prefix = String(objectStore.prefix ?? "notion/uploads").replace(/^\/+|\/+$/g, "");
    const record = fileUploads.insert({
      notion_id: notionId, created_time: timestamp, last_edited_time: timestamp, created_by: actor.notion_id,
      expiry_time: new Date(Date.parse(timestamp) + 60 * 60 * 1000).toISOString(), status: "pending",
      mode, filename: input.filename ?? null, content_type: input.content_type ?? null, content_length: null,
      number_of_parts: mode === "multi_part" ? Number(input.number_of_parts) : 1, sent_parts: [], external_url: input.external_url ?? null,
      file_import_result: null, object_bucket: objectStore.bucket, object_key: `${prefix}/${notionId}/${filename}`,
    });
    recordChange("file_upload.created", notionId, actor.notion_id);
    return publicFileUpload(record, baseUrl);
  }

  function fileUpload(id, actor) {
    const record = fileUploads.findOneBy("notion_id", normalizeId(id));
    return record?.created_by === actor?.notion_id ? publicFileUpload(record, baseUrl) : null;
  }

  function fileUploadStorage(id, actor) {
    const record = fileUploads.findOneBy("notion_id", normalizeId(id));
    if (record?.created_by !== actor?.notion_id) return null;
    return {
      bucket: record.object_bucket, key: record.object_key, mode: record.mode,
      number_of_parts: record.number_of_parts, sent_parts: structuredClone(record.sent_parts),
      status: record.status, filename: record.filename, content_type: record.content_type,
    };
  }

  function recordFileUploadPart(id, { partNumber = 1, contentLength = 0 } = {}, actor) {
    const record = fileUploads.findOneBy("notion_id", normalizeId(id));
    if (record?.created_by !== actor?.notion_id || record.status !== "pending") return null;
    const sentParts = [...new Set([...(record.sent_parts ?? []), partNumber])].sort((left, right) => left - right);
    const uploaded = record.mode === "single_part";
    const updated = fileUploads.update(record.id, {
      sent_parts: sentParts,
      content_length: uploaded ? contentLength : record.content_length,
      status: uploaded ? "uploaded" : "pending",
      last_edited_time: now(store),
    });
    recordChange("file_upload.part_sent", record.notion_id, actor.notion_id);
    if (uploaded) recordChange("file_upload.completed", record.notion_id, actor.notion_id);
    return publicFileUpload(updated, baseUrl);
  }

  function completeFileUpload(id, { contentLength = 0 } = {}, actor) {
    const record = fileUploads.findOneBy("notion_id", normalizeId(id));
    if (record?.created_by !== actor?.notion_id || record.status !== "pending") return null;
    if (record.mode !== "multi_part" || record.sent_parts.length !== record.number_of_parts) return { incomplete: true };
    const updated = fileUploads.update(record.id, {
      status: "uploaded", content_length: contentLength, last_edited_time: now(store),
    });
    recordChange("file_upload.completed", record.notion_id, actor.notion_id);
    return publicFileUpload(updated, baseUrl);
  }

  function listFileUploads({ status, startCursor, pageSize = 100, actor } = {}) {
    const all = fileUploads.all().filter((item) => item.created_by === actor?.notion_id && (!status || item.status === status)).sort((left, right) => right.id - left.id);
    const start = startCursor ? all.findIndex((item) => item.notion_id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = all.slice(start, start + pageSize);
    return listResult(selected.map((item) => publicFileUpload(item, baseUrl)), "file_upload", start + pageSize < all.length ? selected.at(-1)?.notion_id ?? null : null);
  }

  function mcpCreateFileUpload(args, actor) { return createFileUpload({ mode: "single_part", filename: args.filename, content_type: args.content_type }, actor); }
  async function mcpCreateAttachment(args, actor) {
    if (args.source_url) return { type: "external", name: args.filename, external: { url: args.source_url } };
    if (args.source_file_id) {
      const upload = fileUploads.findOneBy("notion_id", normalizeId(args.source_file_id));
      if (upload?.created_by !== actor?.notion_id || upload.status !== "uploaded") return null;
      return { type: "file_upload", name: upload.filename, file_upload: { id: upload.notion_id } };
    }
    if (!objectStore) {
      const error = new Error("The Notion File Upload profile needs its object-store capability.");
      error.code = "not_implemented";
      throw error;
    }
    const upload = createFileUpload({ mode: "single_part", filename: args.filename, content_type: args.content_type ?? "text/plain; charset=utf-8" }, actor);
    const storage = fileUploadStorage(upload.id, actor);
    const bytes = new TextEncoder().encode(args.content);
    await objectStore.put({ ...storage, bytes, contentType: args.content_type, owner: actor.notion_id });
    recordFileUploadPart(upload.id, { contentLength: bytes.byteLength }, actor);
    return { type: "file_upload", name: args.filename, file_upload: { id: upload.id } };
  }
  async function mcpDownloadAttachment(args, actor) {
    const upload = fileUploads.findOneBy("notion_id", normalizeId(args.file_upload_id));
    if (upload?.created_by !== actor?.notion_id || upload.status !== "uploaded") return null;
    if (!objectStore) {
      const error = new Error("The Notion File Upload profile needs its object-store capability.");
      error.code = "not_implemented";
      throw error;
    }
    const stored = await objectStore.get(fileUploadStorage(upload.notion_id, actor));
    if (!stored || stored.bytes.byteLength > 200 * 1024) return null;
    return {
      file_upload_id: upload.notion_id, filename: upload.filename,
      content_type: upload.content_type ?? stored.contentType,
      content: new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes),
    };
  }
  function mcpCreateComment(args, actor) { return createComment({ parent: args.page_id ? { page_id: args.page_id } : undefined, discussion_id: args.discussion_id, markdown: args.markdown, rich_text: args.rich_text }, actor); }
  // `notion-get-comments` HAS NO `page_size`. Its captured contract declares
  // `discussion_id`, `include_all_blocks`, `include_resolved` and `page_id` and
  // nothing else, so `args.page_size` was always `undefined` and the expression
  // was a constant 100 dressed up as a parameter. That would be harmless on its
  // own, but `additionalProperties` is permissive, so a client that DID send
  // `page_size: -5` got it through with no lower clamp: `slice(0, -5)` dropped
  // the last five comments and still reported `has_more` with a cursor, which is
  // a pagination loop that never ends. The page size is stated as the constant it
  // actually is.
  function mcpGetComments(args, actor) {
    const result = listComments(args.page_id, { pageSize: 100, actor });
    return result ? { comments: result.results, has_more: result.has_more, next_cursor: result.next_cursor } : null;
  }

  function rawPage(id) {
    return pages.findOneBy("notion_id", normalizeId(id));
  }

  function pagePath(record, actor) {
    const path = [];
    let current = record;
    const seen = new Set();
    while (current?.parent?.page_id && !seen.has(current.parent.page_id)) {
      seen.add(current.parent.page_id);
      const parent = pages.findOneBy("notion_id", normalizeId(current.parent.page_id));
      if (!canRead(parent, actor)) break;
      path.unshift({ id: parent.notion_id, title: titleText(parent.properties), url: parent.url });
      current = parent;
    }
    return path;
  }

  function isDescendant(record, ancestorId) {
    let current = record;
    const target = normalizeId(ancestorId);
    const seen = new Set();
    while (current?.parent?.page_id && !seen.has(current.parent.page_id)) {
      if (normalizeId(current.parent.page_id) === target) return true;
      seen.add(current.parent.page_id);
      current = pages.findOneBy("notion_id", normalizeId(current.parent.page_id));
    }
    return record.notion_id === target;
  }

  function mcpSearch(args, actor) {
    const queryType = args.query_type ?? "internal";
    const limit = Math.min(50, Math.max(1, Number(args.page_size) || 10));
    const needle = String(args.query ?? "").trim().toLowerCase();
    if (queryType === "user") {
      return {
        results: users.all().filter((item) => !needle || `${item.name} ${item.email}`.toLowerCase().includes(needle)).slice(0, limit).map((item) => ({
          id: item.notion_id, title: item.name, url: `user://${item.notion_id}`, type: "user", highlight: item.email ?? "",
        })),
        type: "user_search",
      };
    }
    const filters = args.filters ?? {};
    const scopedPage = args.page_url ? normalizeId(args.page_url) : null;
    const scopedDataSource = args.data_source_url ? normalizeId(args.data_source_url) : null;
    const maxHighlight = Math.max(0, Number.isInteger(args.max_highlight_length) ? args.max_highlight_length : 200);
    const matches = pages.all().filter((item) => {
      if (!canRead(item, actor)) return false;
      if (Boolean(item.in_trash) !== Boolean(filters.in_trash)) return false;
      if (scopedPage && !isDescendant(item, scopedPage)) return false;
      if (scopedDataSource && normalizeId(item.parent?.data_source_id) !== scopedDataSource) return false;
      if (args.teamspace_id && item.teamspace_id !== normalizeId(args.teamspace_id)) return false;
      if (filters.teamspace_ids?.length && !filters.teamspace_ids.map(normalizeId).includes(item.teamspace_id)) return false;
      if (!dateInRange(item.created_time, filters.created_date_range) || !dateInRange(item.last_edited_time, filters.last_edited_date_range)) return false;
      if (filters.created_by_user_ids?.length && !filters.created_by_user_ids.map(normalizeId).includes(item.created_by)) return false;
      if (filters.last_edited_by_user_ids?.length && !filters.last_edited_by_user_ids.map(normalizeId).includes(item.last_edited_by)) return false;
      const state = item.verification?.state ?? "none";
      if (filters.content_status && filters.content_status !== state) return false;
      const title = titleText(item.properties);
      const blockText = blocks.findBy("parent_id", item.notion_id).map(plainBlockText).join(" ");
      return !needle || (filters.title_only ? title : `${title} ${blockText}`).toLowerCase().includes(needle);
    });
    if (args.sort === "last_edited") matches.sort((left, right) => right.last_edited_time.localeCompare(left.last_edited_time));
    if (args.sort === "created") matches.sort((left, right) => right.created_time.localeCompare(left.created_time));
    const results = matches.slice(0, limit).map((item) => {
      const title = titleText(item.properties) || "Untitled";
      const body = blocks.findBy("parent_id", item.notion_id).map(plainBlockText).join(" ");
      const haystack = `${title} ${body}`.trim();
      const offset = needle ? Math.max(0, haystack.toLowerCase().indexOf(needle)) : 0;
      return {
        id: item.notion_id,
        title,
        url: item.url,
        type: "page",
        highlight: maxHighlight === 0 ? "" : haystack.slice(offset, offset + maxHighlight),
        timestamp: item.last_edited_time,
        path: pagePath(item, actor),
        ...(item.verification ? { verification: structuredClone(item.verification) } : {}),
      };
    });
    return { results, type: args.content_search_mode ?? "workspace_search" };
  }

  function database(id, actor) {
    const record = databases.findOneBy("notion_id", normalizeId(id));
    if (!canRead(record, actor)) return null;
    const direct = dataSources.findBy("database_id", record.notion_id);
    const linked = (record.linked_data_source_ids ?? []).map((sourceId) => dataSources.findOneBy("notion_id", sourceId)).filter(Boolean);
    return publicDatabase(record, [...new Map([...direct, ...linked].filter((source) => canRead(source, actor)).map((source) => [source.notion_id, source])).values()]);
  }

  function dataSource(id, actor) {
    const record = dataSources.findOneBy("notion_id", normalizeId(id));
    return canRead(record, actor) ? renderDataSource(record) : null;
  }

  function view(id, actor) {
    const record = views.findOneBy("notion_id", normalizeId(id));
    return canRead(record, actor) ? publicView(record) : null;
  }

  function createDatabase(input, actor) {
    if (!canUseParent(input.parent, actor)) return null;
    const timestamp = now(store);
    const notionId = nextUuid(store, "database");
    const normalizedDatabaseParent = normalizedParent(input.parent);
    const parentRecord = normalizedDatabaseParent.type === "page_id" ? pages.findOneBy("notion_id", normalizedDatabaseParent.page_id) : normalizedDatabaseParent.type === "data_source_id" ? dataSources.findOneBy("notion_id", normalizedDatabaseParent.data_source_id) : null;
    if (normalizedDatabaseParent.type === "data_source_id" && !parentRecord?.is_wiki) return { validation_error: "A database can only use a data_source_id parent when that data source is a wiki." };
    const record = databases.insert({
      notion_id: notionId, title: asRichText(input.title, "Untitled"), description: asRichText(input.description), database_type: input.database_type ?? null,
      parent: normalizedDatabaseParent, is_inline: Boolean(input.is_inline), icon: input.icon ?? null, cover: input.cover ?? null,
      created_time: timestamp, last_edited_time: timestamp, created_by: actor.notion_id, last_edited_by: actor.notion_id,
      url: `${baseUrl}/notion/${notionId.replaceAll("-", "")}`, public_url: null, in_trash: false,
      accessible_by: structuredClone(input.accessible_by ?? parentRecord?.accessible_by ?? []),
    });
    const initial = input.initial_data_source ?? {};
    createDataSource({ parent: { type: "database_id", database_id: notionId }, title: initial.title ?? input.title, properties: initial.properties ?? {} }, actor);
    recordChange("database.created", notionId, actor.notion_id, { parent: record.parent });
    return publicDatabase(record, dataSources.findBy("database_id", notionId));
  }

  function updateDatabase(id, input, actor) {
    const normalized = normalizeId(id);
    const current = databases.findOneBy("notion_id", normalized);
    if (!canRead(current, actor) || (input.parent && !canUseParent(input.parent, actor))) return null;
    if (input.parent && normalizedParent(input.parent).type === "data_source_id" && !dataSources.findOneBy("notion_id", normalizeId(input.parent.data_source_id))?.is_wiki) return { validation_error: "A database can only use a data_source_id parent when that data source is a wiki." };
    const updated = databases.update(current.id, {
      title: Object.hasOwn(input, "title") ? asRichText(input.title) : current.title,
      description: Object.hasOwn(input, "description") ? asRichText(input.description) : current.description,
      parent: input.parent ? normalizedParent(input.parent) : current.parent,
      is_inline: Object.hasOwn(input, "is_inline") ? Boolean(input.is_inline) : current.is_inline,
      icon: Object.hasOwn(input, "icon") ? input.icon : current.icon, cover: Object.hasOwn(input, "cover") ? input.cover : current.cover,
      in_trash: Object.hasOwn(input, "in_trash") ? Boolean(input.in_trash) : current.in_trash,
      is_locked: Object.hasOwn(input, "is_locked") ? Boolean(input.is_locked) : current.is_locked,
      last_edited_time: now(store), last_edited_by: actor.notion_id,
    });
    const topic = input.parent && JSON.stringify(updated.parent) !== JSON.stringify(current.parent)
      ? "database.moved"
      : Object.hasOwn(input, "in_trash") && Boolean(input.in_trash) !== Boolean(current.in_trash)
        ? (input.in_trash ? "database.deleted" : "database.undeleted")
        : "database.schema_updated";
    recordChange(topic, normalized, actor.notion_id, { parent: updated.parent });
    return publicDatabase(updated, dataSources.findBy("database_id", normalized));
  }

  function createDataSource(input, actor) {
    const parentId = normalizeId(input.parent?.database_id ?? input.database_id);
    const parent = databases.findOneBy("notion_id", parentId);
    if (!canRead(parent, actor)) return null;
    const timestamp = now(store);
    const notionId = nextUuid(store, "data_source");
    const title = asRichText(input.title ?? input.name, "Untitled");
    const record = dataSources.insert({
      notion_id: notionId, database_id: parentId, name: title.map((part) => part.plain_text ?? part.text?.content ?? "").join(""), title,
      description: asRichText(input.description), properties: responseSchema(input.properties), templates: structuredClone(input.templates ?? []), icon: input.icon ?? null,
      created_time: timestamp, last_edited_time: timestamp, created_by: actor.notion_id, last_edited_by: actor.notion_id,
      accessible_by: structuredClone(input.accessible_by ?? parent.accessible_by ?? []), in_trash: false, is_inline: Boolean(parent.is_inline), database_type: parent.database_type ?? null, cover: null,
      url: `${baseUrl}/notion/${notionId.replaceAll("-", "")}`, public_url: null, is_wiki: Boolean(input.is_wiki),
      database_parent: parent.parent?.type === "data_source_id" ? structuredClone(parent.parent) : structuredClone(input.database_parent ?? null),
    });
    createView({ database_id: parentId, data_source_id: notionId, name: "Table", type: "table" }, actor, { skipChange: true });
    recordChange("data_source.created", notionId, actor.notion_id, { parent: { database_id: record.database_id } });
    return renderDataSource(record);
  }

  function updateDataSource(id, input, actor) {
    const normalized = normalizeId(id);
    const current = dataSources.findOneBy("notion_id", normalized);
    const destinationId = normalizeId(input.parent?.database_id ?? current?.database_id);
    const destination = databases.findOneBy("notion_id", destinationId);
    if (!canRead(current, actor) || !canRead(destination, actor)) return null;
    const properties = { ...(current.properties ?? {}) };
    for (const [key, value] of Object.entries(input.properties ?? {})) value === null ? delete properties[key] : properties[key] = structuredClone(value);
    const title = Object.hasOwn(input, "title") ? asRichText(input.title) : asRichText(current.title ?? current.name);
    const moved = destinationId !== current.database_id;
    const updated = dataSources.update(current.id, {
      database_id: destinationId, title, name: title.map((part) => part.plain_text ?? part.text?.content ?? "").join(""),
      description: Object.hasOwn(input, "description") ? asRichText(input.description) : current.description,
      properties, icon: Object.hasOwn(input, "icon") ? input.icon : current.icon,
      in_trash: Object.hasOwn(input, "in_trash") ? Boolean(input.in_trash) : current.in_trash,
      last_edited_time: now(store), last_edited_by: actor.notion_id,
    });
    if (moved) createView({ database_id: destinationId, data_source_id: normalized, name: "Table", type: "table" }, actor, { skipChange: true });
    const topic = moved
      ? "data_source.moved"
      : Object.hasOwn(input, "in_trash") && Boolean(input.in_trash) !== Boolean(current.in_trash)
        ? (input.in_trash ? "data_source.deleted" : "data_source.undeleted")
        : "data_source.schema_updated";
    const updatedProperties = Object.entries(input.properties ?? {}).map(([name, value]) => ({
      id: current.properties?.[name]?.id ?? value?.id ?? name,
      name,
      action: value === null ? "deleted" : current.properties?.[name] ? "updated" : "created",
    }));
    recordChange(topic, normalized, actor.notion_id, {
      parent: { database_id: updated.database_id },
      ...(topic === "data_source.schema_updated" && updatedProperties.length ? { updated_properties: updatedProperties } : {}),
    });
    return renderDataSource(updated);
  }

  function dataSourceTemplates(id, { name = "", startCursor, pageSize = 100, actor } = {}) {
    const source = dataSources.findOneBy("notion_id", normalizeId(id));
    if (!canRead(source, actor)) return null;
    const filtered = (source.templates ?? []).filter((template) => !name || String(template.name ?? "").toLowerCase().includes(String(name).toLowerCase()));
    const start = startCursor ? filtered.findIndex((template) => String(template.id) === String(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = filtered.slice(start, start + pageSize);
    return {
      templates: selected.map((template) => ({ id: normalizeId(template.id ?? template.page_id), name: template.name, is_default: Boolean(template.is_default ?? template.default) })),
      has_more: start + pageSize < filtered.length,
      next_cursor: start + pageSize < filtered.length ? String(selected.at(-1)?.id ?? selected.at(-1)?.page_id) : null,
    };
  }

  function propertyValue(property) {
    if (!property || typeof property !== "object") return property;
    const type = property.type ?? Object.keys(property).find((key) => key !== "id");
    const value = type ? property[type] : property;
    if (["title", "rich_text"].includes(type)) return (value ?? []).map((part) => part?.plain_text ?? part?.text?.content ?? "").join("");
    if (["multi_select", "people", "relation", "files"].includes(type)) return value ?? [];
    if (["select", "status"].includes(type)) return value?.name ?? null;
    if (type === "date") return value?.start ?? null;
    if (type === "unique_id") return value?.number ?? null;
    if (type === "verification") return value?.state ?? null;
    if (type === "formula") return propertyValue(value);
    if (type === "rollup") return value?.type === "array" ? value.array ?? [] : propertyValue(value);
    if (value && typeof value === "object") return value.name ?? value.start ?? value.id ?? value;
    return value;
  }

  function emptyValue(value) {
    return value === null || value === undefined || value === "" || Array.isArray(value) && value.length === 0;
  }

  function comparableValues(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((item) => {
      if (!item || typeof item !== "object") return [item];
      const candidates = [item.id, item.name, item.plain_text, item.text?.content].filter((candidate) => candidate !== undefined);
      return candidates.length ? candidates : [propertyValue(item)];
    });
  }

  function equalValue(value, expected) {
    if (Array.isArray(expected)) return expected.some((item) => equalValue(value, item));
    return comparableValues(value).some((item) => item === expected || normalizeId(item) === normalizeId(expected) || typeof item === "string" && typeof expected === "string" && item.toLowerCase() === expected.toLowerCase());
  }

  function dateMatches(value, condition) {
    const date = value?.start ?? value;
    if (!date) return condition.is_empty === true;
    const timestamp = Date.parse(date);
    if (Number.isNaN(timestamp)) return false;
    const current = new Date(now(store));
    const startToday = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const day = 86_400_000;
    const range = (start, end) => timestamp >= start && timestamp < end;
    if (Object.hasOwn(condition, "equals")) return String(date).slice(0, 10) === String(condition.equals).slice(0, 10);
    const compare = (expected, operator) => {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(expected));
      const actualValue = dateOnly ? String(date).slice(0, 10) : timestamp;
      const expectedValue = dateOnly ? String(expected) : Date.parse(expected);
      return operator === "before" ? actualValue < expectedValue
        : operator === "after" ? actualValue > expectedValue
          : operator === "on_or_before" ? actualValue <= expectedValue
            : actualValue >= expectedValue;
    };
    if (Object.hasOwn(condition, "before")) return compare(condition.before, "before");
    if (Object.hasOwn(condition, "after")) return compare(condition.after, "after");
    if (Object.hasOwn(condition, "on_or_before")) return compare(condition.on_or_before, "on_or_before");
    if (Object.hasOwn(condition, "on_or_after")) return compare(condition.on_or_after, "on_or_after");
    if (condition.past_week !== undefined) return range(startToday - 7 * day, startToday + day);
    if (condition.next_week !== undefined) return range(startToday, startToday + 8 * day);
    if (condition.past_month !== undefined) return range(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, current.getUTCDate()), startToday + day);
    if (condition.next_month !== undefined) return range(startToday, Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate() + 1));
    if (condition.past_year !== undefined) return range(Date.UTC(current.getUTCFullYear() - 1, current.getUTCMonth(), current.getUTCDate()), startToday + day);
    if (condition.next_year !== undefined) return range(startToday, Date.UTC(current.getUTCFullYear() + 1, current.getUTCMonth(), current.getUTCDate() + 1));
    if (condition.this_week !== undefined) {
      const mondayOffset = (current.getUTCDay() + 6) % 7;
      return range(startToday - mondayOffset * day, startToday + (7 - mondayOffset) * day);
    }
    if (condition.this_month !== undefined) return range(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1), Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
    if (condition.this_year !== undefined) return range(Date.UTC(current.getUTCFullYear(), 0, 1), Date.UTC(current.getUTCFullYear() + 1, 0, 1));
    return condition.is_not_empty === true;
  }

  function matchesCondition(value, condition, type, actor) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("A filter condition must be an object.");
    if (condition.is_empty === true) return emptyValue(value);
    if (condition.is_not_empty === true) return !emptyValue(value);
    if (type === "date" || type === "created_time" || type === "last_edited_time") return dateMatches(value, condition);
    if (type === "formula") {
      const formulaType = Object.keys(condition).find((key) => ["checkbox", "date", "number", "string"].includes(key));
      if (!formulaType) throw new Error("A formula filter must contain checkbox, date, number, or string.");
      return matchesCondition(propertyValue(value), condition[formulaType], formulaType === "string" ? "rich_text" : formulaType, actor);
    }
    if (type === "rollup") {
      if (condition.any || condition.every || condition.none) {
        const values = value?.type === "array" ? value.array ?? [] : [];
        const nested = condition.any ?? condition.every ?? condition.none;
        const test = (item) => {
          const itemType = item?.type ?? Object.keys(item ?? {})[0];
          return matchesCondition(propertyValue(item), nested[itemType] ?? nested, itemType, actor);
        };
        if (condition.any) return values.some(test);
        if (condition.every) return values.every(test);
        return values.every((item) => !test(item));
      }
      const rollupType = Object.keys(condition).find((key) => ["date", "number"].includes(key));
      if (!rollupType) throw new Error("A rollup filter must contain any, every, none, date, or number.");
      return matchesCondition(propertyValue(value), condition[rollupType], rollupType, actor);
    }
    const expected = condition.equals === "me" && ["people", "created_by", "last_edited_by"].includes(type) ? actor.notion_id : condition.equals;
    const notExpected = condition.does_not_equal === "me" && ["people", "created_by", "last_edited_by"].includes(type) ? actor.notion_id : condition.does_not_equal;
    if (Object.hasOwn(condition, "equals")) return equalValue(value, expected);
    if (Object.hasOwn(condition, "does_not_equal")) return !equalValue(value, notExpected);
    if (Object.hasOwn(condition, "contains")) {
      if (Array.isArray(value)) return equalValue(value, condition.contains === "me" && type === "people" ? actor.notion_id : condition.contains);
      return String(value ?? "").toLowerCase().includes(String(condition.contains).toLowerCase());
    }
    if (Object.hasOwn(condition, "does_not_contain")) {
      if (Array.isArray(value)) return !equalValue(value, condition.does_not_contain === "me" && type === "people" ? actor.notion_id : condition.does_not_contain);
      return !String(value ?? "").toLowerCase().includes(String(condition.does_not_contain).toLowerCase());
    }
    if (Object.hasOwn(condition, "starts_with")) return String(value ?? "").toLowerCase().startsWith(String(condition.starts_with).toLowerCase());
    if (Object.hasOwn(condition, "ends_with")) return String(value ?? "").toLowerCase().endsWith(String(condition.ends_with).toLowerCase());
    const numeric = Number(value);
    if (Object.hasOwn(condition, "greater_than")) return numeric > Number(condition.greater_than);
    if (Object.hasOwn(condition, "greater_than_or_equal_to")) return numeric >= Number(condition.greater_than_or_equal_to);
    if (Object.hasOwn(condition, "less_than")) return numeric < Number(condition.less_than);
    if (Object.hasOwn(condition, "less_than_or_equal_to")) return numeric <= Number(condition.less_than_or_equal_to);
    throw new Error(`The ${type ?? "property"} filter does not contain a supported operator.`);
  }

  function validateDataSourceFilter(filter, depth = 0) {
    if (!filter) return;
    const group = Array.isArray(filter.and) ? filter.and : Array.isArray(filter.or) ? filter.or : null;
    if (!group) return;
    if (depth >= 2) throw new Error("Data-source filters can contain no more than two compound levels.");
    if (group.length > 100) throw new Error("A compound filter can contain at most 100 filters.");
    for (const entry of group) validateDataSourceFilter(entry, depth + 1);
  }

  function matchesFilter(record, filter, actor) {
    if (!filter) return true;
    if (Array.isArray(filter.and)) return filter.and.every((entry) => matchesFilter(record, entry, actor));
    if (Array.isArray(filter.or)) return filter.or.some((entry) => matchesFilter(record, entry, actor));
    if (filter.timestamp) {
      if (!["created_time", "last_edited_time"].includes(filter.timestamp)) throw new Error("timestamp must be created_time or last_edited_time.");
      return matchesCondition(record[filter.timestamp], filter[filter.timestamp], filter.timestamp, actor);
    }
    if (typeof filter.property !== "string") throw new Error("A property filter must contain property.");
    const entry = Object.entries(record.properties ?? {}).find(([name, property]) => name === filter.property || String(property?.id) === filter.property);
    const property = entry?.[1];
    const type = property?.type ?? Object.keys(filter).find((key) => !["property", "and", "or"].includes(key));
    if (!type || !Object.hasOwn(filter, type)) throw new Error("The filter type must match the property type.");
    const value = ["formula", "rollup"].includes(type) ? property?.[type] : propertyValue(property);
    return matchesCondition(value, filter[type], type, actor);
  }

  function sortValue(record, sort) {
    if (sort.timestamp) return record[sort.timestamp];
    const entry = Object.entries(record.properties ?? {}).find(([name, property]) => name === sort.property || String(property?.id) === String(sort.property));
    return propertyValue(entry?.[1]);
  }

  function compareValues(left, right) {
    if (left === right) return 0;
    if (emptyValue(left)) return 1;
    if (emptyValue(right)) return -1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
    return String(Array.isArray(left) ? comparableValues(left).join(",") : left).localeCompare(String(Array.isArray(right) ? comparableValues(right).join(",") : right));
  }

  function queryDataSource(id, input, actor) {
    const source = dataSources.findOneBy("notion_id", normalizeId(id));
    if (!canRead(source, actor)) return null;
    const includeTrash = Boolean(input.in_trash);
    const resultType = input.result_type ?? (source.is_wiki ? null : "page");
    if (resultType !== null && !["page", "data_source"].includes(resultType)) return { validation_error: "result_type must be page or data_source." };
    const pageResults = pages.all().filter((item) => canRead(item, actor) && Boolean(item.in_trash) === includeTrash && normalizeId(item.parent?.data_source_id) === source.notion_id).map((item) => ({ kind: "page", item }));
    const sourceResults = source.is_wiki ? dataSources.all().filter((item) => {
      const databaseRecord = databases.findOneBy("notion_id", item.database_id);
      return canRead(item, actor) && Boolean(item.in_trash) === includeTrash && (normalizeId(item.parent_data_source_id) === source.notion_id || normalizeId(item.database_parent?.data_source_id) === source.notion_id || normalizeId(databaseRecord?.parent?.data_source_id) === source.notion_id);
    }).map((item) => ({ kind: "data_source", item })) : [];
    let result = resultType === "page" ? pageResults : resultType === "data_source" ? sourceResults : [...pageResults, ...sourceResults];
    try {
      validateDataSourceFilter(input.filter);
      matchesFilter({ properties: {}, created_time: now(store), last_edited_time: now(store) }, input.filter, actor);
      result = result.filter((entry) => matchesFilter(entry.item, input.filter, actor));
    }
    catch (error) { return { validation_error: error.message }; }
    for (const sort of [...(input.sorts ?? [])].reverse()) {
      if (!sort || !["ascending", "descending"].includes(sort.direction) || !(sort.property || ["created_time", "last_edited_time"].includes(sort.timestamp))) return { validation_error: "Each sort must contain a property or timestamp and a valid direction." };
      result.sort((left, right) => compareValues(sortValue(left.item, sort), sortValue(right.item, sort)) * (sort.direction === "descending" ? -1 : 1));
    }
    const start = input.start_cursor ? result.findIndex((entry) => entry.item.notion_id === normalizeId(input.start_cursor)) + 1 : 0;
    if (input.start_cursor && start === 0) return { invalid_cursor: true };
    const size = input.page_size ?? 100;
    const selected = result.slice(start, Math.min(start + size, 10_000));
    const properties = input.filter_properties ?? [];
    const publicResults = selected.map((entry) => {
      if (entry.kind === "data_source") return renderDataSource(entry.item);
      const value = renderPage(entry.item);
      if (properties.length) value.properties = Object.fromEntries(Object.entries(value.properties).filter(([name, property]) => properties.includes(name) || properties.includes(String(property?.id))));
      return value;
    });
    const response = listResult(publicResults, "page_or_data_source", start + size < Math.min(result.length, 10_000) ? selected.at(-1)?.item.notion_id ?? null : null);
    if (result.length > 10_000) response.request_status = { type: "incomplete", incomplete_reason: "query_result_limit_reached" };
    return response;
  }

  function createView(input, actor, options = {}) {
    const sourceId = normalizeId(input.data_source_id);
    const source = dataSources.findOneBy("notion_id", sourceId);
    if (!canRead(source, actor)) return null;
    let databaseId = normalizeId(input.database_id);
    let dashboardParent = null;
    if (input.view_id) {
      dashboardParent = views.findOneBy("notion_id", normalizeId(input.view_id));
      if (!canRead(dashboardParent, actor) || dashboardParent.type !== "dashboard") return null;
      databaseId = dashboardParent.database_id;
    } else if (input.create_database) {
      const spec = input.create_database;
      const parent = spec.parent ?? { type: "page_id", page_id: spec.page_id ?? spec.parent_page_id };
      if (!canUseParent(parent, actor) || normalizedParent(parent).type !== "page_id") return null;
      const timestamp = now(store);
      const notionId = nextUuid(store, "database");
      const parentRecord = pages.findOneBy("notion_id", normalizedParent(parent).page_id);
      databases.insert({
        notion_id: notionId, title: asRichText(spec.title ?? spec.name, input.name), description: [], parent: normalizedParent(parent),
        is_inline: true, icon: null, cover: null, created_time: timestamp, last_edited_time: timestamp,
        created_by: actor.notion_id, last_edited_by: actor.notion_id, url: `${baseUrl}/notion/${notionId.replaceAll("-", "")}`,
        public_url: null, in_trash: false, accessible_by: structuredClone(parentRecord?.accessible_by ?? []), linked_data_source_ids: [sourceId],
      });
      databaseId = notionId;
      recordChange("database.linked_created", notionId, actor.notion_id);
    }
    const databaseRecord = databases.findOneBy("notion_id", databaseId);
    const sourceBelongs = source.database_id === databaseId || databaseRecord?.linked_data_source_ids?.includes(sourceId) || Boolean(dashboardParent);
    if (!canRead(databaseRecord, actor) || !sourceBelongs) return null;
    const siblings = views.findBy("database_id", databaseId).sort((left, right) => (left.position ?? left.id) - (right.position ?? right.id));
    const requestedPosition = input.position?.type ?? "end";
    let position = siblings.length;
    if (requestedPosition === "start") position = 0;
    if (["after", "after_view"].includes(requestedPosition)) {
      const afterId = normalizeId(input.position.view_id ?? input.position.after_view?.id ?? input.position.after_view_id ?? input.position.id);
      const index = siblings.findIndex((view) => view.notion_id === afterId);
      if (index < 0) return { validation_error: "position must identify an existing view in the target database." };
      position = index + 1;
    }
    for (const sibling of siblings.filter((view) => (view.position ?? view.id) >= position)) views.update(sibling.id, { position: (sibling.position ?? siblings.indexOf(sibling)) + 1 });
    const viewId = nextUuid(store, "view");
    const record = views.insert({
      notion_id: viewId, database_id: databaseId, data_source_id: sourceId, name: input.name, type: input.type,
      created_time: now(store), last_edited_time: now(store),
      url: `${baseUrl}/notion/${databaseId.replaceAll("-", "")}?v=${viewId.replaceAll("-", "")}`,
      filter: structuredClone(input.filter ?? null), sorts: structuredClone(input.sorts ?? []), quick_filters: structuredClone(input.quick_filters ?? {}),
      configuration: structuredClone(input.configuration ?? {}), accessible_by: structuredClone(input.accessible_by ?? source.accessible_by ?? []),
      position, dashboard_parent_view_id: dashboardParent?.notion_id ?? null, placement: structuredClone(input.placement ?? null),
    });
    if (!options.skipChange) recordChange("view.created", record.notion_id, actor.notion_id, {
      parent: { database_id: record.database_id }, view_type: record.type,
    });
    return publicView(record);
  }

  function updateView(id, input, actor) {
    const normalized = normalizeId(id);
    const current = views.findOneBy("notion_id", normalized);
    if (!canRead(current, actor)) return null;
    const quickFilters = input.quick_filters === null ? {} : { ...(current.quick_filters ?? {}) };
    for (const [key, value] of Object.entries(input.quick_filters ?? {})) value === null ? delete quickFilters[key] : quickFilters[key] = structuredClone(value);
    const updated = views.update(current.id, {
      name: input.name ?? current.name, filter: Object.hasOwn(input, "filter") ? structuredClone(input.filter) : current.filter,
      sorts: Object.hasOwn(input, "sorts") ? structuredClone(input.sorts ?? []) : current.sorts,
      quick_filters: quickFilters, configuration: input.configuration ? { ...(current.configuration ?? {}), ...structuredClone(input.configuration) } : current.configuration,
      last_edited_time: now(store),
    });
    const updatedFields = ["name", "filter", "sorts", "configuration"].filter((field) => Object.hasOwn(input, field));
    if (Object.hasOwn(input, "quick_filters") && !updatedFields.includes("configuration")) updatedFields.push("configuration");
    recordChange("view.updated", normalized, actor.notion_id, {
      parent: { database_id: updated.database_id }, updated_fields: updatedFields,
    });
    return publicView(updated);
  }

  function listViews({ databaseId, dataSourceId, startCursor, pageSize = 100, actor }) {
    const all = views.all().filter((item) => canRead(item, actor) && (!databaseId || item.database_id === normalizeId(databaseId)) && (!dataSourceId || item.data_source_id === normalizeId(dataSourceId))).sort((left, right) => (left.position ?? left.id) - (right.position ?? right.id));
    const start = startCursor ? all.findIndex((item) => item.notion_id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = all.slice(start, start + pageSize);
    return listResult(selected.map((item) => ({ object: "view", id: item.notion_id })), "view", start + pageSize < all.length ? selected.at(-1)?.notion_id ?? null : null);
  }

  function deleteView(id, actor) {
    const normalized = normalizeId(id);
    const current = views.findOneBy("notion_id", normalized);
    if (!canRead(current, actor)) return null;
    if (views.findBy("database_id", current.database_id).length <= 1) return { last_view: true };
    views.delete(current.id);
    recordChange("view.deleted", normalized, actor.notion_id, { parent: { database_id: current.database_id } });
    return { object: "view", id: normalized, parent: { type: "database_id", database_id: current.database_id }, type: current.type };
  }

  function createViewQuery(viewId, { pageSize = 100 } = {}, actor) {
    const selectedView = views.findOneBy("notion_id", normalizeId(viewId));
    if (!canRead(selectedView, actor)) return null;
    const queried = queryDataSource(selectedView.data_source_id, { filter: selectedView.filter, sorts: selectedView.sorts, page_size: 10_000 }, actor);
    if (!queried || queried.validation_error) return queried;
    const timestamp = Date.parse(now(store));
    const results = queried.results.slice(0, 10_000).map((page) => ({ object: "page", id: page.id }));
    const incomplete = queried.request_status?.type === "incomplete";
    const record = viewQueries.insert({
      notion_id: nextUuid(store, "view_query"), view_id: selectedView.notion_id, actor_id: actor.notion_id,
      created_time: now(store), expires_at: new Date(timestamp + 15 * 60_000).toISOString(), results,
      request_status: incomplete ? { type: "incomplete", incomplete_reason: "query_result_limit_reached" } : null,
      deleted: false,
    });
    const selected = results.slice(0, pageSize);
    return {
      object: "view_query", id: record.notion_id, view_id: record.view_id, expires_at: record.expires_at,
      total_count: results.length, results: selected, next_cursor: selected.length < results.length ? selected.at(-1)?.id ?? null : null,
      has_more: selected.length < results.length, ...(record.request_status ? { request_status: structuredClone(record.request_status) } : {}),
    };
  }

  function viewQueryResults(viewId, queryId, { startCursor, pageSize = 100 } = {}, actor) {
    const selectedView = views.findOneBy("notion_id", normalizeId(viewId));
    const record = viewQueries.findOneBy("notion_id", normalizeId(queryId));
    if (!canRead(selectedView, actor) || !record || record.view_id !== selectedView.notion_id || record.actor_id !== actor.notion_id || record.deleted || Date.parse(record.expires_at) <= Date.parse(now(store))) return null;
    const start = startCursor ? record.results.findIndex((page) => page.id === normalizeId(startCursor)) + 1 : 0;
    if (startCursor && start === 0) return { invalid_cursor: true };
    const selected = record.results.slice(start, start + pageSize);
    return {
      object: "list", type: "page", page: {}, results: structuredClone(selected),
      next_cursor: start + pageSize < record.results.length ? selected.at(-1)?.id ?? null : null,
      has_more: start + pageSize < record.results.length,
      ...(record.request_status ? { request_status: structuredClone(record.request_status) } : {}),
    };
  }

  function deleteViewQuery(viewId, queryId, actor) {
    const selectedView = views.findOneBy("notion_id", normalizeId(viewId));
    if (!canRead(selectedView, actor)) return null;
    const normalized = normalizeId(queryId);
    const record = viewQueries.findOneBy("notion_id", normalized);
    if (record && record.view_id !== selectedView.notion_id) return null;
    if (record && !record.deleted) viewQueries.update(record.id, { deleted: true });
    return { object: "view_query", id: normalized, deleted: true };
  }

  function fetchEntity(id, actor, options = {}) {
    if (id === "self") return { type: "self", workspace: workspace(), user: user(actor.notion_id) };
    const normalized = normalizeId(id);
    const folderRecord = folders.findOneBy("notion_id", normalized);
    if (folderRecord && folderRecord.accessible_by?.includes(actor.notion_id)) return { type: "folder", record: folderRecord };
    const pageRecord = rawPage(normalized);
    if (canRead(pageRecord, actor)) return { type: "page", record: pageRecord, rendered: markdownForPage(normalized, actor), path: pagePath(pageRecord, actor), options };
    const databaseRecord = databases.findOneBy("notion_id", normalized);
    if (databaseRecord && !canRead(databaseRecord, actor)) return null;
    if (databaseRecord) return { type: "database", record: databaseRecord, data_sources: dataSources.findBy("database_id", databaseRecord.notion_id).filter((item) => canRead(item, actor)) };
    const dataSourceRecord = dataSources.findOneBy("notion_id", normalized);
    if (dataSourceRecord && !canRead(dataSourceRecord, actor)) return null;
    if (dataSourceRecord) return { type: "data_source", record: dataSourceRecord };
    const viewRecord = views.findOneBy("notion_id", normalized);
    if (viewRecord && !canRead(viewRecord, actor)) return null;
    if (viewRecord) return { type: "view", record: viewRecord };
    const blockRecord = blocks.findOneBy("notion_id", normalized);
    if (blockRecord && block(normalized, actor)) return { type: "block", record: blockRecord, text: plainBlockText(blockRecord) };
    return null;
  }

  function completeTask(type, actor, result) {
    const timestamp = now(store);
    const notionId = nextUuid(store, "async_task");
    const operation = type === "update_page_markdown"
      ? { surface: "rest", name: "PATCH /v1/pages/:page_id/markdown" }
      : { surface: "mcp", name: type === "create_pages" ? "create_pages" : "update_page" };
    const task = asyncTasks.insert({ notion_id: notionId, object: "async_task", operation, status_url: `${baseUrl}/v1/async_tasks/${notionId}`, status: "succeeded", created_time: timestamp, actor_id: actor.notion_id, result: structuredClone(result) });
    recordChange("async_task.completed", notionId, actor.notion_id);
    if (operation.surface === "rest") return { object: "async_task", id: task.notion_id, status_url: task.status_url, operation: structuredClone(task.operation), status: "queued", created_time: task.created_time, poll_after_seconds: 0 };
    return { object: "async_task", id: task.notion_id, status_url: task.status_url, operation: structuredClone(task.operation), status: task.status, created_time: task.created_time, result: structuredClone(task.result) };
  }

  function asyncTask(id, actor) {
    const task = asyncTasks.findOneBy("notion_id", normalizeId(id));
    if (!task || task.actor_id !== actor?.notion_id) return null;
    const common = { object: "async_task", id: task.notion_id, status_url: task.status_url ?? `${baseUrl}/v1/async_tasks/${task.notion_id}`, created_time: task.created_time, operation: structuredClone(task.operation ?? { surface: "rest", name: task.type ?? "unknown" }), status: task.status };
    if (["queued", "running", "retrying"].includes(task.status)) return { ...common, poll_after_seconds: task.poll_after_seconds ?? 1 };
    if (task.status === "failed") return { ...common, error: structuredClone(task.error) };
    return { ...common, result: structuredClone(task.result ?? {}) };
  }

  function duplicatePageRecord(source, parent, actor) {
    const duplicate = createPage({ parent, title: titleText(source.properties), properties: source.properties, cover: source.cover, icon: source.icon, accessible_by: source.accessible_by }, actor);
    const copyChildren = (fromParent, toParent) => {
      for (const child of blocks.findBy("parent_id", fromParent).filter((item) => !item.in_trash)) {
        const copied = createBlock(toParent, { type: child.type, [child.type]: child.value }, actor);
        copyChildren(child.notion_id, copied.id);
      }
    };
    copyChildren(source.notion_id, duplicate.id);
    return duplicate;
  }

  function mcpCreatePages(args, actor) {
    const inputs = args.pages ?? args.items ?? [args];
    const created = [];
    for (const input of inputs) {
      const parent = input.parent ?? args.parent ?? { type: "workspace", workspace: true };
      if (!canUseParent(parent, actor)) return null;
      const properties = responseProperties(input.properties ?? {});
      if (Object.hasOwn(input.properties ?? {}, "title")) properties.title = { id: "title", type: "title", title: asRichText(input.properties.title) };
      const icon = input.icon === "none" ? null : typeof input.icon === "string" ? (/^https:\/\//.test(input.icon) ? { type: "external", external: { url: input.icon } } : { type: "emoji", emoji: input.icon }) : input.icon;
      const cover = input.cover === "none" ? null : typeof input.cover === "string" ? { type: "external", external: { url: input.cover } } : input.cover;
      created.push(createPage({ ...input, parent, properties, markdown: input.content, icon, cover }, actor));
    }
    const result = { pages: created };
    return args.allow_async ? { async_task: completeTask("create_pages", actor, result) } : result;
  }

  function mcpUpdatePage(args, actor) {
    const result = updatePage(args.page_id ?? args.id, args, actor);
    return result && args.allow_async ? { async_task: completeTask("update_page", actor, result) } : result;
  }

  function publicSkill(record, actor) {
    const rendered = markdownForPage(record.notion_id, actor);
    return {
      id: record.notion_id,
      page_id: record.notion_id,
      title: titleText(record.properties),
      description: record.skill_description ?? "",
      url: record.url,
      content: rendered?.markdown ?? "",
      teamspace_id: record.teamspace_id ?? null,
      last_edited_time: record.last_edited_time,
    };
  }

  function mcpSearchSkills(args, actor) {
    const query = String(args.query ?? "").toLowerCase();
    const limit = Math.min(50, Math.max(1, args.limit ?? 10));
    const selected = pages.all().filter((record) => {
      if (!record.is_skill || record.in_trash || !canRead(record, actor)) return false;
      if (args.teamspace_id && normalizeId(record.teamspace_id) !== normalizeId(args.teamspace_id)) return false;
      if (!query) return true;
      const rendered = markdownForPage(record.notion_id, actor);
      return `${titleText(record.properties)}\n${record.skill_description ?? ""}\n${rendered?.markdown ?? ""}`.toLowerCase().includes(query);
    });
    return { skills: selected.slice(0, limit).map((record) => publicSkill(record, actor)), has_more: selected.length > limit };
  }

  function mcpConvertPageToSkill(args, actor) {
    const record = rawPage(args.page_id);
    if (!canRead(record, actor)) return null;
    const updated = pages.update(record.id, {
      is_skill: true,
      skill_description: args.description ?? record.skill_description ?? "",
      last_edited_time: now(store),
      last_edited_by: actor.notion_id,
    });
    recordChange("page.converted_to_skill", updated.notion_id, actor.notion_id);
    return { skill: publicSkill(updated, actor) };
  }

  function mcpMovePages(args, actor) {
    const ids = args.page_ids ?? args.ids ?? [args.page_id ?? args.id];
    const moved = [];
    for (const id of ids) {
      const result = movePage(id, args.parent ?? args.new_parent, actor);
      if (!result) return null;
      moved.push(result);
    }
    return { pages: moved };
  }

  function mcpDuplicatePage(args, actor) {
    const source = rawPage(args.page_id ?? args.id);
    if (!canRead(source, actor)) return null;
    const duplicate = duplicatePageRecord(source, args.parent ?? source.parent, actor);
    return { page: duplicate, async_task: completeTask("duplicate_page", actor, { page_id: duplicate.id }) };
  }

  function mcpCreateDatabase(args, actor) {
    const databaseResult = createDatabase(args, actor);
    if (!databaseResult) return null;
    const dataSourceResult = dataSources.findBy("database_id", databaseResult.id).at(0);
    const viewResult = dataSourceResult ? views.findBy("data_source_id", dataSourceResult.notion_id).at(0) : null;
    return { database: databaseResult, data_source: dataSourceResult ? renderDataSource(dataSourceResult) : null, view: viewResult ? publicView(viewResult) : null };
  }

  function mcpCreateFolder(args, actor) {
    const pageParent = args.parent?.page_id ? rawPage(args.parent.page_id) : null;
    const folderParent = args.parent?.folder_id ? folders.findOneBy("notion_id", normalizeId(args.parent.folder_id)) : null;
    if (pageParent && !canRead(pageParent, actor) || folderParent && !folderParent.accessible_by?.includes(actor.notion_id) || !pageParent && !folderParent) return null;
    const notionId = nextUuid(store, "folder");
    const timestamp = now(store);
    const record = folders.insert({
      notion_id: notionId,
      title: args.title,
      owner_page_id: pageParent?.notion_id ?? folderParent.owner_page_id,
      parent_folder_id: folderParent?.notion_id ?? null,
      files: [],
      child_folder_ids: [],
      accessible_by: [...new Set([actor.notion_id, ...(pageParent?.accessible_by ?? []), ...(folderParent?.accessible_by ?? [])])],
      created_time: timestamp,
      last_edited_time: timestamp,
      created_by: actor.notion_id,
    });
    if (folderParent) folders.update(folderParent.id, { child_folder_ids: [...folderParent.child_folder_ids, notionId], last_edited_time: timestamp });
    return { id: record.notion_id, title: record.title, url: `folder://${record.notion_id}` };
  }

  function mcpUpdateFolder(args, actor) {
    const record = folders.findOneBy("notion_id", normalizeId(args.folder_id));
    if (!record?.accessible_by?.includes(actor.notion_id)) return null;
    if (args.command === "add_files") {
      const uploads = args.file_upload_ids.map((id) => fileUploads.findOneBy("notion_id", normalizeId(id)));
      if (uploads.some((upload) => !upload || upload.created_by !== actor.notion_id || upload.status !== "uploaded")) return null;
      const additions = uploads.map((upload) => ({ file_upload_id: upload.notion_id, name: upload.filename, url: `${baseUrl}/v1/file_uploads/${upload.notion_id}` }));
      const byUrl = new Map([...(record.files ?? []), ...additions].map((file) => [file.url, file]));
      const updated = folders.update(record.id, { files: [...byUrl.values()], last_edited_time: now(store) });
      return { id: updated.notion_id, title: updated.title, files: structuredClone(updated.files), child_folder_ids: structuredClone(updated.child_folder_ids) };
    }
    if (args.command === "remove_files") {
      const requested = new Set(args.file_urls);
      const updated = folders.update(record.id, { files: (record.files ?? []).filter((file) => !requested.has(file.url)), last_edited_time: now(store) });
      return { id: updated.notion_id, title: updated.title, files: structuredClone(updated.files), child_folder_ids: structuredClone(updated.child_folder_ids) };
    }
    return mcpCreateFolder({ parent: { folder_id: record.notion_id }, title: args.title }, actor);
  }

  function mcpListSidebarPages(args, actor, section) {
    // `??`, not `||`. The captured tool contract declares `limit` as a plain
    // number with no minimum and `validateToolInput` does not range-check it, so
    // `limit: 0` reaches here -- and `Number(0) || 100` made it mean a hundred
    // pages. `Math.max(1, …)` still clamps it to the smallest page the API can
    // return, which is what `mcpSearchSkills` two hundred lines up already does.
    // A non-numeric `limit` is the one case the old `||` handled correctly, so it
    // is handled explicitly rather than left to fall out of NaN comparisons.
    const requested = Number(args.limit ?? 100);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requested) ? requested : 100));
    let found = pages.all().filter((record) => canRead(record, actor) && !record.in_trash);
    if (section === "private") found = found.filter((record) => record.sidebar_section === "private" && record.parent?.type === "workspace");
    if (section === "shared") found = found.filter((record) => record.sidebar_section === "shared");
    if (section === "favorite") found = found.filter((record) => record.favorited_by?.includes(actor.notion_id));
    if (section === "recent") found.sort((left, right) => String(right.last_viewed_by?.[actor.notion_id] ?? right.last_edited_time).localeCompare(String(left.last_viewed_by?.[actor.notion_id] ?? left.last_edited_time)));
    const start = args.cursor ? found.findIndex((record) => record.notion_id === normalizeId(args.cursor)) + 1 : 0;
    if (args.cursor && start === 0) return null;
    const selected = found.slice(start, start + limit);
    return {
      results: selected.map((record) => ({ id: record.notion_id, title: titleText(record.properties) || "Untitled", url: record.url, type: "page", last_edited_time: record.last_edited_time })),
      has_more: start + limit < found.length,
      next_cursor: start + limit < found.length ? selected.at(-1)?.notion_id ?? null : null,
    };
  }

  function mcpUpdateDataSource(args, actor) { return updateDataSource(args.data_source_id ?? args.id, { ...args, ...(Object.hasOwn(args, "name") ? { title: args.name } : {}) }, actor); }
  function mcpCreateView(args, actor) {
    const source = dataSources.findOneBy("notion_id", normalizeId(args.data_source_id));
    return createView({ ...args, database_id: args.database_id ?? source?.database_id }, actor);
  }
  function mcpUpdateView(args, actor) { return updateView(args.view_id ?? args.id, args, actor); }
  function sqlScalar(value) {
    if (value === null || value === undefined) return null;
    if (["string", "number", "bigint"].includes(typeof value)) return value;
    if (typeof value === "boolean") return value ? "__YES__" : "__NO__";
    if (Array.isArray(value)) {
      // An EMPTY array is an empty cell, not a value to be described. `[]` joins
      // to `""`, and `|| JSON.stringify(value)` turned that into the two-character
      // string `[]` -- so `SELECT "Tags"` on a page with no tags returned the
      // literal text `[]` where every other empty property returns nothing.
      // `propertyValue` returns `[]` for an unset multi_select, people, relation
      // or files property, so this was every one of them.
      if (value.length === 0) return null;
      const text = value.map((item) => item?.plain_text ?? item?.text?.content ?? item?.name ?? item?.id ?? item).join(", ");
      return text === "" ? JSON.stringify(value) : text;
    }
    return JSON.stringify(value);
  }
  function quoteSqlIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }
  function mcpQuerySql(ids, args, actor) {
    if (!/^\s*(select|with)\b/i.test(args.query ?? "")) {
      const error = new Error("Only read-only SELECT or WITH queries are supported.");
      error.code = "validation_error";
      throw error;
    }
    const sources = ids.map((id) => dataSources.findOneBy("notion_id", normalizeId(id)));
    if (sources.some((source) => !canRead(source, actor))) return null;
    const database = new DatabaseSync(":memory:");
    try {
      for (const source of sources) {
        const sourcePages = pages.all().filter((page) => canRead(page, actor) && !page.in_trash && normalizeId(page.parent?.data_source_id) === source.notion_id);
        const columns = [...new Set(["id", "url", ...Object.keys(source.properties ?? {}), ...sourcePages.flatMap((page) => Object.keys(page.properties ?? {}))])];
        database.exec(`CREATE TABLE ${quoteSqlIdentifier(`collection://${source.notion_id}`)} (${columns.map((name) => `${quoteSqlIdentifier(name)} BLOB`).join(", ")})`);
        const insert = database.prepare(`INSERT INTO ${quoteSqlIdentifier(`collection://${source.notion_id}`)} (${columns.map(quoteSqlIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
        for (const page of sourcePages) {
          const values = columns.map((name) => name === "id" ? page.notion_id : name === "url" ? page.url : sqlScalar(propertyValue(page.properties?.[name])));
          insert.run(...values);
        }
      }
      database.exec("PRAGMA query_only = ON");
      const all = database.prepare(args.query).all(...(args.params ?? []).map(sqlScalar));
      const limit = 10_000;
      return { results: all.slice(0, limit), data_source_ids: sources.map((source) => source.notion_id), truncated: all.length > limit };
    } catch (cause) {
      const error = new Error(`The SQL query is invalid: ${cause.message}`);
      error.code = "validation_error";
      throw error;
    } finally {
      database.close();
    }
  }
  function mcpQueryDataSources(args, actor) {
    const ids = args.data_source_urls ?? args.data_source_ids ?? (args.data_source_url ? [args.data_source_url] : args.data_source_id ? [args.data_source_id] : []);
    if (args.view_url) {
      const selectedView = views.findOneBy("notion_id", normalizeId(args.view_url));
      if (!canRead(selectedView, actor)) return null;
      ids.push(selectedView.data_source_id);
    }
    if (args.query) return mcpQuerySql([...new Set(ids.map(normalizeId))], args, actor);
    const results = [];
    for (const id of ids) {
      const response = queryDataSource(id, args, actor);
      if (!response || response.invalid_cursor) return null;
      results.push(...response.results);
    }
    return { results, has_more: false };
  }
  function mcpQueryMeetingNotes(args, actor) {
    const result = queryMeetingNotes(args, actor);
    if (result.validation_error) {
      const error = new Error(result.validation_error);
      error.code = "validation_error";
      throw error;
    }
    return result;
  }
  function mcpGetTeams(args, actor) {
    const query = String(args.query ?? "").toLowerCase();
    const id = args.team_id ? normalizeId(args.team_id) : null;
    const teams = teamspaces.all().filter((team) => (!id || team.notion_id === id) && (!query || team.name.toLowerCase().includes(query))).map((team) => ({
      id: team.notion_id,
      name: team.name,
      membership: (team.member_ids ?? []).includes(actor.notion_id) ? "member" : "not_member",
    }));
    return { teams };
  }
  function mcpGetUsers(args, actor) {
    const query = String(args.query ?? "").toLowerCase();
    const id = args.user_id === "self" ? actor.notion_id : args.user_id ? normalizeId(args.user_id) : null;
    const limit = Math.min(100, Math.max(1, args.page_size ?? 100));
    const found = users.all().filter((item) => (!id || item.notion_id === id) && (!query || item.name.toLowerCase().includes(query) || String(item.email ?? "").toLowerCase().includes(query)));
    const start = args.start_cursor ? found.findIndex((item) => item.notion_id === normalizeId(args.start_cursor)) + 1 : 0;
    if (args.start_cursor && start === 0) return null;
    const selected = found.slice(start, start + limit);
    return { users: selected.map((item) => ({ ...publicUser(item), is_current_user: item.notion_id === actor.notion_id })), has_more: start + limit < found.length, next_cursor: start + limit < found.length ? selected.at(-1)?.notion_id ?? null : null };
  }
  function mcpGetSelf(_args, actor) {
    return { workspace: workspace(), user: publicUser(actor), file_upload_limit_bytes: 5 * 1024 * 1024 * 1024 };
  }
  function mcpGetAsyncTask(args, actor) { return asyncTask(args.task_id ?? args.id, actor); }
  function observability() { return { changes: structuredClone(changes.all()), asyncTasks: structuredClone(asyncTasks.all()) }; }

  function isMcpToken(token) {
    const grant = token ? oauthTokens.findOneBy("token", token) : null;
    return Boolean(grant && (grant.kind === "mcp" || String(grant.resource ?? "").endsWith("/mcp")));
  }

  function isActiveMcpToken(token) {
    const grant = token ? oauthTokens.findOneBy("token", token) : null;
    return Boolean(grant?.active && (grant.kind === "mcp" || String(grant.resource ?? "").endsWith("/mcp")) && (!grant.expires_at || grant.expires_at > Date.now()));
  }

  function workspace() {
    return structuredClone(store.getData("notion_workspace") ?? { id: "worldfixture-notion-workspace", name: "WorldFixture" });
  }

  return {
    userByLogin, user, listUsers, listCustomEmojis, page, pageProperty, createPage, updatePage, movePage,
    block, children, appendChildren, updateBlock, deleteBlock, createMeetingNote, queryMeetingNotes, search,
    database, createDatabase, updateDatabase, dataSource, createDataSource, updateDataSource, dataSourceTemplates, queryDataSource,
    view, createView, updateView, listViews, deleteView, createViewQuery, viewQueryResults, deleteViewQuery, asyncTask, observability,
    markdownForPage, updatePageMarkdown,
    comment, listComments, createComment, updateComment, deleteComment,
    createFileUpload, fileUpload, fileUploadStorage, listFileUploads, recordFileUploadPart, completeFileUpload,
    mcpSearch, fetchEntity, mcpCreatePages, mcpUpdatePage, mcpMovePages, mcpDuplicatePage, mcpCreateDatabase,
    mcpCreateFolder, mcpUpdateFolder, mcpListSidebarPages, mcpUpdateDataSource, mcpCreateView, mcpUpdateView, mcpQueryDataSources, mcpQueryMeetingNotes,
    mcpSearchSkills, mcpConvertPageToSkill, mcpGetTeams, mcpGetUsers, mcpGetSelf, mcpGetAsyncTask,
    mcpCreateFileUpload, mcpCreateAttachment, mcpDownloadAttachment, mcpCreateComment, mcpGetComments,
    isMcpToken, isActiveMcpToken, workspace,
  };
}

export function seedNotion(store, baseUrl, config = {}) {
  store.setData("notion_workspace", structuredClone(config.workspace ?? { id: "worldfixture-notion-workspace", name: "WorldFixture" }));
  store.setData("notion_object_store", structuredClone(config.object_store ?? { bucket: "worldfixture-documents", prefix: "notion/uploads" }));
  const users = collection(store, "users", ["notion_id", "email"]);
  const databases = collection(store, "databases", ["notion_id"]);
  const dataSources = collection(store, "dataSources", ["notion_id", "database_id"]);
  const views = collection(store, "views", ["notion_id", "database_id", "data_source_id"]);
  const customEmojis = collection(store, "customEmojis", ["notion_id", "name"]);
  const comments = collection(store, "comments", ["notion_id", "discussion_id", "parent_id", "created_by"]);
  const fileUploads = collection(store, "fileUploads", ["notion_id", "created_by", "status"]);
  const blocks = collection(store, "blocks", ["notion_id", "parent_id"]);
  const teamspaces = collection(store, "teamspaces", ["notion_id", "name"]);
  const domain = createNotionDomain(store, baseUrl);
  const seededUsers = config.users ?? [];
  for (let index = 0; index < seededUsers.length; index += 1) {
    const input = seededUsers[index];
    users.insert({
      notion_id: input.id ?? `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      type: input.type ?? "person",
      name: input.name,
      email: input.email,
      avatar_url: input.avatar_url ?? null,
      workspace_name: config.workspace?.name ?? "WorldFixture",
    });
  }
  const actor = users.all()[0];
  if (!actor) return;
  for (const input of config.teamspaces ?? []) teamspaces.insert({ notion_id: normalizeId(input.id), name: input.name, member_ids: (input.member_ids ?? []).map(normalizeId) });
  for (const input of config.custom_emojis ?? []) customEmojis.insert({ notion_id: normalizeId(input.id), name: input.name, url: input.url });
  for (const input of config.databases ?? []) databases.insert({
    notion_id: normalizeId(input.id), title: input.title, description: input.description ?? "", parent: structuredClone(input.parent ?? { type: "workspace", workspace: true }), database_type: input.database_type ?? null,
    created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? DEFAULT_TIME, created_by: normalizeId(input.created_by ?? actor.notion_id), last_edited_by: normalizeId(input.last_edited_by ?? input.created_by ?? actor.notion_id),
    icon: input.icon ?? null, cover: input.cover ?? null, is_inline: Boolean(input.is_inline),
    url: input.url ?? `${baseUrl}/notion/${normalizeId(input.id).replaceAll("-", "")}`, public_url: input.public_url ?? null, accessible_by: structuredClone(input.accessible_by ?? []), in_trash: Boolean(input.in_trash), is_locked: Boolean(input.is_locked),
  });
  for (const input of config.data_sources ?? []) dataSources.insert({
    notion_id: normalizeId(input.id), database_id: normalizeId(input.database_id), name: input.name, title: asRichText(input.title ?? input.name), description: input.description ?? "", properties: responseSchema(input.properties), database_type: input.database_type ?? null, is_inline: Boolean(input.is_inline), cover: input.cover ?? null,
    created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? DEFAULT_TIME, created_by: normalizeId(input.created_by ?? actor.notion_id), last_edited_by: normalizeId(input.last_edited_by ?? input.created_by ?? actor.notion_id),
    templates: structuredClone(input.templates ?? []), icon: input.icon ?? null, url: input.url ?? `collection://${normalizeId(input.id)}`, public_url: input.public_url ?? null,
    accessible_by: structuredClone(input.accessible_by ?? []), in_trash: Boolean(input.in_trash), is_locked: Boolean(input.is_locked), is_wiki: Boolean(input.is_wiki),
    database_parent: structuredClone(input.database_parent ?? null), parent_data_source_id: input.parent_data_source_id ? normalizeId(input.parent_data_source_id) : null,
  });
  for (const input of config.views ?? []) views.insert({
    notion_id: normalizeId(input.id), database_id: normalizeId(input.database_id), data_source_id: normalizeId(input.data_source_id), name: input.name, type: input.type ?? "table",
    created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? input.created_time ?? DEFAULT_TIME,
    url: input.url ?? `${baseUrl}/notion/${normalizeId(input.database_id).replaceAll("-", "")}?v=${normalizeId(input.id).replaceAll("-", "")}`,
    filter: structuredClone(input.filter ?? null), sorts: structuredClone(input.sorts ?? []), quick_filters: structuredClone(input.quick_filters ?? {}), configuration: structuredClone(input.configuration ?? {}), accessible_by: structuredClone(input.accessible_by ?? []),
  });
  for (const input of config.pages ?? []) domain.createPage(input, actor, { seedSyntax: true });
  for (const input of config.meeting_notes ?? []) {
    const parentId = normalizeId(input.parent?.page_id);
    const createdBy = normalizeId(input.created_by ?? actor.notion_id);
    blocks.insert({
      notion_id: normalizeId(input.id), parent_id: parentId, parent: { type: "page_id", page_id: parentId },
      created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? input.created_time ?? DEFAULT_TIME,
      created_by: createdBy, last_edited_by: normalizeId(input.last_edited_by ?? createdBy), has_children: Boolean(input.children),
      position: blocks.findBy("parent_id", parentId).length, in_trash: Boolean(input.in_trash), type: "meeting_notes",
      value: {
        title: input.rich_text ? structuredClone(input.rich_text) : richText(input.title ?? "Meeting notes"),
        status: input.status ?? "transcription_not_started",
        ...(input.children ? { children: structuredClone(input.children) } : {}),
        ...(input.calendar_event ? { calendar_event: structuredClone(input.calendar_event) } : {}),
        ...(input.recording ? { recording: structuredClone(input.recording) } : {}),
      },
      worldfixture_calendar_event_id: input.worldfixture_calendar_event_id ?? null,
    });
  }
  for (const input of config.comments ?? []) {
    const parent = normalizedSeedParent(input.parent);
    comments.insert({
      notion_id: normalizeId(input.id), parent, parent_id: parent.page_id ?? parent.block_id,
      discussion_id: normalizeId(input.discussion_id ?? input.id), created_time: input.created_time ?? DEFAULT_TIME,
      last_edited_time: input.last_edited_time ?? input.created_time ?? DEFAULT_TIME, created_by: normalizeId(input.created_by ?? actor.notion_id),
      rich_text: input.rich_text ? structuredClone(input.rich_text) : richText(input.markdown ?? ""), attachments: structuredClone(input.attachments ?? []),
      display_name: structuredClone(input.display_name ?? { type: "user", resolved_name: users.findOneBy("notion_id", normalizeId(input.created_by))?.name ?? actor.name }),
      integration_created: Boolean(input.integration_created), worldfixture_message_id: input.worldfixture_message_id ?? null,
      worldfixture_channel_id: input.worldfixture_channel_id ?? null,
    });
  }
  for (const input of config.file_uploads ?? []) fileUploads.insert({
    notion_id: normalizeId(input.id), created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? input.created_time ?? DEFAULT_TIME,
    created_by: normalizeId(input.created_by ?? actor.notion_id), expiry_time: input.expiry_time ?? null, status: input.status ?? "uploaded",
    mode: input.mode ?? "single_part", filename: input.filename ?? null, content_type: input.content_type ?? null, content_length: input.content_length ?? null,
    number_of_parts: input.number_of_parts ?? 1, sent_parts: structuredClone(input.sent_parts ?? [1]), external_url: input.external_url ?? null,
    file_import_result: structuredClone(input.file_import_result ?? null), object_bucket: input.object_bucket ?? config.object_store?.bucket,
    object_key: input.object_key, worldfixture_document_id: input.worldfixture_document_id ?? null, worldfixture_owner_id: input.worldfixture_owner_id ?? null,
  });
  collection(store, "changes", ["sequence", "object_id"]).clear();
}

function normalizedSeedParent(parent) {
  if (parent?.block_id) return { type: "block_id", block_id: normalizeId(parent.block_id) };
  return { type: "page_id", page_id: normalizeId(parent?.page_id) };
}

export { normalizeId, titleText };
