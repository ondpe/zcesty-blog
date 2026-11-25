const crypto = require("crypto");

const COOKIE_NAME = "zcesty_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const POST_PATH_RE = /^posts\/[a-z0-9][a-z0-9-]*\.md$/;
const IMAGE_PATH_RE = /^images\/[a-z0-9][a-z0-9._-]*\.jpg$/i;
const SHA_RE = /^[a-f0-9]{40}$/i;
const MAX_IMAGE_BASE64_LENGTH = 5_500_000;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = parseBody(event.body);
    const action = body.action;

    if (action === "login") {
      return await login(body.password, event);
    }

    if (action === "logout") {
      return logout(event);
    }

    const auth = requireAuth(event);
    if (!auth.ok) {
      return json(401, { error: auth.error });
    }

    if (action === "posts") {
      return await listPosts();
    }

    if (action === "post") {
      return await getPost(body.path);
    }

    if (action === "uploadImage") {
      return await uploadImage(body);
    }

    if (action === "save") {
      return await savePost(body);
    }

    if (action === "delete") {
      return await deletePost(body.path, body.expectedSha);
    }

    return json(400, { error: "Unknown action" });
  } catch (error) {
    console.error(error);
    return json(error.status || 500, {
      error: error.message || "Unexpected error",
      ...(error.code ? { code: error.code } : {}),
    });
  }
};

async function login(password, event) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return json(500, { error: "ADMIN_PASSWORD is not configured" });
  }

  if (!safeEqual(password || "", expected)) {
    await sleep(500);
    return json(401, { error: "Neplatné heslo" });
  }

  const token = signToken();
  return json(200, { ok: true }, { "set-cookie": buildSessionCookie(token, event, SESSION_TTL_SECONDS) });
}

function logout(event) {
  return json(200, { ok: true }, { "set-cookie": buildSessionCookie("", event, 0) });
}

async function listPosts() {
  let posts;
  try {
    posts = await listPostsGraphql();
  } catch (error) {
    console.warn("GraphQL listPosts failed, falling back to REST:", error.message);
    posts = await listPostsRest();
  }

  posts.sort(comparePosts);
  return json(200, { posts });
}

async function listPostsGraphql() {
  const [owner, name] = repo().split("/");
  if (!owner || !name) {
    throw statusError(500, "GITHUB_REPO must be in owner/name format");
  }

  const expression = `${branch()}:posts`;
  const data = await githubGraphql(
    `query ListPosts($owner: String!, $name: String!, $expression: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $expression) {
          ... on Tree {
            entries {
              name
              type
              oid
              object {
                ... on Blob {
                  text
                }
              }
            }
          }
        }
      }
    }`,
    { owner, name, expression }
  );

  const entries = data?.repository?.object?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Posts tree not found in GraphQL response");
  }

  return entries
    .filter(entry => entry.type === "blob" && entry.name.endsWith(".md"))
    .map(entry => {
      const text = entry.object && typeof entry.object.text === "string" ? entry.object.text : "";
      const parsed = parseFrontmatter(text);
      return summarizePost(`posts/${entry.name}`, entry.oid, parsed.data, entry.name);
    });
}

async function listPostsRest() {
  const files = await githubJson(`/repos/${repo()}/contents/posts?ref=${encodeURIComponent(branch())}`);
  const markdownFiles = files.filter(file => file.type === "file" && file.name.endsWith(".md"));

  const posts = await Promise.all(
    markdownFiles.map(async file => {
      const post = await getContent(file.path);
      const parsed = parseFrontmatter(post.content);
      return summarizePost(file.path, post.sha, parsed.data, file.name);
    })
  );

  return posts;
}

function summarizePost(path, sha, data, fallbackTitle) {
  return {
    path,
    sha,
    title: data.title || fallbackTitle,
    date: normalizeDateString(data.date),
    summary: data.summary || "",
    hero: data.hero || "",
    tags: normalizeTags(data.tags),
    draft: Boolean(data.draft),
  };
}

