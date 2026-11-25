Sbírka travel blogů z cest.

## Psaní na cestách

Web je statický Eleventy blog. Články jsou Markdown soubory ve složce `posts`
a vlastní administrace běží na `/admin/`.

Admin čte a ukládá články přes Netlify Function `cms-api`. Při uložení nahraje
jednotlivé fotky jako Git bloby a pak vytvoří jeden commit do GitHubu, takže
Netlify následně spustí běžný statický build.

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

### Fotky a koncepty v editoru

Při psaní článku v `/admin/` použij tlačítko `Vybrat fotky`:

1. Vyber fotky z Apple Photos nebo ze souborů.
2. Editor je postupně zmenší v prohlížeči na delší stranu 1920 px (JPG kvalita 85) a seřadí podle EXIF data pořízení.
3. V panelu `Fotky v článku` můžeš jedním klikem vybrat hero obrázek, dopsat popisek (`alt`) nebo fotku odebrat.
4. Při uložení se každá nová fotka nahraje samostatně (bez 6MB limitu) a uloží se do složky `images` ve stejném commitu jako článek.

Články lze ukládat jako **Koncept** (`draft: true` ve frontmatteru) — bezpečně se uloží do Gitu, ale na veřejném blogu se nezobrazí. Rozpracovaný text se zároveň průběžně zálohuje lokálně v prohlížeči (`localStorage`).

### Editor článku

CMS podporuje nadpisy `H2`/`H3`, tučné písmo, kurzívu, odkazy, seznamy, citace,
fotky a zkratku `Ctrl+S` / `Cmd+S` pro uložení.
