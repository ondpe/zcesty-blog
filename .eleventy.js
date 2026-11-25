const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const CleanCSS = require("clean-css");
const htmlmin = require("html-minifier-terser");
const markdownIt = require("markdown-it");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItAnchor = require("markdown-it-anchor");

const SYSTEM_TAGS = new Set(["all", "post", "postsAll", "tagList", "tripList"]);
const USE_NETLIFY_IMAGES =
  process.env.NETLIFY === "true" || process.env.ENABLE_NETLIFY_IMAGES === "true";

const dimensionCache = new Map();

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isGenericAlt(alt) {
  const normalized = String(alt || "").trim().toLowerCase();
  return !normalized || normalized === "obrázek" || normalized === "obrazek";
}

function readHeadBytes(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function parseImageDimensionsFromBuffer(buf) {
  if (!buf || buf.length < 24) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF
  if (buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buf.length >= 30) {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (chunk === "VP8 " && buf.length >= 30) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  // JPEG (with EXIF Orientation 0x0112 check)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    let orientation = 1;
    let dims = null;

    while (offset + 2 <= buf.length) {
      if (buf[offset] !== 0xff) break;
      while (offset < buf.length && buf[offset] === 0xff) offset += 1;
      if (offset >= buf.length) break;

      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > buf.length) return null;

      const len = buf.readUInt16BE(offset);
      if (len < 2 || offset + len > buf.length) return null;

      if (
        marker === 0xe1 &&
        len >= 16 &&
        buf.toString("ascii", offset + 2, offset + 8) === "Exif\0\0"
      ) {
        const tiff = offset + 8;
        const little = buf.toString("ascii", tiff, tiff + 2) === "II";
        const u16 = p => (little ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const u32 = p => (little ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        if (tiff + 8 <= offset + len) {
          const ifd = tiff + u32(tiff + 4);
          if (ifd + 2 <= offset + len) {
            const count = u16(ifd);
            for (let i = 0; i < count; i += 1) {
              const entry = ifd + 2 + i * 12;
              if (entry + 12 > offset + len) break;
              if (u16(entry) === 0x0112) {
                orientation = u16(entry + 8);
                break;
              }
            }
          }
        }
      }

      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 7 <= buf.length) {
          dims = {
            height: buf.readUInt16BE(offset + 3),
            width: buf.readUInt16BE(offset + 5),
          };
          break;
        }
      }

      offset += len;
    }

    if (dims) {
      if (orientation >= 5 && orientation <= 8) {
        return { width: dims.height, height: dims.width };
      }
      return dims;
    }
  }

  return null;
}

function getImageDimensions(src) {
  if (!src || !src.startsWith("/images/")) return null;
  if (dimensionCache.has(src)) return dimensionCache.get(src);

  const localPath = path.join(__dirname, src.replace(/^\/+/, ""));
  let dims = null;
  try {
    if (fs.existsSync(localPath)) {
      dims = parseImageDimensionsFromBuffer(readHeadBytes(localPath, 65536));
      if (!dims) {
        dims = parseImageDimensionsFromBuffer(fs.readFileSync(localPath));
      }
    }
  } catch (error) {
    dims = null;
  }

  dimensionCache.set(src, dims);
  return dims;
}

function buildOptimizedUrl(src, width, quality = 80) {
  if (!USE_NETLIFY_IMAGES || !src || !src.startsWith("/images/")) {
    return src;
  }
  return `/.netlify/images?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}

function buildImgTag(src, options = {}) {
  const {
    alt = "",
    widths = [480, 800, 1200, 1600],
    defaultWidth = 960,
    sizes = "(max-width: 820px) 100vw, 760px",
    quality = 80,
    loading = "lazy",
    fetchpriority = "",
    className = "",
  } = options;

  const dims = getImageDimensions(src);
  const effectiveWidths = dims
    ? widths.filter(w => w <= dims.width).concat(dims.width < widths[0] ? [dims.width] : [])
    : widths;
  const uniqueWidths = [...new Set(effectiveWidths.length ? effectiveWidths : [defaultWidth])].sort(
    (a, b) => a - b
  );
  const fallbackWidth = dims ? Math.min(defaultWidth, dims.width) : defaultWidth;

  const displaySrc = escapeHtmlAttr(buildOptimizedUrl(src, fallbackWidth, quality));
  const srcsetAttr =
    USE_NETLIFY_IMAGES && src && src.startsWith("/images/")
      ? ` srcset="${uniqueWidths
          .map(w => `${escapeHtmlAttr(buildOptimizedUrl(src, w, quality))} ${w}w`)
          .join(", ")}" sizes="${escapeHtmlAttr(sizes)}"`
      : "";
  const dimAttrs = dims ? ` width="${dims.width}" height="${dims.height}"` : "";
  const classAttr = className ? ` class="${escapeHtmlAttr(className)}"` : "";
  const priorityAttr = fetchpriority ? ` fetchpriority="${escapeHtmlAttr(fetchpriority)}"` : "";

  return `<img src="${displaySrc}"${srcsetAttr} alt="${escapeHtmlAttr(alt)}"${dimAttrs}${classAttr} loading="${escapeHtmlAttr(loading)}" decoding="async"${priorityAttr}>`;
}

