const crypto = require("crypto");

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
      return login(body.password);
    }

    const auth = requireAuth(event.headers.authorization || event.headers.Authorization);
    if (!auth.ok) {
      return json(401, { error: auth.error });
    }

    if (action === "posts") {
      return listPosts();
    }

    if (action === "post") {
      return getPost(body.path);
    }

    if (action === "save") {
      return savePost(body);
    }

    if (action === "delete") {
      return deletePost(body.path);
    }

    return json(400, { error: "Unknown action" });
  } catch (error) {
    console.error(error);
    return json(error.status || 500, { error: error.message || "Unexpected error" });
  }
};

function login(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return json(500, { error: "ADMIN_PASSWORD is not configured" });
  }

  if (!safeEqual(password || "", expected)) {
    return json(401, { error: "Invalid password" });
  }

  return json(200, { token: signToken() });
}

async function listPosts() {
  const files = await githubJson(`/repos/${repo()}/contents/posts?ref=${encodeURIComponent(branch())}`);
  const markdownFiles = files
    .filter(file => file.type === "file" && file.name.endsWith(".md"))
    .sort((a, b) => b.name.localeCompare(a.name));

  const posts = await Promise.all(
    markdownFiles.map(async file => {
      const post = await getContent(file.path);
      const parsed = parseFrontmatter(post.content);
      return {
        path: file.path,
        sha: post.sha,
        title: parsed.data.title || file.name,
        date: parsed.data.date || "",
        summary: parsed.data.summary || "",
        hero: parsed.data.hero || "",
        tags: parsed.data.tags || [],
      };
    })
  );

  return json(200, { posts });
}

async function getPost(path) {
  assertSafePath(path, "posts", ".md");
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

async function savePost(body) {
  const frontmatter = body.frontmatter || {};
  const postBody = body.body || "";
  const images = Array.isArray(body.images) ? body.images : [];
  const path = body.path || makePostPath(frontmatter.title, frontmatter.date);

  assertSafePath(path, "posts", ".md");
  images.forEach(image => assertSafePath(`images/${image.filename}`, "images", ".jpg"));

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

  for (const image of images) {
    if (!image.base64) continue;
    const imageBlob = await createBlob(image.base64, "base64");
    treeItems.push({
      path: `images/${image.filename}`,
      mode: "100644",
      type: "blob",
      sha: imageBlob.sha,
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
      message: `Update post: ${title}`,
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
    commit: commit.sha,
    images: images.map(image => `images/${image.filename}`),
  });
}

async function deletePost(path) {
  assertSafePath(path, "posts", ".md");

  const post = await getContent(path);
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

async function createBlob(content, encoding) {
  return githubJson(`/repos/${repo()}/git/blobs`, {
    method: "POST",
    body: {
      content,
      encoding,
    },
  });
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

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw statusError(response.status, data.message || "GitHub API error");
  }

  return data;
}

function parseBody(body) {
  if (!body) return {};
  return JSON.parse(body);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: content };
  }

  return {
    data: parseYamlish(match[1]),
    body: match[2],
  };
}

function parseYamlish(input) {
  const data = {};
  input.split(/\n/).forEach(line => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;

    const key = match[1];
    const value = match[2].trim();
    data[key] = parseYamlishValue(value);
  });
  return data;
}

function parseYamlishValue(value) {
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const jsonish = value.replace(/'/g, '"');
    try {
      return JSON.parse(jsonish);
    } catch (error) {
      return value.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean);
    }
  }
  return value;
}

function stringifyPost(frontmatter, body) {
  const fields = [
    "title",
    "date",
    "tags",
    "summary",
    "hero",
  ];
  const lines = ["---"];

  fields.forEach(field => {
    const value = frontmatter[field];
    if (value === undefined || value === null || value === "") return;
    lines.push(`${field}: ${formatYamlValue(value)}`);
  });

  Object.keys(frontmatter)
    .filter(key => !fields.includes(key))
    .sort()
    .forEach(key => {
      const value = frontmatter[key];
      if (value === undefined || value === null || value === "") return;
      lines.push(`${key}: ${formatYamlValue(value)}`);
    });

  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function formatYamlValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => JSON.stringify(String(item))).join(", ")}]`;
  }
  return JSON.stringify(String(value));
}

function makePostPath(title, date) {
  const day = String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const slug = slugify(title || "novy-clanek");
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

function assertSafePath(path, folder, extension) {
  if (
    typeof path !== "string" ||
    !path.startsWith(`${folder}/`) ||
    !path.endsWith(extension) ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    throw statusError(400, "Unsafe path");
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

function signToken() {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  };
  const encoded = base64Url(JSON.stringify(payload));
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
}

function requireAuth(header) {
  const token = String(header || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "Missing token" };

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !safeEqual(signature, hmac(encoded))) {
    return { ok: false, error: "Invalid token" };
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "Expired token" };
  }

  return { ok: true };
}

function hmac(value) {
  const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
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

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  };
}