function comparePosts(a, b) {
  const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
  if (dateCompare !== 0) return dateCompare;
  return String(b.path || "").localeCompare(String(a.path || ""));
}

async function getPost(path) {
  assertSafePostPath(path);
  const post = await getContent(path);
  const parsed = parseFrontmatter(post.content);
  return json(200, {
    post: {
      path,
      sha: post.sha,
      frontmatter: parsed.data,
      body: parsed.body,
    },
  });
}

async function uploadImage(body) {
  const filename = String(body.filename || "").trim();
  const base64 = String(body.base64 || "").trim();
  const imagePath = `images/${filename}`;

  assertSafeImagePath(imagePath);
  if (!base64) {
    throw statusError(400, "Missing image data");
  }
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
    throw statusError(413, "Obrázek je i po zmenšení příliš velký.");
  }

  const blob = await createBlob(base64, "base64");
  return json(200, {
    filename,
    path: imagePath,
    sha: blob.sha,
  });
}

async function savePost(body) {
  const frontmatter = body.frontmatter || {};
  const postBody = typeof body.body === "string" ? body.body : "";
  const images = Array.isArray(body.images) ? body.images : [];
  const imageBlobs = Array.isArray(body.imageBlobs) ? body.imageBlobs : [];
  const isNew = !body.path;
  const path = body.path || makePostPath(frontmatter.title, frontmatter.date);

  assertSafePostPath(path);
  images.forEach(image => assertSafeImagePath(`images/${image.filename}`));
  imageBlobs.forEach(image => {
    assertSafeImagePath(`images/${image.filename}`);
    if (!SHA_RE.test(String(image.sha || ""))) {
      throw statusError(400, "Invalid image blob SHA");
    }
  });

  if (body.expectedSha) {
    const existing = await getContentOrNull(path);
    if (existing && existing.sha !== body.expectedSha) {
      throw statusError(
        409,
        "Článek byl mezitím upraven jinde. Znovu ho načti, než změny uložíš.",
        "CONFLICT"
      );
    }
  }

  const ref = await githubJson(`/repos/${repo()}/git/ref/heads/${encodeURIComponent(branch())}`);
  const headSha = ref.object.sha;
  const headCommit = await githubJson(`/repos/${repo()}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  const postBlob = await createBlob(stringifyPost(frontmatter, postBody), "utf-8");
  const treeItems = [
    {
      path,
      mode: "100644",
      type: "blob",
      sha: postBlob.sha,
    },
  ];

  const savedImages = [];

  for (const image of imageBlobs) {
    const imagePath = `images/${image.filename}`;
    treeItems.push({
      path: imagePath,
      mode: "100644",
      type: "blob",
      sha: image.sha,
    });
    savedImages.push(imagePath);
  }

  if (images.length > 0) {
    const createdBlobs = await Promise.all(
      images
        .filter(image => image && image.base64)
        .map(async image => {
          const blob = await createBlob(image.base64, "base64");
          return { path: `images/${image.filename}`, sha: blob.sha };
        })
    );
    createdBlobs.forEach(item => {
      treeItems.push({
        path: item.path,
        mode: "100644",
        type: "blob",
        sha: item.sha,
      });
      savedImages.push(item.path);
    });
  }

  const tree = await githubJson(`/repos/${repo()}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree: treeItems,
    },
  });

  const title = frontmatter.title || path.split("/").pop();
  const commit = await githubJson(`/repos/${repo()}/git/commits`, {
    method: "POST",
    body: {
      message: `${isNew ? "Create" : "Update"} post: ${title}`,
      tree: tree.sha,
      parents: [headSha],
    },
  });

  await githubJson(`/repos/${repo()}/git/refs/heads/${encodeURIComponent(branch())}`, {
    method: "PATCH",
    body: {
      sha: commit.sha,
      force: false,
    },
  });

  return json(200, {
    path,
    sha: postBlob.sha,
    commit: commit.sha,
    images: savedImages,
  });
}