function renderLinkedImage(rawSrc, rawAlt, asFigure) {
  const src = rawSrc || "";
  const cleanAlt = isGenericAlt(rawAlt) ? "" : String(rawAlt || "").trim();
  const dims = getImageDimensions(src);
  const isPortrait = Boolean(dims && dims.height > dims.width * 1.05);
  const captionAttr = cleanAlt ? ` data-caption="${escapeHtmlAttr(cleanAlt)}"` : "";
  const imgHtml = buildImgTag(src, {
    alt: cleanAlt,
    widths: [480, 800, 1200, 1600],
    defaultWidth: 960,
    sizes: isPortrait ? "(max-width: 820px) 100vw, 560px" : "(max-width: 820px) 100vw, 760px",
    quality: 80,
    loading: "lazy",
  });
  const linked = `<a href="${escapeHtmlAttr(src)}"${captionAttr}>${imgHtml}</a>`;

  if (!asFigure) {
    return linked;
  }

  const figClass = isPortrait ? "post-figure is-portrait" : "post-figure";
  const figcaption = cleanAlt ? `<figcaption>${escapeHtmlAttr(cleanAlt)}</figcaption>` : "";
  return `<figure class="${figClass}">${linked}${figcaption}</figure>`;
}

function markdownFigurePlugin(md) {
  // Replace paragraphs containing only images (and line breaks) with block <figure> tokens
  md.core.ruler.after("inline", "standalone_image_figures", state => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length - 2; i += 1) {
      if (
        tokens[i].type === "paragraph_open" &&
        tokens[i + 1].type === "inline" &&
        tokens[i + 2].type === "paragraph_close"
      ) {
        const children = (tokens[i + 1].children || []).filter(
          child => !(child.type === "text" && child.content.trim() === "")
        );
        const images = children.filter(child => child.type === "image");
        const onlyImages =
          images.length > 0 &&
          children.every(
            child => child.type === "image" || child.type === "softbreak" || child.type === "hardbreak"
          );
        if (onlyImages) {
          const htmlToken = new state.Token("html_block", "", 0);
          htmlToken.content =
            images
              .map(imgToken => renderLinkedImage(imgToken.attrGet("src"), imgToken.content, true))
              .join("\n") + "\n";
          tokens.splice(i, 3, htmlToken);
        }
      }
    }
  });

  // Fallback for inline images mixed with text inside a paragraph
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    return renderLinkedImage(token.attrGet("src"), token.content, false);
  };
}

