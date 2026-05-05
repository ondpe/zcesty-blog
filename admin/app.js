(function () {
  const API = "/.netlify/functions/cms-api";
  const MAX_IMAGE_SIZE = 1920;
  const IMAGE_QUALITY = 0.85;
  const state = {
    token: localStorage.getItem("zcestyAdminToken") || "",
    posts: [],
    currentPath: "",
    pendingImages: [],
  };

  const els = {
    loginView: document.querySelector("#loginView"),
    adminView: document.querySelector("#adminView"),
    loginForm: document.querySelector("#loginForm"),
    password: document.querySelector("#password"),
    loginMessage: document.querySelector("#loginMessage"),
    logout: document.querySelector("#logout"),
    postList: document.querySelector("#postList"),
    newPost: document.querySelector("#newPost"),
    save: document.querySelector("#save"),
    saveState: document.querySelector("#saveState"),
    photos: document.querySelector("#photos"),
    pendingImages: document.querySelector("#pendingImages"),
    body: document.querySelector("#body"),
    preview: document.querySelector("#preview"),
    fields: {
      title: document.querySelector("#title"),
      date: document.querySelector("#date"),
      trip: document.querySelector("#trip"),
      country: document.querySelector("#country"),
      location: document.querySelector("#location"),
      tags: document.querySelector("#tags"),
      summary: document.querySelector("#summary"),
      hero: document.querySelector("#hero"),
    },
  };

  els.loginForm.addEventListener("submit", login);
  els.logout.addEventListener("click", logout);
  els.newPost.addEventListener("click", newPost);
  els.save.addEventListener("click", savePost);
  els.photos.addEventListener("change", handlePhotos);
  els.body.addEventListener("input", renderPreview);
  Object.values(els.fields).forEach(input => input.addEventListener("input", renderPreview));

  document.querySelectorAll("[data-prefix]").forEach(button => {
    button.addEventListener("click", () => applyLinePrefix(button.dataset.prefix));
  });
  document.querySelector("#italic").addEventListener("click", () => wrapSelection("*", "*"));
  document.querySelector("#link").addEventListener("click", insertLink);

  if (state.token) {
    showAdmin();
    loadPosts();
  } else {
    showLogin();
  }

  async function login(event) {
    event.preventDefault();
    els.loginMessage.textContent = "";
    setStatus("Přihlašuju...");
    try {
      const result = await api("login", { password: els.password.value }, false);
      state.token = result.token;
      localStorage.setItem("zcestyAdminToken", state.token);
      showAdmin();
      await loadPosts();
    } catch (error) {
      els.loginMessage.textContent = error.message;
      setStatus("Přihlášení selhalo");
    }
  }

  function logout() {
    state.token = "";
    localStorage.removeItem("zcestyAdminToken");
    showLogin();
  }

  async function loadPosts() {
    setStatus("Načítám články...");
    try {
      const result = await api("posts");
      state.posts = result.posts;
      renderPostList();
      if (state.posts[0]) {
        await openPost(state.posts[0].path);
      } else {
        newPost();
      }
      setStatus("Připraveno");
    } catch (error) {
      setStatus(error.message);
      if (error.status === 401) logout();
    }
  }

  async function openPost(path) {
    setStatus("Načítám článek...");
    const result = await api("post", { path });
    state.currentPath = path;
    state.pendingImages = [];
    fillForm(result.post.frontmatter, result.post.body);
    renderPostList();
    renderPendingImages();
    renderPreview();
    setStatus("Připraveno");
  }

  function newPost() {
    state.currentPath = "";
    state.pendingImages = [];
    fillForm(
      {
        title: "",
        date: new Date().toISOString().slice(0, 10),
        trip: "",
        country: "",
        location: "",
        tags: ["post"],
        summary: "",
        hero: "",
      },
      ""
    );
    renderPostList();
    renderPendingImages();
    renderPreview();
    setStatus("Nový článek");
  }

  async function savePost() {
    const frontmatter = readFrontmatter();
    if (!frontmatter.title || !frontmatter.date) {
      setStatus("Vyplň titulek a datum");
      return;
    }

    setStatus("Ukládám do GitHubu...");
    els.save.disabled = true;
    try {
      const result = await api("save", {
        path: state.currentPath,
        frontmatter,
        body: els.body.value,
        images: state.pendingImages.map(image => ({
          filename: image.filename,
          base64: image.base64,
        })),
      });
      state.currentPath = result.path;
      state.pendingImages = [];
      renderPendingImages();
      setStatus(`Uloženo: ${result.commit.slice(0, 7)}`);
      await loadPosts();
    } catch (error) {
      setStatus(error.message);
    } finally {
      els.save.disabled = false;
    }
  }

  async function handlePhotos(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;

    setStatus("Zmenšuju fotky...");
    const prepared = await Promise.all(files.map((file, index) => preparePhoto(file, index)));
    prepared.sort((a, b) => a.takenAt - b.takenAt || a.index - b.index);

    state.pendingImages.push(...prepared);
    insertAtCursor(prepared.map(image => `![Obrázek](/images/${image.filename})`).join("\n\n"));
    if (!els.fields.hero.value && prepared[0]) {
      els.fields.hero.value = `/images/${prepared[0].filename}`;
    }
    renderPendingImages();
    renderPreview();
    setStatus(`Připraveno ${prepared.length} fotek k uložení`);
  }

  async function preparePhoto(file, index) {
    const takenAt = await readTakenAt(file);
    const bitmap = await loadBitmap(file);
    const size = contain(bitmap.width, bitmap.height, MAX_IMAGE_SIZE);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = size.width;
    canvas.height = size.height;
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    const blob = await canvasToBlob(canvas, "image/jpeg", IMAGE_QUALITY);
    const filename = makeImageFilename(file.name, takenAt, index);
    const base64 = await blobToBase64(blob);
    const url = URL.createObjectURL(blob);

    return { index, filename, base64, url, takenAt };
  }

  function fillForm(frontmatter, body) {
    els.fields.title.value = frontmatter.title || "";
    els.fields.date.value = String(frontmatter.date || "").slice(0, 10);
    els.fields.trip.value = frontmatter.trip || "";
    els.fields.country.value = frontmatter.country || "";
    els.fields.location.value = frontmatter.location || "";
    els.fields.tags.value = Array.isArray(frontmatter.tags) ? frontmatter.tags.join(", ") : frontmatter.tags || "";
    els.fields.summary.value = frontmatter.summary || "";
    els.fields.hero.value = frontmatter.hero || "";
    els.body.value = body || "";
  }

  function readFrontmatter() {
    return {
      title: els.fields.title.value.trim(),
      date: els.fields.date.value,
      trip: els.fields.trip.value.trim(),
      country: els.fields.country.value.trim(),
      location: els.fields.location.value.trim(),
      tags: els.fields.tags.value.split(",").map(tag => tag.trim()).filter(Boolean),
      summary: els.fields.summary.value.trim(),
      hero: els.fields.hero.value.trim(),
    };
  }

  function renderPostList() {
    els.postList.replaceChildren(
      ...state.posts.map(post => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `post-item${post.path === state.currentPath ? " is-active" : ""}`;
        button.innerHTML = `<strong>${escapeHtml(post.title)}</strong><span>${escapeHtml(post.date || post.path)}</span>`;
        button.addEventListener("click", () => openPost(post.path));
        return button;
      })
    );
  }

  function renderPendingImages() {
    if (state.pendingImages.length === 0) {
      els.pendingImages.hidden = true;
      els.pendingImages.textContent = "";
      return;
    }

    els.pendingImages.hidden = false;
    els.pendingImages.textContent = `${state.pendingImages.length} fotek se uloží spolu s článkem.`;
  }

  function renderPreview() {
    const frontmatter = readFrontmatter();
    const title = frontmatter.title || "Bez názvu";
    const meta = [frontmatter.date, frontmatter.location, frontmatter.country].filter(Boolean).join(" · ");
    els.preview.innerHTML = `<h1>${escapeHtml(title)}</h1>${meta ? `<p><small>${escapeHtml(meta)}</small></p>` : ""}${frontmatter.summary ? `<p><strong>${escapeHtml(frontmatter.summary)}</strong></p>` : ""}${renderMarkdown(els.body.value)}`;
  }

  function applyLinePrefix(prefix) {
    const start = els.body.selectionStart;
    const value = els.body.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    els.body.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    els.body.focus();
    els.body.setSelectionRange(start + prefix.length, start + prefix.length);
    renderPreview();
  }

  function wrapSelection(before, after) {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const value = els.body.value;
    const selected = value.slice(start, end);
    els.body.value = value.slice(0, start) + before + selected + after + value.slice(end);
    els.body.focus();
    els.body.setSelectionRange(start + before.length, start + before.length + selected.length);
    renderPreview();
  }

  function insertLink() {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const value = els.body.value;
    const selected = value.slice(start, end) || "text odkazu";
    const link = `[${selected}](https://)`;
    els.body.value = value.slice(0, start) + link + value.slice(end);
    els.body.focus();
    els.body.setSelectionRange(start + selected.length + 3, start + selected.length + 11);
    renderPreview();
  }

  function insertAtCursor(text) {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const value = els.body.value;
    const before = start > 0 && !value.slice(0, start).endsWith("\n\n") ? "\n\n" : "";
    const after = end < value.length && !value.slice(end).startsWith("\n\n") ? "\n\n" : "";
    const insert = `${before}${text}${after}`;
    els.body.value = value.slice(0, start) + insert + value.slice(end);
    els.body.focus();
    els.body.setSelectionRange(start + insert.length, start + insert.length);
  }

  function renderMarkdown(markdown) {
    return markdown
      .split(/\n{2,}/)
      .map(block => renderBlock(block.trim()))
      .filter(Boolean)
      .join("");
  }

  function renderBlock(block) {
    if (!block) return "";

    const image = block.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      return `<p><img src="${escapeAttribute(resolveImageSrc(image[2]))}" alt="${escapeAttribute(image[1])}"></p>`;
    }

    const heading = block.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      return `<h${level}>${renderInline(heading[2])}</h${level}>`;
    }

    return `<p>${renderInline(block).replace(/\n/g, "<br>")}</p>`;
  }

  function renderInline(text) {
    return escapeHtml(text)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  function resolveImageSrc(src) {
    const filename = src.split("/").pop();
    const pending = state.pendingImages.find(image => image.filename === filename);
    return pending ? pending.url : src;
  }

  async function api(action, payload = {}, useAuth = true) {
    const response = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(useAuth ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Něco se nepovedlo");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showLogin() {
    els.loginView.hidden = false;
    els.adminView.hidden = true;
  }

  function showAdmin() {
    els.loginView.hidden = true;
    els.adminView.hidden = false;
  }

  function setStatus(message) {
    els.saveState.textContent = message;
  }

  async function readTakenAt(file) {
    if (!/jpe?g$/i.test(file.name) && file.type !== "image/jpeg") {
      return file.lastModified || Date.now();
    }

    try {
      const buffer = await file.slice(0, 256 * 1024).arrayBuffer();
      return readExifDate(buffer) || file.lastModified || Date.now();
    } catch (error) {
      return file.lastModified || Date.now();
    }
  }

  function readExifDate(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      const marker = view.getUint16(offset);
      offset += 2;
      if (marker === 0xffe1) {
        const length = view.getUint16(offset);
        const start = offset + 2;
        if (start + 6 > view.byteLength || readAscii(view, start, 6) !== "Exif\0\0") return null;
        return parseTiffDate(view, start + 6, Math.min(start + length, view.byteLength));
      }
      offset += view.getUint16(offset);
    }
    return null;
  }

  function parseTiffDate(view, tiffStart, tiffEnd) {
    if (tiffStart + 8 > tiffEnd) return null;
    const little = readAscii(view, tiffStart, 2) === "II";
    const firstIfdOffset = view.getUint32(tiffStart + 4, little);
    const exifIfd = findTagValue(view, tiffStart + firstIfdOffset, tiffEnd, 0x8769, little);
    if (!exifIfd) return null;
    const dateOffset =
      findTagValue(view, tiffStart + exifIfd, tiffEnd, 0x9003, little) ||
      findTagValue(view, tiffStart + exifIfd, tiffEnd, 0x9004, little);
    if (!dateOffset || tiffStart + dateOffset + 19 > tiffEnd) return null;
    const raw = readAscii(view, tiffStart + dateOffset, 19);
    const match = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }

  function findTagValue(view, ifdOffset, tiffEnd, tag, little) {
    if (ifdOffset + 2 > tiffEnd) return null;
    const entries = view.getUint16(ifdOffset, little);
    for (let index = 0; index < entries; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > tiffEnd) return null;
      if (view.getUint16(entryOffset, little) === tag) {
        return view.getUint32(entryOffset + 8, little);
      }
    }
    return null;
  }

  function loadBitmap(file) {
    if ("createImageBitmap" in window) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => loadImageElement(file));
    }
    return loadImageElement(file);
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Fotku se nepodařilo otevřít"));
      };
      img.src = url;
    });
  }

  function contain(width, height, maxSize) {
    const longest = Math.max(width, height);
    if (longest <= maxSize) return { width, height };
    const ratio = maxSize / longest;
    return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("Export fotky selhal"))), type, quality);
    });
  }

  function blobToBase64(blob) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
  }

  function makeImageFilename(originalName, takenAt, index) {
    const date = new Date(takenAt);
    const datePart = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join("");
    return `${datePart}-${String(index + 1).padStart(2, "0")}-${slugify(originalName.replace(/\.[^.]+$/, ""))}.jpg`;
  }

  function slugify(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function readAscii(view, offset, length) {
    let result = "";
    for (let index = 0; index < length; index += 1) {
      result += String.fromCharCode(view.getUint8(offset + index));
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }
})();
