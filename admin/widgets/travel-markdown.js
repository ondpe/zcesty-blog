(function () {
  const DEFAULT_MAX_SIZE = 1920;
  const DEFAULT_QUALITY = 0.85;

  function registerTravelMarkdownWidget() {
    if (!window.CMS || !window.createClass || !window.h) {
      window.setTimeout(registerTravelMarkdownWidget, 50);
      return;
    }

    const h = window.h;
    const createClass = window.createClass;

    const TravelMarkdownControl = createClass({
      getInitialState() {
        return {
          processing: false,
          downloads: [],
          error: "",
        };
      },

      componentWillUnmount() {
        this.revokeDownloads();
      },

      revokeDownloads() {
        this.state.downloads.forEach(item => URL.revokeObjectURL(item.url));
      },

      getValue() {
        return this.props.value || "";
      },

      setValue(value) {
        this.props.onChange(value);
      },

      applyWrap(before, after) {
        const textarea = this.textarea;
        const value = this.getValue();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = value.slice(start, end);
        const next = value.slice(0, start) + before + selected + after + value.slice(end);

        this.setValue(next);
        window.requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
        });
      },

      applyLinePrefix(prefix) {
        const textarea = this.textarea;
        const value = this.getValue();
        const start = textarea.selectionStart;
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);

        this.setValue(next);
        window.requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(start + prefix.length, start + prefix.length);
        });
      },

      insertLink() {
        const textarea = this.textarea;
        const value = this.getValue();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = value.slice(start, end) || "text odkazu";
        const nextText = `[${selected}](https://)`;
        const next = value.slice(0, start) + nextText + value.slice(end);

        this.setValue(next);
        window.requestAnimationFrame(() => {
          textarea.focus();
          const urlStart = start + selected.length + 3;
          textarea.setSelectionRange(urlStart, urlStart + 8);
        });
      },

      async handlePhotos(event) {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (files.length === 0) return;

        this.revokeDownloads();
        this.setState({ processing: true, downloads: [], error: "" });

        try {
          const prepared = await Promise.all(files.map((file, index) => preparePhoto(file, index)));
          prepared.sort((a, b) => a.takenAt - b.takenAt || a.index - b.index);

          const markdown = prepared
            .map(item => `![Obrazek](/images/${item.filename})`)
            .join("\n\n");

          this.insertAtCursor(markdown);
          this.setState({ processing: false, downloads: prepared });
        } catch (error) {
          this.setState({
            processing: false,
            downloads: [],
            error: "Nekterou fotku se nepodarilo otevrit. Zkus ji z Apple Photos exportovat jako JPG.",
          });
        }
      },

      insertAtCursor(text) {
        const textarea = this.textarea;
        const value = this.getValue();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const needsBefore = start > 0 && !value.slice(0, start).endsWith("\n\n");
        const needsAfter = end < value.length && !value.slice(end).startsWith("\n\n");
        const insert = `${needsBefore ? "\n\n" : ""}${text}${needsAfter ? "\n\n" : ""}`;
        const next = value.slice(0, start) + insert + value.slice(end);

        this.setValue(next);
        window.requestAnimationFrame(() => {
          const pos = start + insert.length;
          textarea.focus();
          textarea.setSelectionRange(pos, pos);
        });
      },

      downloadAll() {
        this.state.downloads.forEach((item, index) => {
          window.setTimeout(() => item.link.click(), index * 250);
        });
      },

      renderToolbarButton(label, title, onClick) {
        return h(
          "button",
          {
            type: "button",
            className: "travel-md-button",
            title,
            onClick,
          },
          label
        );
      },

      render() {
        return h("div", { className: "travel-md" }, [
          h("div", { className: "travel-md-toolbar" }, [
            this.renderToolbarButton("H1", "Nadpis 1", () => this.applyLinePrefix("# ")),
            this.renderToolbarButton("H2", "Nadpis 2", () => this.applyLinePrefix("## ")),
            this.renderToolbarButton("H3", "Nadpis 3", () => this.applyLinePrefix("### ")),
            this.renderToolbarButton("I", "Kurziva", () => this.applyWrap("*", "*")),
            this.renderToolbarButton("Link", "Odkaz", this.insertLink),
            h("label", { className: "travel-md-photo-button" }, [
              this.state.processing ? "Zmensuji..." : "Vybrat fotky",
              h("input", {
                type: "file",
                accept: "image/*",
                multiple: true,
                disabled: this.state.processing || this.props.disabled,
                onChange: this.handlePhotos,
              }),
            ]),
            h(
              "button",
              {
                type: "button",
                className: "travel-md-button",
                disabled: this.state.downloads.length === 0,
                onClick: this.downloadAll,
              },
              "Stahnout JPG"
            ),
          ]),
          h("textarea", {
            id: this.props.forID,
            className: "travel-md-textarea",
            value: this.getValue(),
            disabled: this.props.disabled,
            placeholder: "Piš text, vkládej fotky a nech mezi bloky volný řádek.",
            ref: node => {
              this.textarea = node;
            },
            onChange: event => this.setValue(event.target.value),
          }),
          this.state.error
            ? h("p", { className: "travel-md-error" }, this.state.error)
            : null,
          this.state.downloads.length > 0
            ? h("div", { className: "travel-md-downloads" }, [
                h(
                  "p",
                  null,
                  `Vlozeno ${this.state.downloads.length} fotek. Stahni JPG a nahraj je v CMS do slozky images.`
                ),
                this.state.downloads.map(item =>
                  h(
                    "a",
                    {
                      key: item.filename,
                      href: item.url,
                      download: item.filename,
                      ref: node => {
                        item.link = node;
                      },
                    },
                    item.filename
                  )
                ),
              ])
            : null,
        ]);
      },
    });

    const TravelMarkdownPreview = createClass({
      render() {
        return h("div", null, this.props.value || "");
      },
    });

    window.CMS.registerWidget("travel_markdown", TravelMarkdownControl, TravelMarkdownPreview);
  }

  registerTravelMarkdownWidget();

  async function preparePhoto(file, index) {
    const takenAt = await readTakenAt(file);
    const bitmap = await loadBitmap(file);
    const size = contain(bitmap.width, bitmap.height, DEFAULT_MAX_SIZE);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = size.width;
    canvas.height = size.height;
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    const blob = await canvasToBlob(canvas, "image/jpeg", DEFAULT_QUALITY);
    const filename = makeFilename(file.name, takenAt, index);
    const url = URL.createObjectURL(blob);

    return {
      index,
      filename,
      takenAt,
      url,
      link: null,
    };
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
    const littleEndian = readAscii(view, tiffStart, 2) === "II";
    const firstIfdOffset = getUint32(view, tiffStart + 4, littleEndian);
    const exifIfd = findTagValue(view, tiffStart + firstIfdOffset, tiffStart, tiffEnd, 0x8769, littleEndian);
    if (!exifIfd) return null;

    const dateOffset =
      findTagValue(view, tiffStart + exifIfd, tiffStart, tiffEnd, 0x9003, littleEndian) ||
      findTagValue(view, tiffStart + exifIfd, tiffStart, tiffEnd, 0x9004, littleEndian);

    if (!dateOffset || tiffStart + dateOffset + 19 > tiffEnd) return null;

    const raw = readAscii(view, tiffStart + dateOffset, 19);
    const match = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  }

  function findTagValue(view, ifdOffset, tiffStart, tiffEnd, tag, littleEndian) {
    if (ifdOffset + 2 > tiffEnd) return null;
    const entries = getUint16(view, ifdOffset, littleEndian);

    for (let index = 0; index < entries; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > tiffEnd) return null;
      if (getUint16(view, entryOffset, littleEndian) === tag) {
        return getUint32(view, entryOffset + 8, littleEndian);
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

  function makeFilename(originalName, takenAt, index) {
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
    const base = slugify(originalName.replace(/\.[^.]+$/, ""));
    const number = String(index + 1).padStart(2, "0");
    return `${datePart}-${number}-${base}.jpg`;
  }

  function slugify(value) {
    return value
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

  function getUint16(view, offset, littleEndian) {
    return view.getUint16(offset, littleEndian);
  }

  function getUint32(view, offset, littleEndian) {
    return view.getUint32(offset, littleEndian);
  }
})();
