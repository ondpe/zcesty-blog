(function () {
  const API = "/.netlify/functions/cms-api";
  const MAX_IMAGE_SIZE = 1920;
  const IMAGE_QUALITY = 0.85;
  const DRAFT_STORAGE_PREFIX = "zcestyAdminBackup:";
  const LEGACY_TOKEN_KEY = "zcestyAdminToken";

  const state = {
    posts: [],
    currentPath: "",
    currentSha: "",
    extraFrontmatter: {},
    pendingImages: [],
    savedSnapshot: "",
    busy: false,
    mobileTab: "write",
    pendingBackup: null,
  };

  const els = {
    loginView: document.querySelector("#loginView"),
    adminView: document.querySelector("#adminView"),
    loginForm: document.querySelector("#loginForm"),
    loginSubmit: document.querySelector("#loginSubmit"),
    password: document.querySelector("#password"),
    loginMessage: document.querySelector("#loginMessage"),
    logout: document.querySelector("#logout"),
    toggleSidebar: document.querySelector("#toggleSidebar"),
    sidebar: document.querySelector("#sidebar"),
    postCount: document.querySelector("#postCount"),
    searchPosts: document.querySelector("#searchPosts"),
    tripFilter: document.querySelector("#tripFilter"),
    tripSuggestions: document.querySelector("#tripSuggestions"),
    postList: document.querySelector("#postList"),
    newPost: document.querySelector("#newPost"),
    save: document.querySelector("#save"),
    deletePost: document.querySelector("#deletePost"),
    togglePreview: document.querySelector("#togglePreview"),
    saveState: document.querySelector("#saveState"),
    photos: document.querySelector("#photos"),
    pendingImages: document.querySelector("#pendingImages"),
    photoManager: document.querySelector("#photoManager"),
    photoManagerSummary: document.querySelector("#photoManagerSummary"),
    photoStrip: document.querySelector("#photoStrip"),
    recoveryBanner: document.querySelector("#recoveryBanner"),
    recoveryText: document.querySelector("#recoveryText"),
    restoreBackup: document.querySelector("#restoreBackup"),
    discardBackup: document.querySelector("#discardBackup"),
    tabWrite: document.querySelector("#tabWrite"),
    tabPreview: document.querySelector("#tabPreview"),
    editorSplit: document.querySelector("#editorSplit"),
    heroThumb: document.querySelector("#heroThumb"),
    body: document.querySelector("#body"),
    preview: document.querySelector("#preview"),
    fields: {
      title: document.querySelector("#title"),
      date: document.querySelector("#date"),
      tags: document.querySelector("#tags"),
      summary: document.querySelector("#summary"),
      hero: document.querySelector("#hero"),
      draft: document.querySelector("#draft"),
    },
  };

  let backupTimer = null;

  // Clean up legacy localStorage bearer token (session now lives in HttpOnly cookie)
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch (error) {
    // Ignore storage access errors
  }

  // --- EVENT LISTENERS ---
  els.loginForm.addEventListener("submit", login);
  els.logout.addEventListener("click", logout);
  els.newPost.addEventListener("click", handleNewPostClick);
  els.save.addEventListener("click", savePost);
  els.deletePost.addEventListener("click", deletePost);
  els.togglePreview.addEventListener("click", togglePreview);
  els.toggleSidebar.addEventListener("click", toggleMobileSidebar);
  els.photos.addEventListener("change", handlePhotos);
  els.searchPosts.addEventListener("input", renderPostList);
  els.tripFilter.addEventListener("change", renderPostList);
  els.restoreBackup.addEventListener("click", applyPendingBackup);
  els.discardBackup.addEventListener("click", clearPendingBackup);
  els.tabWrite.addEventListener("click", () => setMobileTab("write"));
  els.tabPreview.addEventListener("click", () => setMobileTab("preview"));

  els.body.addEventListener("input", handleFormEdited);
  Object.values(els.fields).forEach(input => {
    const eventName = input.type === "checkbox" ? "change" : "input";
    input.addEventListener(eventName, handleFormEdited);
  });

  document.querySelectorAll("[data-prefix]").forEach(button => {
    button.addEventListener("click", () => applyLinePrefix(button.dataset.prefix));
  });
  document.querySelector("#bold").addEventListener("click", () => wrapSelection("**", "**"));
  document.querySelector("#italic").addEventListener("click", () => wrapSelection("*", "*"));
  document.querySelector("#link").addEventListener("click", insertLink);

  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      if (!els.adminView.hidden) {
        event.preventDefault();
        savePost();
      }
    }
  });

  window.addEventListener("beforeunload", event => {
    if (!els.adminView.hidden && isDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  setMobileTab("write");
  bootstrap();

  // --- AUTH & BOOTSTRAP ---
  async function bootstrap() {
    try {
      const result = await api("posts");
      state.posts = result.posts || [];
      showAdmin();
      refreshTripOptions();
      renderPostList();
      if (state.posts[0]) {
        await openPost(state.posts[0].path, { skipConfirm: true });
      } else {
        newPost({ skipConfirm: true });
      }
    } catch (error) {
      showLogin();
    }
  }

  async function login(event) {
    event.preventDefault();
    els.loginMessage.textContent = "";
    els.loginSubmit.disabled = true;
    try {
      await api("login", { password: els.password.value });
      els.password.value = "";
      showAdmin();
      await loadPosts();
    } catch (error) {
      els.loginMessage.textContent = error.message || "Přihlášení selhalo";
    } finally {
      els.loginSubmit.disabled = false;
    }
  }

  async function logout() {
    if (!confirmDiscardIfDirty()) return;
    try {
      await api("logout");
    } catch (error) {
      // Ignore network errors on logout
    }
    revokeAllPendingImages();
    state.posts = [];
    state.currentPath = "";
    state.currentSha = "";
    state.savedSnapshot = "";
    showLogin();
  }

  // --- POSTS LOADING & NAVIGATION ---
  async function loadPosts(preferredPath = "") {
    setStatus("Načítám články...");
    try {
      const result = await api("posts");
      state.posts = result.posts || [];
      refreshTripOptions();
      renderPostList();
      const targetPath =
        preferredPath && state.posts.some(post => post.path === preferredPath)
          ? preferredPath
          : state.posts[0]?.path || "";

      if (targetPath) {
        await openPost(targetPath, { skipConfirm: true });
      } else {
        newPost({ skipConfirm: true });
      }
    } catch (error) {
      setStatus(error.message, "error");
      if (error.status === 401) showLogin();
    }
  }

  async function openPost(path, options = {}) {
    if (!options.skipConfirm && !confirmDiscardIfDirty()) return;

    setStatus("Načítám článek...");
    try {
      const result = await api("post", { path });
      revokeAllPendingImages();
      state.currentPath = path;
      state.currentSha = result.post.sha || "";
      state.extraFrontmatter = extractExtraFrontmatter(result.post.frontmatter || {});
      fillForm(result.post.frontmatter || {}, result.post.body || "");
      els.deletePost.disabled = false;
      markClean();
      renderPostList();
      renderPendingImages();
      renderPhotoStrip();
      renderHeroThumb();
      renderPreview();
      checkForLocalBackup();
      closeMobileSidebar();
      setStatus("Připraveno");
    } catch (error) {
      setStatus(error.message, "error");
      if (error.status === 401) showLogin();
    }
  }

  function handleNewPostClick() {
    newPost();
  }

  function newPost(options = {}) {
    if (!options.skipConfirm && !confirmDiscardIfDirty()) return;

    revokeAllPendingImages();
    state.currentPath = "";
    state.currentSha = "";
    state.extraFrontmatter = {};
    els.deletePost.disabled = true;

    const defaultTrip =
      els.tripFilter.value && els.tripFilter.value !== "__drafts__" ? els.tripFilter.value : "";

    fillForm(
      {
        title: "",
        date: new Date().toISOString().slice(0, 10),
        tags: defaultTrip ? [defaultTrip] : [],
        summary: "",
        hero: "",
        draft: false,
      },
      ""
    );
    markClean();
    renderPostList();
    renderPendingImages();
    renderPhotoStrip();
    renderHeroThumb();
    renderPreview();
    checkForLocalBackup();
    closeMobileSidebar();
    setStatus("Nový článek");
  }

  // --- SAVE & DELETE ---
  async function savePost() {
    if (state.busy) return;

    const frontmatter = readFrontmatter();
    if (!frontmatter.title || !frontmatter.date) {
      setStatus("Vyplň titulek a datum", "error");
      return;
    }

    state.busy = true;
    els.save.disabled = true;
    els.deletePost.disabled = true;

    try {
      const imagesToUpload = getReferencedPendingImages();
      const imageBlobs = [];

      for (let i = 0; i < imagesToUpload.length; i += 1) {
        const image = imagesToUpload[i];
        if (!image.uploadedSha) {
          setStatus(`Nahrávám fotku ${i + 1}/${imagesToUpload.length}...`);
          const uploaded = await api("uploadImage", {
            filename: image.filename,
            base64: image.base64,
          });
          image.uploadedSha = uploaded.sha;
        }
        imageBlobs.push({
          filename: image.filename,
          sha: image.uploadedSha,
        });
      }

      setStatus("Ukládám článek do GitHubu...");
      const previousBackupKey = getBackupKey();
      const result = await api("save", {
        path: state.currentPath,
        expectedSha: state.currentSha || undefined,
        frontmatter: {
          ...state.extraFrontmatter,
          ...frontmatter,
        },
        body: els.body.value,
        imageBlobs,
      });

      state.currentPath = result.path;
      state.currentSha = result.sha || "";
      upsertPostSummary({
        path: result.path,
        sha: state.currentSha,
        title: frontmatter.title,
        date: frontmatter.date,
        summary: frontmatter.summary,
        hero: frontmatter.hero,
        tags: frontmatter.tags,
        draft: Boolean(frontmatter.draft),
      });

      removeLocalBackup(previousBackupKey);
      removeLocalBackup(getBackupKey());
      hideRecoveryBanner();
      revokeAllPendingImages();
      markClean();
      refreshTripOptions();
      renderPostList();
      renderPendingImages();
      renderPhotoStrip();
      renderHeroThumb();
      renderPreview();

      const shortCommit = String(result.commit || "").slice(0, 7);
      const publishNote = frontmatter.draft
        ? "uloženo jako koncept"
        : "na webu se projeví zhruba za minutu";
      setStatus(`Uloženo (${shortCommit}) — ${publishNote}`);
    } catch (error) {
      setStatus(error.message || "Uložení selhalo", "error");
      if (error.status === 401) {
        showLogin();
      } else if (error.code === "CONFLICT" && state.currentPath) {
        if (window.confirm("Článek byl mezitím upraven jinde. Chceš načíst novější verzi z GitHubu?")) {
          await openPost(state.currentPath, { skipConfirm: true });
        }
      }
    } finally {
      state.busy = false;
      els.save.disabled = false;
      els.deletePost.disabled = !state.currentPath;
    }
  }

  async function deletePost() {
    if (state.busy) return;
    if (!state.currentPath) {
      setStatus("Nový článek ještě nejde smazat", "error");
      return;
    }

    const title = els.fields.title.value.trim() || state.currentPath;
    if (!window.confirm(`Opravdu smazat článek "${title}"? Fotky v images zůstanou zachované.`)) {
      return;
    }

    state.busy = true;
    els.save.disabled = true;
    els.deletePost.disabled = true;
    setStatus("Mažu článek...");

    try {
      const deletedPath = state.currentPath;
      const result = await api("delete", {
        path: deletedPath,
        expectedSha: state.currentSha || undefined,
      });

      removeLocalBackup(DRAFT_STORAGE_PREFIX + deletedPath);
      state.posts = state.posts.filter(post => post.path !== deletedPath);
      state.currentPath = "";
      state.currentSha = "";
      revokeAllPendingImages();
      refreshTripOptions();
      renderPostList();

      if (state.posts[0]) {
        await openPost(state.posts[0].path, { skipConfirm: true });
      } else {
        newPost({ skipConfirm: true });
      }
      setStatus(`Smazáno (${String(result.commit || "").slice(0, 7)})`);
    } catch (error) {
      setStatus(error.message || "Smazání selhalo", "error");
      if (error.status === 401) showLogin();
    } finally {
      state.busy = false;
      els.save.disabled = false;
      els.deletePost.disabled = !state.currentPath;
    }
  }

  function upsertPostSummary(summary) {
    const idx = state.posts.findIndex(post => post.path === summary.path);
    if (idx >= 0) {
      state.posts[idx] = summary;
    } else {
      state.posts.unshift(summary);
    }
    state.posts.sort((a, b) => {
      const dateCmp = String(b.date || "").localeCompare(String(a.date || ""));
      if (dateCmp !== 0) return dateCmp;
      return String(b.path || "").localeCompare(String(a.path || ""));
    });
  }

  // --- DIRTY STATE & LOCAL BACKUP ---
  function getSnapshot() {
    return JSON.stringify({
      title: els.fields.title.value,
      date: els.fields.date.value,
      tags: els.fields.tags.value,
      summary: els.fields.summary.value,
      hero: els.fields.hero.value,
      draft: els.fields.draft.checked,
      body: els.body.value,
    });
  }

  function markClean() {
    state.savedSnapshot = getSnapshot();
    els.saveState.classList.remove("is-dirty");
  }

  function isDirty() {
    return getSnapshot() !== state.savedSnapshot || getReferencedPendingImages().length > 0;
  }

  function confirmDiscardIfDirty() {
    if (!isDirty()) return true;
    return window.confirm("Máš neuložené změny. Opravdu chceš pokračovat a zahodit je?");
  }

  function handleFormEdited() {
    renderPendingImages();
    renderPhotoStrip();
    renderHeroThumb();
    renderPreview();

    if (isDirty()) {
      setStatus("Neuložené změny", "dirty");
      scheduleLocalBackup();
    } else {
      removeLocalBackup(getBackupKey());
      setStatus("Připraveno");
    }
  }

  function getBackupKey() {
    return DRAFT_STORAGE_PREFIX + (state.currentPath || "__new__");
  }

  function scheduleLocalBackup() {
    if (backupTimer) window.clearTimeout(backupTimer);
    backupTimer = window.setTimeout(() => {
      try {
        const payload = {
          savedAt: Date.now(),
          fields: {
            title: els.fields.title.value,
            date: els.fields.date.value,
            tags: els.fields.tags.value,
            summary: els.fields.summary.value,
            hero: els.fields.hero.value,
            draft: els.fields.draft.checked,
          },
          body: els.body.value,
        };
        localStorage.setItem(getBackupKey(), JSON.stringify(payload));
      } catch (error) {
        // Ignore quota errors
      }
    }, 600);
  }

  function removeLocalBackup(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Ignore storage errors
    }
  }

  function checkForLocalBackup() {
    hideRecoveryBanner();
    try {
      const raw = localStorage.getItem(getBackupKey());
      if (!raw) return;
      const backup = JSON.parse(raw);
      if (!backup || !backup.fields) return;

      const backupSnapshot = JSON.stringify({
        title: backup.fields.title || "",
        date: backup.fields.date || "",
        tags: backup.fields.tags || "",
        summary: backup.fields.summary || "",
        hero: backup.fields.hero || "",
        draft: Boolean(backup.fields.draft),
        body: backup.body || "",
      });

      if (backupSnapshot === state.savedSnapshot) {
        removeLocalBackup(getBackupKey());
        return;
      }

      state.pendingBackup = backup;
      const when = backup.savedAt
        ? new Date(backup.savedAt).toLocaleString("cs-CZ", {
            day: "numeric",
            month: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      els.recoveryText.textContent = when
        ? `Nalezena neuložená lokální záloha (${when}).`
        : "Nalezena neuložená lokální záloha.";
      els.recoveryBanner.hidden = false;
    } catch (error) {
      // Ignore corrupt backup entries
    }
  }

  function applyPendingBackup() {
    if (!state.pendingBackup) return;
    const backup = state.pendingBackup;
    els.fields.title.value = backup.fields.title || "";
    els.fields.date.value = backup.fields.date || "";
    els.fields.tags.value = backup.fields.tags || "";
    els.fields.summary.value = backup.fields.summary || "";
    els.fields.hero.value = backup.fields.hero || "";
    els.fields.draft.checked = Boolean(backup.fields.draft);
    els.body.value = backup.body || "";
    hideRecoveryBanner();
    handleFormEdited();
    setStatus("Lokální záloha obnovena (nezapomeň uložit)", "dirty");
  }

  function clearPendingBackup() {
    removeLocalBackup(getBackupKey());
    hideRecoveryBanner();
  }

  function hideRecoveryBanner() {
    state.pendingBackup = null;
    els.recoveryBanner.hidden = true;
  }

  // --- PHOTOS PROCESSING & MANAGER ---
  async function handlePhotos(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;

    const prepared = [];
    const failed = [];

    for (let index = 0; index < files.length; index += 1) {
      setStatus(`Zmenšuju fotku ${index + 1}/${files.length}...`);
      try {
        const photo = await preparePhoto(files[index], index);
        prepared.push(photo);
      } catch (error) {
        failed.push(files[index].name);
      }
    }

    if (prepared.length === 0) {
      setStatus(
        failed.length > 0
          ? `Nepodařilo se otevřít: ${failed.join(", ")}. Zkus exportovat jako JPG.`
          : "Žádné fotky nebyly přidány",
        "error"
      );
      return;
    }

    prepared.sort((a, b) => a.takenAt - b.takenAt || a.index - b.index);
    state.pendingImages.push(...prepared);

    insertAtCursor(prepared.map(image => `![](/images/${image.filename})`).join("\n\n"));
    if (!els.fields.hero.value.trim() && prepared[0]) {
      els.fields.hero.value = `/images/${prepared[0].filename}`;
    }

    els.photoManager.open = true;
    handleFormEdited();

    if (failed.length > 0) {
      setStatus(
        `Připraveno ${prepared.length} fotek, ale ${failed.length} nešlo otevřít (${failed.join(", ")})`,
        "error"
      );
    } else {
      setStatus(`Připraveno ${prepared.length} fotek k uložení`, "dirty");
    }
  }

  async function preparePhoto(file, index) {
    const takenAt = await readTakenAt(file);
    const bitmap = await loadBitmap(file);
    try {
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

      return { index, filename, base64, url, takenAt, uploadedSha: "" };
    } finally {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    }
  }

  function revokeAllPendingImages() {
    state.pendingImages.forEach(image => {
      if (image.url) URL.revokeObjectURL(image.url);
    });
    state.pendingImages = [];
  }

  function getReferencedPendingImages() {
    const bodyText = els.body.value || "";
    const heroVal = els.fields.hero.value.trim();
    return state.pendingImages.filter(image => {
      const path = `/images/${image.filename}`;
      return bodyText.includes(path) || heroVal === path;
    });
  }

  function renderPendingImages() {
    const active = getReferencedPendingImages();
    if (active.length === 0) {
      els.pendingImages.hidden = true;
      els.pendingImages.textContent = "";
      return;
    }

    els.pendingImages.hidden = false;
    const countText =
      active.length === 1
        ? "1 nová fotka se nahraje po uložení článku."
        : active.length <= 4
          ? `${active.length} nové fotky se nahrají po uložení článku.`
          : `${active.length} nových fotek se nahraje po uložení článku.`;
    els.pendingImages.textContent = countText;
  }

  function extractMarkdownImages(markdown) {
    const regex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    const items = [];
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      items.push({
        fullMatch: match[0],
        alt: match[1],
        src: match[2],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return items;
  }

  function renderPhotoStrip() {
    const images = extractMarkdownImages(els.body.value || "");
    if (images.length === 0) {
      els.photoManager.hidden = true;
      els.photoStrip.replaceChildren();
      return;
    }

    els.photoManager.hidden = false;
    els.photoManagerSummary.textContent = `Fotky v článku (${images.length})`;

    const currentHero = els.fields.hero.value.trim();
    const cards = images.map((item, idx) => {
      const card = document.createElement("div");
      const isHero = currentHero === item.src;
      card.className = `photo-card${isHero ? " is-hero" : ""}`;

      const img = document.createElement("img");
      img.src = resolveImageSrc(item.src);
      img.alt = item.alt;
      img.loading = "lazy";

      const caption = document.createElement("input");
      caption.type = "text";
      caption.value = isGenericAlt(item.alt) ? "" : item.alt;
      caption.placeholder = "Popisek fotky (volitelný)";
      caption.setAttribute("aria-label", `Popisek fotky ${idx + 1}`);
      caption.addEventListener("change", () => updateImageAlt(idx, caption.value.trim()));

      const actions = document.createElement("div");
      actions.className = "photo-card-actions";

      const heroBtn = document.createElement("button");
      heroBtn.type = "button";
      heroBtn.textContent = isHero ? "✓ Hero" : "Nastavit hero";
      heroBtn.disabled = isHero;
      heroBtn.addEventListener("click", () => {
        els.fields.hero.value = item.src;
        handleFormEdited();
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "photo-remove";
      removeBtn.title = "Odebrat fotku z textu";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => removeImageAtIndex(idx));

      actions.append(heroBtn, removeBtn);
      card.append(img, caption, actions);
      return card;
    });

    els.photoStrip.replaceChildren(...cards);
  }

  function updateImageAlt(targetIndex, newAlt) {
    const images = extractMarkdownImages(els.body.value || "");
    const target = images[targetIndex];
    if (!target) return;

    const cleanAlt = newAlt.replace(/[\[\]\r\n]/g, " ");
    const replacement = `![${cleanAlt}](${target.src})`;
    els.body.value =
      els.body.value.slice(0, target.start) + replacement + els.body.value.slice(target.end);
    handleFormEdited();
  }

  function removeImageAtIndex(targetIndex) {
    const images = extractMarkdownImages(els.body.value || "");
    const target = images[targetIndex];
    if (!target) return;

    const before = els.body.value.slice(0, target.start).replace(/\n+$/, "");
    const after = els.body.value.slice(target.end).replace(/^\n+/, "");
    els.body.value = before && after ? `${before}\n\n${after}` : before || after;

    if (els.fields.hero.value.trim() === target.src) {
      const remaining = extractMarkdownImages(els.body.value);
      els.fields.hero.value = remaining[0]?.src || "";
    }
    handleFormEdited();
  }

  function renderHeroThumb() {
    const hero = els.fields.hero.value.trim();
    if (!hero) {
      els.heroThumb.hidden = true;
      els.heroThumb.removeAttribute("src");
      return;
    }
    els.heroThumb.src = resolveImageSrc(hero);
    els.heroThumb.hidden = false;
  }

  // --- FORM & SIDEBAR RENDERING ---
  function extractExtraFrontmatter(frontmatter) {
    const known = new Set(["title", "date", "tags", "summary", "hero", "draft"]);
    const extra = {};
    Object.keys(frontmatter).forEach(key => {
      if (!known.has(key)) extra[key] = frontmatter[key];
    });
    return extra;
  }

  function fillForm(frontmatter, body) {
    els.fields.title.value = frontmatter.title || "";
    els.fields.date.value = String(frontmatter.date || "").slice(0, 10);
    els.fields.tags.value = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.filter(tag => tag !== "post").join(", ")
      : frontmatter.tags || "";
    els.fields.summary.value = frontmatter.summary || "";
    els.fields.hero.value = frontmatter.hero || "";
    els.fields.draft.checked = Boolean(frontmatter.draft);
    els.body.value = body || "";
  }

  function readFrontmatter() {
    const tags = els.fields.tags.value
      .split(",")
      .map(tag => tag.trim())
      .filter(tag => tag && tag !== "post");

    return {
      title: els.fields.title.value.trim(),
      date: els.fields.date.value,
      tags,
      summary: els.fields.summary.value.trim(),
      hero: els.fields.hero.value.trim(),
      draft: els.fields.draft.checked,
    };
  }

  function refreshTripOptions() {
    const trips = [];
    const seen = new Set();
    state.posts.forEach(post => {
      (post.tags || []).forEach(tag => {
        if (!tag || tag === "post" || seen.has(tag)) return;
        seen.add(tag);
        trips.push(tag);
      });
    });

    const previousFilter = els.tripFilter.value;
    els.tripFilter.replaceChildren(
      new Option("Všechny cesty", ""),
      new Option("Jen koncepty", "__drafts__"),
      ...trips.map(trip => new Option(trip, trip))
    );
    if (previousFilter && [...els.tripFilter.options].some(o => o.value === previousFilter)) {
      els.tripFilter.value = previousFilter;
    }

    els.tripSuggestions.replaceChildren(
      ...trips.map(trip => {
        const option = document.createElement("option");
        option.value = trip;
        return option;
      })
    );
  }

  function renderPostList() {
    const query = els.searchPosts.value.trim().toLowerCase();
    const tripFilter = els.tripFilter.value;

    const filtered = state.posts.filter(post => {
      if (tripFilter === "__drafts__" && !post.draft) return false;
      if (tripFilter && tripFilter !== "__drafts__" && !(post.tags || []).includes(tripFilter)) {
        return false;
      }
      if (!query) return true;
      const haystack = [post.title, post.summary, post.date, post.path, ...(post.tags || [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    els.postCount.textContent =
      filtered.length === state.posts.length
        ? `(${state.posts.length})`
        : `(${filtered.length}/${state.posts.length})`;

    els.toggleSidebar.textContent = `Články (${state.posts.length})`;

    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "post-list-empty";
      empty.textContent = "Žádný článek neodpovídá filtru.";
      els.postList.replaceChildren(empty);
      return;
    }

    els.postList.replaceChildren(
      ...filtered.map(post => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `post-item${post.path === state.currentPath ? " is-active" : ""}`;
        const trip = (post.tags || []).find(tag => tag !== "post") || "";
        const draftBadge = post.draft ? '<span class="badge-draft">Koncept</span>' : "";
        const tripBadge = trip ? `<span class="badge-trip">${escapeHtml(trip)}</span>` : "";
        button.innerHTML = `<span class="post-item-title"><strong>${escapeHtml(post.title)}</strong>${draftBadge}</span><span class="post-item-meta"><span>${escapeHtml(post.date || post.path)}</span>${tripBadge}</span>`;
        button.addEventListener("click", () => openPost(post.path));
        return button;
      })
    );
  }

  // --- PREVIEW & MARKDOWN ---
  function renderPreview() {
    const frontmatter = readFrontmatter();
    const title = frontmatter.title || "Bez názvu";
    const meta = [frontmatter.date, frontmatter.tags[0]].filter(Boolean).join(" · ");
    const publicPath = `/posts/${eleventySlug(title)}/`;
    const draftBadge = frontmatter.draft ? '<span class="badge-draft">Koncept — není na webu</span>' : "";
    const linkHtml = frontmatter.draft
      ? `<span>Koncept: ${escapeHtml(publicPath)}</span>`
      : `<a href="${escapeAttribute(publicPath)}" target="_blank" rel="noopener">Zobrazit článek: ${escapeHtml(publicPath)}</a>`;
    const heroHtml =
      frontmatter.hero && !els.body.value.includes(frontmatter.hero)
        ? `<img class="preview-hero" src="${escapeAttribute(resolveImageSrc(frontmatter.hero))}" alt="">`
        : "";

    els.preview.innerHTML = `<p class="preview-link">${linkHtml}${draftBadge}</p><h1>${escapeHtml(title)}</h1>${meta ? `<p><small>${escapeHtml(meta)}</small></p>` : ""}${frontmatter.summary ? `<p><strong>${escapeHtml(frontmatter.summary)}</strong></p>` : ""}${heroHtml}${renderMarkdown(els.body.value)}`;
  }

  function renderMarkdown(markdown) {
    return String(markdown || "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map(block => renderBlock(block.trim()))
      .filter(Boolean)
      .join("");
  }

  function renderBlock(block) {
    if (!block) return "";

    const image = block.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      const alt = isGenericAlt(image[1]) ? "" : image[1];
      return `<p><img src="${escapeAttribute(resolveImageSrc(image[2]))}" alt="${escapeAttribute(alt)}"></p>`;
    }

    const heading = block.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      return `<h${level}>${renderInline(heading[2])}</h${level}>`;
    }

    const lines = block.split("\n");
    if (lines.every(line => /^>\s?/.test(line))) {
      const inner = lines.map(line => renderInline(line.replace(/^>\s?/, ""))).join("<br>");
      return `<blockquote><p>${inner}</p></blockquote>`;
    }

    if (lines.every(line => /^[-*]\s+/.test(line))) {
      const items = lines
        .map(line => `<li>${renderInline(line.replace(/^[-*]\s+/, ""))}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }

    if (lines.every(line => /^\d+\.\s+/.test(line))) {
      const items = lines
        .map(line => `<li>${renderInline(line.replace(/^\d+\.\s+/, ""))}</li>`)
        .join("");
      return `<ol>${items}</ol>`;
    }

    return `<p>${renderInline(block).replace(/\n/g, "<br>")}</p>`;
  }

  function renderInline(text) {
    return escapeHtml(text)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
        const cleanAlt = isGenericAlt(alt) ? "" : alt;
        return `<img src="${escapeAttribute(resolveImageSrc(src))}" alt="${escapeAttribute(cleanAlt)}">`;
      })
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
      )
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  function resolveImageSrc(src) {
    const filename = String(src || "").split("/").pop();
    const pending = state.pendingImages.find(image => image.filename === filename);
    return pending ? pending.url : src;
  }

  // --- TOOLBAR TEXT MANIPULATION (UNDO-FRIENDLY) ---
  function replaceTextareaRange(start, end, replacement, selectStart, selectEnd) {
    els.body.focus();
    els.body.setSelectionRange(start, end);
    const inserted =
      typeof document.execCommand === "function" &&
      document.execCommand("insertText", false, replacement);
    if (!inserted) {
      els.body.setRangeText(replacement, start, end, "end");
    }
    if (typeof selectStart === "number" && typeof selectEnd === "number") {
      els.body.setSelectionRange(selectStart, selectEnd);
    }
    handleFormEdited();
  }

  function applyLinePrefix(prefix) {
    const start = els.body.selectionStart;
    const value = els.body.value;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    replaceTextareaRange(lineStart, lineStart, prefix, start + prefix.length, start + prefix.length);
  }

  function wrapSelection(before, after) {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const selected = els.body.value.slice(start, end);
    replaceTextareaRange(
      start,
      end,
      before + selected + after,
      start + before.length,
      start + before.length + selected.length
    );
  }

  function insertLink() {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const selected = els.body.value.slice(start, end) || "text odkazu";
    const link = `[${selected}](https://)`;
    const urlStart = start + selected.length + 3;
    replaceTextareaRange(start, end, link, urlStart, urlStart + 8);
  }

  function insertAtCursor(text) {
    const start = els.body.selectionStart;
    const end = els.body.selectionEnd;
    const value = els.body.value;
    const before = start > 0 && !value.slice(0, start).endsWith("\n\n") ? "\n\n" : "";
    const after = end < value.length && !value.slice(end).startsWith("\n\n") ? "\n\n" : "";
    const insert = `${before}${text}${after}`;
    const caret = start + insert.length;
    replaceTextareaRange(start, end, insert, caret, caret);
  }

  // --- VIEW & MOBILE CONTROLS ---
  function togglePreview() {
    const hidden = document.body.classList.toggle("is-preview-hidden");
    els.togglePreview.textContent = hidden ? "Zobrazit náhled" : "Skrýt náhled";
  }

  function toggleMobileSidebar() {
    const open = els.sidebar.classList.toggle("is-open");
    els.toggleSidebar.setAttribute("aria-expanded", String(open));
  }

  function closeMobileSidebar() {
    els.sidebar.classList.remove("is-open");
    els.toggleSidebar.setAttribute("aria-expanded", "false");
  }

  function setMobileTab(tab) {
    state.mobileTab = tab;
    const isPreview = tab === "preview";
    els.tabWrite.classList.toggle("is-active", !isPreview);
    els.tabWrite.setAttribute("aria-selected", String(!isPreview));
    els.tabPreview.classList.toggle("is-active", isPreview);
    els.tabPreview.setAttribute("aria-selected", String(isPreview));
    els.editorSplit.classList.toggle("is-mobile-write", !isPreview);
    els.editorSplit.classList.toggle("is-mobile-preview", isPreview);
  }

  function showLogin() {
    els.loginView.hidden = false;
    els.adminView.hidden = true;
    els.password.focus();
  }

  function showAdmin() {
    els.loginView.hidden = true;
    els.adminView.hidden = false;
  }

  function setStatus(message, tone = "normal") {
    els.saveState.textContent = message;
    els.saveState.classList.toggle("is-dirty", tone === "dirty");
    els.saveState.classList.toggle("is-error", tone === "error");
  }

  // --- API CLIENT ---
  async function api(action, payload = {}) {
    const response = await fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, ...payload }),
    });

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        if (!response.ok) {
          const err = new Error(`Chyba serveru (${response.status})`);
          err.status = response.status;
          throw err;
        }
        throw new Error("Server vrátil neplatnou odpověď");
      }
    }

    if (!response.ok) {
      const error = new Error(data.error || `Něco se nepovedlo (${response.status})`);
      error.status = response.status;
      if (data.code) error.code = data.code;
      throw error;
    }

    return data;
  }

  // --- EXIF & IMAGE HELPERS ---
  async function readTakenAt(file) {
    if (!/jpe?g$/i.test(file.name) && file.type !== "image/jpeg") {
      return file.lastModified || Date.now();
    }

    try {
      const buffer = await file.slice(0, 512 * 1024).arrayBuffer();
      return readExifDate(buffer) || file.lastModified || Date.now();
    } catch (error) {
      return file.lastModified || Date.now();
    }
  }

  function readExifDate(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 2 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      while (offset < view.byteLength && view.getUint8(offset) === 0xff) {
        offset += 1;
      }
      if (offset >= view.byteLength) break;

      const markerByte = view.getUint8(offset);
      offset += 1;

      // Stop at Start of Scan (0xDA) or End of Image (0xD9)
      if (markerByte === 0xda || markerByte === 0xd9) break;
      // Standalone markers without length
      if (markerByte === 0x01 || (markerByte >= 0xd0 && markerByte <= 0xd8)) continue;

      if (offset + 2 > view.byteLength) break;
      const segmentLength = view.getUint16(offset);
      if (segmentLength < 2) break;

      const dataStart = offset + 2;
      const segmentEnd = Math.min(offset + segmentLength, view.byteLength);

      if (markerByte === 0xe1 && dataStart + 6 <= segmentEnd && readAscii(view, dataStart, 6) === "Exif\0\0") {
        const parsed = parseTiffDate(view, dataStart + 6, segmentEnd);
        if (parsed) return parsed;
      }

      offset += segmentLength;
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
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Čtení fotky selhalo"));
      reader.readAsDataURL(blob);
    });
  }

  function makeImageFilename(originalName, takenAt, index) {
    const date = new Date(takenAt);
    const datePart = Number.isFinite(date.getTime())
      ? [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
          String(date.getHours()).padStart(2, "0"),
          String(date.getMinutes()).padStart(2, "0"),
          String(date.getSeconds()).padStart(2, "0"),
        ].join("")
      : new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const base = slugify(originalName.replace(/\.[^.]+$/, "")) || "foto";
    return `${datePart}-${String(index + 1).padStart(2, "0")}-${base}.jpg`;
  }

  function slugify(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // Matches Eleventy's built-in `slug` filter (preserves apostrophes like kuan-c'ling)
  function eleventySlug(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]+/g, "")
      .trim()
      .replace(/[\s-]+/g, "-");
  }

  function isGenericAlt(alt) {
    const normalized = String(alt || "").trim().toLowerCase();
    return !normalized || normalized === "obrázek" || normalized === "obrazek";
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