module.exports = function (eleventyConfig) {
  // --- MARKDOWN ---
  const md = markdownIt({ html: true, breaks: true, linkify: true })
    .use(markdownItAttrs)
    .use(markdownItAnchor, { permalink: false })
    .use(markdownFigurePlugin);

  eleventyConfig.setLibrary("md", md);

  // --- SHORTCODES ---
  eleventyConfig.addShortcode(
    "cardImage",
    function (src, sizes = "(max-width: 880px) 100vw, 240px", priority = false) {
      if (!src) return "";
      return buildImgTag(src, {
        alt: "",
        widths: [320, 480, 720],
        defaultWidth: 480,
        sizes,
        quality: 78,
        loading: priority ? "eager" : "lazy",
        fetchpriority: priority ? "high" : "",
      });
    }
  );

  // --- COLLECTIONS ---
  eleventyConfig.setDataDeepMerge(true);

  eleventyConfig.addCollection("tagList", function (collectionApi) {
    const tagSet = new Set();
    collectionApi.getAll().forEach(item => {
      if (item.data.draft) return;
      if ("tags" in item.data) {
        const tags = Array.isArray(item.data.tags) ? item.data.tags : [item.data.tags];
        tags.forEach(tag => {
          if (tag && !SYSTEM_TAGS.has(tag)) tagSet.add(tag);
        });
      }
    });
    return [...tagSet];
  });

  eleventyConfig.addCollection("tripList", function (collectionApi) {
    const latestByTrip = new Map();
    collectionApi.getFilteredByGlob("./posts/*.md").forEach(item => {
      if (item.data.draft) return;
      const tags = Array.isArray(item.data.tags) ? item.data.tags : [item.data.tags];
      tags.forEach(tag => {
        if (!tag || SYSTEM_TAGS.has(tag)) return;
        const ts = item.date ? item.date.getTime() : 0;
        if (!latestByTrip.has(tag) || ts > latestByTrip.get(tag)) {
          latestByTrip.set(tag, ts);
        }
      });
    });
    return [...latestByTrip.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  });

  eleventyConfig.addCollection("postsAll", function (collectionApi) {
    return collectionApi
      .getFilteredByGlob("./posts/*.md")
      .filter(item => !item.data.draft)
      .sort((a, b) => b.date - a.date);
  });

  // --- FILTERS ---
  eleventyConfig.addFilter("readableDate", dateObj => {
    return DateTime.fromJSDate(dateObj).toFormat("dd LLL yyyy");
  });

  eleventyConfig.addFilter("machineDate", dateObj => {
    return DateTime.fromJSDate(dateObj).toFormat("yyyy-MM-dd");
  });

  eleventyConfig.addFilter("isoDate", dateObj => {
    const dt = dateObj instanceof Date ? DateTime.fromJSDate(dateObj) : DateTime.fromISO(String(dateObj));
    return dt.toUTC().toISO({ suppressMilliseconds: true });
  });

  eleventyConfig.addFilter("czDate", dateObj => {
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(dateObj);
  });

  eleventyConfig.addFilter("postYears", posts => {
    if (!Array.isArray(posts) || posts.length === 0) return "";
    const years = [
      ...new Set(
        posts
          .filter(post => post && post.date instanceof Date)
          .map(post => DateTime.fromJSDate(post.date).toFormat("yyyy"))
      ),
    ].sort();
    if (years.length === 0) return "";
    if (years.length === 1) return years[0];
    return `${years[0]}–${years[years.length - 1]}`;
  });

  eleventyConfig.addFilter("czPostCount", count => {
    const n = Number(count) || 0;
    if (n === 1) return "1 článek";
    if (n >= 2 && n <= 4) return `${n} články`;
    return `${n} článků`;
  });

  eleventyConfig.addFilter("primaryTrip", tags => {
    if (!tags) return "";
    const list = Array.isArray(tags) ? tags : [tags];
    return list.find(tag => tag && !SYSTEM_TAGS.has(tag)) || "";
  });

  eleventyConfig.addFilter("sortChronologically", posts => {
    if (!Array.isArray(posts)) return [];
    return [...posts].sort((a, b) => a.date - b.date);
  });

  eleventyConfig.addFilter("tripCover", posts => {
    if (!Array.isArray(posts)) return "";
    const sorted = [...posts].sort((a, b) => a.date - b.date);
    const withHero = sorted.find(p => p && p.data && p.data.hero);
    return withHero ? withHero.data.hero : "";
  });

  eleventyConfig.addFilter("readingStats", htmlContent => {
    const html = String(htmlContent || "");
    const photos = (html.match(/<img\b/gi) || []).length;
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const words = text ? text.split(" ").length : 0;
    const minutes = Math.max(1, Math.round(words / 200));
    const parts = [`${minutes} min čtení`];
    if (photos > 0) {
      const photoWord = photos === 1 ? "fotka" : photos <= 4 ? "fotky" : "fotek";
      parts.push(`${photos} ${photoWord}`);
    }
    return parts.join(" · ");
  });

  eleventyConfig.addFilter("plainExcerpt", (htmlContent, maxLen = 400) => {
    const text = String(htmlContent || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > maxLen ? text.slice(0, maxLen) : text;
  });

  eleventyConfig.addFilter("absoluteUrls", (htmlContent, baseUrl) => {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    return String(htmlContent || "").replace(
      /(src|href)="(\/[^"]*)"/g,
      (_, attr, relPath) => `${attr}="${base}${relPath}"`
    );
  });

  eleventyConfig.addFilter("xmlEscape", escapeXml);

  eleventyConfig.addFilter("imageDimensions", src => getImageDimensions(src));

  eleventyConfig.addFilter("jsonify", value => JSON.stringify(value));

  eleventyConfig.addFilter("head", (array, n) => {
    if (!Array.isArray(array)) return [];
    return array.slice(0, n);
  });

  eleventyConfig.addFilter("cssmin", function (code) {
    return new CleanCSS({}).minify(code).styles;
  });

  // --- TRANSFORMS ---
  eleventyConfig.addTransform("htmlmin", async function (content, outputPath) {
    if (outputPath && outputPath.endsWith(".html")) {
      return htmlmin.minify(content, {
        useShortDoctype: true,
        removeComments: true,
        collapseWhitespace: true,
      });
    }
    return content;
  });

  // --- STATIC FILES ---
  eleventyConfig.addPassthroughCopy("favicon.ico");
  eleventyConfig.addPassthroughCopy("static");
  eleventyConfig.addPassthroughCopy("admin");
  eleventyConfig.addPassthroughCopy("images");

  // --- RETURN CONFIG ---
  return {
    templateFormats: ["md", "njk", "liquid"],
    pathPrefix: "/",
    markdownTemplateEngine: "liquid",
    htmlTemplateEngine: "njk",
    dataTemplateEngine: "njk",
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
  };
};
