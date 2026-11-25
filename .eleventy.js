const { DateTime } = require("luxon");
const CleanCSS = require("clean-css");
const htmlmin = require("html-minifier-terser");
const markdownIt = require("markdown-it");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItForInline = require("markdown-it-for-inline");
const markdownItAnchor = require("markdown-it-anchor");

const SYSTEM_TAGS = new Set(["all", "post", "postsAll", "tagList", "tripList"]);

function escapeHtmlAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isGenericAlt(alt) {
  const normalized = String(alt || "").trim().toLowerCase();
  return !normalized || normalized === "obrázek" || normalized === "obrazek";
}

module.exports = function (eleventyConfig) {
  // --- MARKDOWN ---
  const md = markdownIt({ html: true, breaks: true, linkify: true })
    .use(markdownItAttrs)
    .use(markdownItAnchor, { permalink: false })
    .use(markdownItForInline, "image_linker", "image", (tokens, idx) => {
      const token = tokens[idx];
      const src = escapeHtmlAttr(token.attrGet("src") || "");
      const rawAlt = token.content || "";
      const alt = isGenericAlt(rawAlt) ? "" : escapeHtmlAttr(rawAlt.trim());
      const captionAttr = alt ? ` data-caption="${alt}"` : "";
      token.type = "html_inline";
      token.content = `<a href="${src}"${captionAttr}><img src="${src}" alt="${alt}" loading="lazy" decoding="async"></a>`;
    });

  eleventyConfig.setLibrary("md", md);

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
