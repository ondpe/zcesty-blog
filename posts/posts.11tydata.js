module.exports = {
  layout: "layouts/post.njk",
  tags: ["post"],
  eleventyComputed: {
    eleventyExcludeFromCollections(data) {
      return Boolean(data.draft);
    },
    permalink(data) {
      if (data.draft) {
        return false;
      }
      if (data.permalink) {
        return data.permalink;
      }
      const slug = this.slug(data.title || data.page.fileSlug);
      return `posts/${slug}/index.html`;
    },
  },
};
