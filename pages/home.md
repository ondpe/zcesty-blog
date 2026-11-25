---
layout: layouts/home.njk
title: Z cesty
date: 2016-01-01T00:00:00.000Z
eleventyExcludeFromCollections: true
pagination:
  data: collections.postsAll
  size: 12
  alias: pagedPosts
permalink: "{% if pagination.pageNumber > 0 %}strana/{{ pagination.pageNumber | plus: 1 }}/{% endif %}index.html"
---