async function deletePost(path, expectedSha) {
  assertSafePostPath(path);

  const post = await getContent(path);
  if (expectedSha && post.sha !== expectedSha) {
    throw statusError(
      409,
      "Článek byl mezitím upraven jinde. Znovu ho načti, než ho smažeš.",
      "CONFLICT"
    );
  }

  const ref = await githubJson(`/repos/${repo()}/git/ref/heads/${encodeURIComponent(branch())}`);
  const headSha = ref.object.sha;
  const headCommit = await githubJson(`/repos/${repo()}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  const tree = await githubJson(`/repos/${repo()}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree: [
        {
          path,
          mode: "100644",
          type: "blob",
          sha: null,
        },
      ],
    },
  });

  const commit = await githubJson(`/repos/${repo()}/git/commits`, {
    method: "POST",
    body: {
      message: `Delete post: ${path.split("/").pop()}`,
      tree: tree.sha,
      parents: [headSha],
    },
  });

  await githubJson(`/repos/${repo()}/git/refs/heads/${encodeURIComponent(branch())}`, {
    method: "PATCH",
    body: {
      sha: commit.sha,
      force: false,
    },
  });

  return json(200, {
    path,
    deleted: post.sha,
    commit: commit.sha,
  });
}

async function getContent(path) {
  const file = await githubJson(
    `/repos/${repo()}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch())}`
  );
  const content = Buffer.from(file.content || "", "base64").toString("utf8");
  return { content, sha: file.sha };
}

async function getContentOrNull(path) {
  try {
    return await getContent(path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function createBlob(content, encoding) {
  return githubJson(`/repos/${repo()}/git/blobs`, {
    method: "POST",
    body: {
      content,
      encoding,
    },
  });
}

async function githubGraphql(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw statusError(500, "GITHUB_TOKEN is not configured");
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "zcesty-blog-cms",
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await parseGithubResponse(response);
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    throw statusError(502, data.errors[0].message || "GitHub GraphQL error");
  }
  return data.data;
}

async function githubJson(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw statusError(500, "GITHUB_TOKEN is not configured");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "zcesty-blog-cms",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return parseGithubResponse(response);
}

async function parseGithubResponse(response) {
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (!response.ok) {
        throw statusError(response.status, `GitHub API error (${response.status})`);
      }
      throw statusError(502, "Unexpected non-JSON response from GitHub API");
    }
  }

  if (!response.ok) {
    throw statusError(response.status, data.message || `GitHub API error (${response.status})`);
  }

  return data;
}

function parseBody(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw statusError(400, "Invalid JSON payload");
  }
}

function parseFrontmatter(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: normalized };
  }

  return {
    data: parseYamlish(match[1]),
    body: match[2],
  };
}

function parseYamlish(input) {
  const data = {};
  const lines = input.split("\n");
  let pendingListKey = null;

  for (const line of lines) {
    if (pendingListKey) {
      const listMatch = line.match(/^\s+-\s+(.*)$/);
      if (listMatch) {
        if (!Array.isArray(data[pendingListKey])) {
          data[pendingListKey] = [];
        }
        data[pendingListKey].push(parseYamlishScalar(listMatch[1].trim()));
        continue;
      }
      if (line.trim() !== "") {
        pendingListKey = null;
      }
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue === "") {
      data[key] = "";
      pendingListKey = key;
      continue;
    }

    data[key] = parseYamlishValue(rawValue);
  }

  return data;
}

function parseYamlishValue(value) {
  if (!value) return "";
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value);
  }
  return parseYamlishScalar(value);
}

