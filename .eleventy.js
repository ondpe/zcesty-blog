const { DateTime } = require("luxon");
const CleanCSS = require("clean-css");
const UglifyJS = require("uglify-js");
const htmlmin = require("html-minifier");
const eleventyNavigationPlugin = require("@11ty/eleventy-navigation");
const markdownIt = require("markdown-it");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItForInline = require("markdown-it-for-inline");
const markdownItAnchor = require("markdown-it-anchor");

module.exports = function(eleventyConfig) {
  // --- PLUGINS ---
  eleventyConfig.addPlugin(eleventyNavigationPlugin);

  // --- MARKDOWN ---
  let md = markdownIt({ html: true, breaks: true, linkify: true })
    .use(markdownItAttrs)
    .use(markdownItAnchor, { permalink: false })
    .use(markdownItForInline, 'image_linker', 'image', (tokens, idx) => {
      const token = tokens[idx];
      const src = token.attrGet('src');
      const alt = token.content || '';
      token.type = 'html_inline';
      token.content = `<a href="${src}" class="gallery"><img src="${src}" alt="${alt}"></a>`;
    });

  eleventyConfig.setLibrary("md", md);

  // --- COLLECTIONS ---
  eleventyConfig.setDataDeepMerge(true);

  eleventyConfig.addCollection("authors", collection => {
    const blogs = collection.getFilteredByGlob("posts/*.md");
    return blogs.reduce((coll, post) => {
      const author = post.data.author;
      if (!author) return coll;
      if (!coll.hasOwnProperty(author)) coll[author] = [];
      coll[author].push(post.data);
      return coll;
    }, {});
  });

  eleventyConfig.addCollection("tagList", function (collectionApi) {
    const tagSet = new Set();
    collectionApi.getAll().forEach((item) => {
      if ("tags" in item.data) {
        let tags = Array.isArray(item.data.tags) ? item.data.tags : [item.data.tags];
        tags.forEach((tag) => tagSet.add(tag));
      }
    });
    return [...tagSet];
  });

eleventyConfig.addCollection("postsAll", function(collectionApi) {
  return collectionApi.getFilteredByGlob("./posts/*.md").sort((a, b) => b.date - a.date);
});

  // --- FILTERS ---
  eleventyConfig.addFilter("readableDate", dateObj => {
    return DateTime.fromJSDate(dateObj).toFormat("dd LLL yyyy");
  });

  eleventyConfig.addFilter("machineDate", dateObj => {
    return DateTime.fromJSDate(dateObj).toFormat("yyyy-MM-dd");
  });

  eleventyConfig.addFilter("czDate", dateObj => {
    return new Intl.DateTimeFormat('cs-CZ', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(dateObj);
  });

  eleventyConfig.addFilter("cssmin", function(code) {
    return new CleanCSS({}).minify(code).styles;
  });

  eleventyConfig.addFilter("jsmin", function(code) {
    let minified = UglifyJS.minify(code);
    if (minified.error) {
      console.log("UglifyJS error: ", minified.error);
      return code;
    }
    return minified.code;
  });

  // --- TRANSFORMS ---
  eleventyConfig.addTransform("htmlmin", function(content, outputPath) {
    if (outputPath.endsWith(".html")) {
      return htmlmin.minify(content, {
        useShortDoctype: true,
        removeComments: true,
        collapseWhitespace: true
      });
    }
    return content;
  });

  // --- STATIC FILES ---
  eleventyConfig.addPassthroughCopy("favicon.ico");
  eleventyConfig.addPassthroughCopy("static/img");
  eleventyConfig.addPassthroughCopy("admin/");
  eleventyConfig.addPassthroughCopy("_includes/assets/css/inline.css");
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
      output: "_site"
    }
  };
};
