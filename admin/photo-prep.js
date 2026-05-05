(function () {
  const fileInput = document.querySelector("#photos");
  const processButton = document.querySelector("#process");
  const downloadAllButton = document.querySelector("#downloadAll");
  const results = document.querySelector("#results");
  const emptyState = document.querySelector("#emptyState");
  const prefixInput = document.querySelector("#prefix");
  const maxSizeInput = document.querySelector("#maxSize");
  const qualityInput = document.querySelector("#quality");

  const downloads = [];

  prefixInput.value = new Date().toISOString().slice(0, 10);

  fileInput.addEventListener("change", () => {
    processButton.disabled = fileInput.files.length === 0;
  });

  processButton.addEventListener("click", async () => {
    clearResults();
    processButton.disabled = true;
    downloadAllButton.disabled = true;

    const files = Array.from(fileInput.files);
    for (let index = 0; index < files.length; index += 1) {
      await processFile(files[index], index + 1);
    }

    processButton.disabled = files.length === 0;
    downloadAllButton.disabled = downloads.length === 0;
    emptyState.hidden = downloads.length > 0;
  });

  downloadAllButton.addEventListener("click", () => {
    downloads.forEach((item, index) => {
      window.setTimeout(() => item.link.click(), index * 300);
    });
  });

  async function processFile(file, index) {
    const card = createResultCard(file.name);
    results.append(card.element);

    try {
      const bitmap = await loadBitmap(file);
      const maxSize = clampNumber(maxSizeInput.value, 640, 3840, 1920);
      const quality = clampNumber(qualityInput.value, 50, 95, 85) / 100;
      const size = contain(bitmap.width, bitmap.height, maxSize);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      canvas.width = size.width;
      canvas.height = size.height;
      context.drawImage(bitmap, 0, 0, size.width, size.height);

      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      const url = URL.createObjectURL(blob);
      const filename = makeFilename(file.name, index);
      const saving = Math.round((1 - blob.size / file.size) * 100);
      const saveText = Number.isFinite(saving) ? `${Math.max(saving, 0)} % mensi` : "hotovo";

      card.image.src = url;
      card.title.textContent = filename;
      card.meta.textContent = `${size.width} x ${size.height} px, ${formatBytes(blob.size)} (${saveText})`;
      card.download.href = url;
      card.download.download = filename;
      card.download.textContent = "Stahnout JPG";
      card.download.hidden = false;

      downloads.push({ link: card.download, url });
    } catch (error) {
      card.meta.textContent = "";
      card.error.textContent = "Fotku se nepodarilo otevrit. Zkus ji z Apple Photos exportovat jako JPG.";
      card.error.hidden = false;
    }
  }

  function clearResults() {
    downloads.forEach(item => URL.revokeObjectURL(item.url));
    downloads.length = 0;
    results.replaceChildren();
    emptyState.hidden = false;
  }

  function createResultCard(name) {
    const element = document.createElement("article");
    const image = document.createElement("img");
    const body = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("div");
    const error = document.createElement("div");
    const download = document.createElement("a");

    element.className = "result";
    body.className = "result-body";
    meta.className = "meta";
    error.className = "error";
    download.className = "download";
    error.hidden = true;
    download.hidden = true;

    title.textContent = name;
    meta.textContent = "Zpracovavam...";

    body.append(title, meta, error, download);
    element.append(image, body);

    return { element, image, title, meta, error, download };
  }

  async function loadBitmap(file) {
    if ("createImageBitmap" in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (error) {
        return loadImageElement(file);
      }
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
        reject(new Error("Image failed to load"));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Image export failed"));
        }
      }, type, quality);
    });
  }

  function contain(width, height, maxSize) {
    const longest = Math.max(width, height);
    if (longest <= maxSize) {
      return { width, height };
    }

    const ratio = maxSize / longest;
    return {
      width: Math.round(width * ratio),
      height: Math.round(height * ratio),
    };
  }

  function makeFilename(originalName, index) {
    const prefix = slugify(prefixInput.value.trim());
    const base = slugify(originalName.replace(/\.[^.]+$/, ""));
    const number = String(index).padStart(2, "0");
    return [prefix, number, base].filter(Boolean).join("-") + ".jpg";
  }

  function slugify(value) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, number));
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} kB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
})();