function parseYamlishScalar(value) {
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return "";

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

function parseInlineArray(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    // Fall through to YAML single-quoted / bare list parsing
  }

  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        current += ch + inner[i + 1];
        i += 1;
      } else if (ch === quote) {
        current += ch;
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      const trimmed = current.trim();
      if (trimmed) items.push(parseYamlishScalar(trimmed));
      current = "";
    } else {
      current += ch;
    }
  }

  const tail = current.trim();
  if (tail) items.push(parseYamlishScalar(tail));
  return items;
}

function stringifyPost(frontmatter, body) {
  const fields = ["title", "date", "tags", "summary", "hero", "draft"];
  const lines = ["---"];

  const emit = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    if (key === "draft" && !value) return;
    if (Array.isArray(value) && value.length === 0) return;
    lines.push(`${key}: ${formatYamlValue(value)}`);
  };

  fields.forEach(field => emit(field, frontmatter[field]));

  Object.keys(frontmatter)
    .filter(key => !fields.includes(key))
    .sort()
    .forEach(key => emit(key, frontmatter[key]));

  lines.push("---", "", String(body || "").trim(), "");
  return lines.join("\n");
}

function formatYamlValue(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => JSON.stringify(String(item))).join(", ")}]`;
  }
  return JSON.stringify(String(value));
}

function normalizeDateString(value) {
  return String(value || "").slice(0, 10);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean).map(String);
  if (typeof tags === "string" && tags.trim()) return [tags.trim()];
  return [];
}

function makePostPath(title, date) {
  const day = String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const slug = slugify(title || "novy-clanek") || "novy-clanek";
  return `posts/${day}-${slug}.md`;
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertSafePostPath(path) {
  if (typeof path !== "string" || !POST_PATH_RE.test(path)) {
    throw statusError(400, "Unsafe post path");
  }
}

function assertSafeImagePath(path) {
  if (typeof path !== "string" || !IMAGE_PATH_RE.test(path)) {
    throw statusError(400, "Unsafe image path");
  }
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repo() {
  const value = process.env.GITHUB_REPO;
  if (!value) throw statusError(500, "GITHUB_REPO is not configured");
  return value;
}

function branch() {
  return process.env.GITHUB_BRANCH || "master";
}

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) {
    throw statusError(500, "ADMIN_SESSION_SECRET is not configured");
  }
  return secret;
}

function signToken() {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = base64Url(JSON.stringify(payload));
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
}

function requireAuth(event) {
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || "";
  const cookieHeader = headers.cookie || headers.Cookie || "";
  const cookies = parseCookies(cookieHeader);

  const bearerToken = String(authHeader).replace(/^Bearer\s+/i, "").trim();
  const token = cookies[COOKIE_NAME] || bearerToken;

  if (!token) return { ok: false, error: "Nejste přihlášeni" };

  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "Neplatné přihlášení" };
  const [encoded, signature] = parts;

  if (!encoded || !signature || !safeEqual(signature, hmac(encoded))) {
    return { ok: false, error: "Neplatné přihlášení" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    return { ok: false, error: "Neplatné přihlášení" };
  }

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "Přihlášení vypršelo" };
  }

  return { ok: true };
}

function parseCookies(header) {
  const result = {};
  String(header || "")
    .split(";")
    .forEach(part => {
      const idx = part.indexOf("=");
      if (idx === -1) return;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) result[key] = decodeURIComponent(val);
    });
  return result;
}

function isHttps(event) {
  const headers = event?.headers || {};
  const proto = headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "";
  if (proto) return proto.split(",")[0].trim() === "https";
  const host = headers.host || headers.Host || "";
  return !/^localhost(:\d+)?$/i.test(host) && !/^127\.0\.0\.1(:\d+)?$/i.test(host);
}

function buildSessionCookie(token, event, maxAge) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/.netlify/functions/cms-api",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps(event)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function hmac(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function statusError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...jsonHeaders,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

exports._internal = {
  parseFrontmatter,
  stringifyPost,
  assertSafePostPath,
  assertSafeImagePath,
  slugify,
  makePostPath,
  signToken,
  requireAuth,
  parseCookies,
  comparePosts,
};
