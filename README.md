Sbírka travel blogů z cest.

## Psaní na cestách

Web je statický Eleventy blog. Články jsou Markdown soubory ve složce `posts`
a vlastní administrace běží na `/admin/`.

Admin čte a ukládá články přes Netlify Function `cms-api`. Při uložení vytvoří
commit do GitHubu, takže Netlify následně spustí běžný statický build.

### Environment variables

Lokálně je potřeba `.env`, který se necommituje. V Netlify nastav stejné
proměnné v Site configuration > Environment variables.

```text
ADMIN_PASSWORD=...
ADMIN_SESSION_SECRET=...
GITHUB_TOKEN=...
GITHUB_REPO=ondpe/zcesty-blog
GITHUB_BRANCH=master
```

`GITHUB_TOKEN` má být ideálně fine-grained token jen pro tohle repo s oprávněním
`Contents: Read and write`.

### Fotky v editoru

Při psaní článku v `/admin/` použij v poli Obsah tlačítko `Vybrat fotky`.

1. Vyber fotky z Apple Photos nebo ze souborů.
2. Editor je zmenší na delší stranu 1920 px a uloží jako JPG kvalita 85.
3. Fotky vloží do článku jako markdown obrázky, seřazené podle data pořízení.
4. Při uložení článku se fotky uloží do složky `images` ve stejném commitu.

Řazení podle data pořízení funguje u JPEGů přes EXIF. U ostatních formátů editor
použije datum souboru. Fotky se nikam neposílají, jen se lokálně zmenší v
prohlížeči a potom odešlou do admin API při uložení článku.

### Editor článku

CMS je záměrně nastavené jednoduše: nadpisy H1-H3, odstavce, odkazy, kurzíva
a obrázky. Složitější sazbu je lepší případně doladit až doma v Markdownu.
